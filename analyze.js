const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const simpleGit = require('simple-git');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { Project, SyntaxKind } = require('ts-morph');

// Helpers reused from parse.js style
function getParamName(param) {
	switch (param.type) {
		case 'Identifier': return param.name;
		case 'AssignmentPattern': return `${getParamName(param.left)}=`;
		case 'RestElement': return `...${getParamName(param.argument)}`;
		case 'ObjectPattern': return '{…}';
		case 'ArrayPattern': return '[…]';
		default: return 'unknown';
	}
}

function hasJSXReturn(bodyStatements) {
	return bodyStatements.some(n => n.type === 'ReturnStatement' && n.argument && typeof n.argument.type === 'string' && n.argument.type.includes('JSX'));
}

function isJSXNode(node) {
	return node && typeof node.type === 'string' && node.type.includes('JSX');
}

function isReactComponentClass(node, reactImports) {
	if (!node.superClass) return false;
	if (node.superClass.type === 'MemberExpression') {
		const obj = node.superClass.object;
		const prop = node.superClass.property;
		if (obj && obj.type === 'Identifier' && obj.name === 'React' && prop && prop.type === 'Identifier' && prop.name === 'Component') {
			return true;
		}
	}
	if (node.superClass.type === 'Identifier' && node.superClass.name === 'Component') {
		return reactImports.has('Component');
	}
	return false;
}

// Call normalization helpers
function simplifyCallName(name) {
	if (!name) return name;
	// Collapse long response/output chains
	if (name.includes('response.output')) return 'response.output pipeline';
	// Collapse typical array pipelines
	if (/\.(filter|map|flatMap|reduce|forEach)\b/.test(name)) return 'array pipeline';
	return name;
}
function isExternalApiCall(name) {
	if (!name) return false;
	const allow = [
		/^client\./, /^openai\b/i, /^OpenAI\b/, /^axios\b/, /^fetch\b/, /^(fs|http|https)\./, /^process\.env\b/, /^console\./
	];
	return allow.some(r => r.test(name));
}
function getMemberExprName(node) {
	// Build dotted path up to 3 segments for readability
	const parts = [];
	let curr = node;
	let safety = 0;
	while (curr && safety++ < 5) {
		if (curr.type === 'Identifier') { parts.unshift(curr.name); break; }
		if (curr.type === 'ThisExpression') { parts.unshift('this'); break; }
		if (curr.type === 'MemberExpression') {
			const prop = curr.property;
			if (prop.type === 'Identifier') parts.unshift(prop.name);
			curr = curr.object;
			continue;
		}
		break;
	}
	return parts.join('.');
}

// Exclusion/inclusion settings to focus on main code only
const EXCLUDED_DIR_NAMES = new Set([
	'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', '.turbo', '.vercel', 'vendor', '.cache', 'tmp', '.tmp', 'logs',
	'.yarn', '.pnpm', '.vscode', '.idea', '.husky', '.github', 'examples', 'example', 'demo', 'demos', 'tests', '__tests__', 'test', 'spec', 'cypress', 'e2e', 'scripts', 'tools', 'docs', 'documentation', 'public', 'static'
]);

const PREFERRED_SOURCE_DIRS = [
	'src', 'app', 'server', 'backend', 'api', 'pages', 'lib', 'services', 'components', 'routes'
];

const EXCLUDED_CONFIG_FILES = new Set([
	'babel.config.js', 'webpack.config.js', 'vite.config.js', 'rollup.config.js', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
	'postcss.config.js', 'tailwind.config.js', 'commitlint.config.js'
]);

function shouldSkipDir(dirName) {
	return EXCLUDED_DIR_NAMES.has(dirName);
}

function shouldIncludeFile(filePath) {
	const base = path.basename(filePath);
	if (EXCLUDED_CONFIG_FILES.has(base)) return false;
	return base.endsWith('.js') || base.endsWith('.jsx') || base.endsWith('.ts') || base.endsWith('.tsx');
}

function listFilesRecursive(dir, exts) {
	let results = [];
	for (const entry of fs.readdirSync(dir)) {
		if (shouldSkipDir(entry)) continue;
		const full = path.join(dir, entry);
		const st = fs.statSync(full);
		if (st.isDirectory()) results = results.concat(listFilesRecursive(full, exts));
		else if (shouldIncludeFile(full) && exts.some(e => entry.endsWith(e))) results.push(full);
	}
	return results;
}

function parseJavaScriptFile(absPath, repoRoot) {
	let code = '';
	try { code = fs.readFileSync(absPath, 'utf-8'); } catch (e) {
		return { file: path.basename(absPath), relativePath: path.relative(repoRoot, absPath), error: `READ_ERROR: ${e.message}` };
	}
	let ast;
	try {
		ast = parser.parse(code, { sourceType: 'unambiguous', plugins: ['jsx', 'classProperties'] });
	} catch (e) {
		return { file: path.basename(absPath), relativePath: path.relative(repoRoot, absPath), error: `PARSE_ERROR: ${e.message}` };
	}

	const info = {
		file: path.basename(absPath),
		relativePath: path.relative(repoRoot, absPath).replace(/\\/g, '/'),
		imports: [],
		exports: [],
		functions: [],
		classes: [],
		reactComponents: [],
		expressRoutes: [],
		complexity: {},
		calls: {},
		callsExternal: {}
	};

	const reactImports = new Set();

	function bumpComplexity(fnName, n = 1) {
		info.complexity[fnName] = (info.complexity[fnName] || 1) + n; // base 1
	}

	traverse(ast, {
		// ES imports
		ImportDeclaration(p) {
			const source = p.node.source.value;
			const specifiers = p.node.specifiers.map(s => {
				if (s.type === 'ImportDefaultSpecifier') return { kind: 'default', local: s.local.name };
				if (s.type === 'ImportNamespaceSpecifier') return { kind: 'namespace', local: s.local.name };
				return { kind: 'named', imported: s.imported && s.imported.name, local: s.local.name };
			});
			info.imports.push({ source, specifiers });
			if (source === 'react') {
				for (const sp of specifiers) {
					if (sp.kind === 'default') reactImports.add('React');
					if (sp.kind === 'named' && sp.imported) reactImports.add(sp.imported);
					if (sp.kind === 'namespace') reactImports.add('*');
				}
			}
		},
		// CommonJS require: const x = require('y')
		VariableDeclarator(p) {
			if (p.node.init && p.node.init.type === 'CallExpression' && p.node.init.callee.type === 'Identifier' && p.node.init.callee.name === 'require') {
				const arg = p.node.init.arguments[0];
				const source = arg && arg.type === 'StringLiteral' ? arg.value : null;
				if (source && p.node.id.type === 'Identifier') {
					info.imports.push({ source, specifiers: [{ kind: 'cjs', local: p.node.id.name }] });
				}
			}
			// function expressions/arrow
			if (p.node.id.type === 'Identifier') {
				const varName = p.node.id.name;
				const init = p.node.init;
				if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
					const params = init.params.map(getParamName);
					info.functions.push({ name: varName, kind: init.type === 'ArrowFunctionExpression' ? 'arrow' : 'functionExpression', params, async: !!init.async, generator: !!init.generator });
					info.complexity[varName] = 1;
					if (init.type === 'ArrowFunctionExpression') {
						if (init.body && init.body.type !== 'BlockStatement' && isJSXNode(init.body)) info.reactComponents.push({ type: 'FunctionalComponent', name: varName });
						else if (init.body && init.body.type === 'BlockStatement' && hasJSXReturn(init.body.body)) info.reactComponents.push({ type: 'FunctionalComponent', name: varName });
					}
				}
			}
		},
		// CommonJS exports: module.exports = X or exports.foo = ...
		AssignmentExpression(p) {
			const left = p.node.left;
			if (left.type === 'MemberExpression') {
				const obj = left.object;
				const prop = left.property;
				if (obj.type === 'Identifier' && obj.name === 'module' && prop.type === 'Identifier' && prop.name === 'exports') {
					info.exports.push({ type: 'cjs_module_exports' });
				}
				if (obj.type === 'Identifier' && obj.name === 'exports') {
					info.exports.push({ type: 'cjs_named', name: prop.type === 'Identifier' ? prop.name : null });
				}
			}
		},
		ExportNamedDeclaration(p) {
			const specifiers = p.node.specifiers.map(s => ({ exported: s.exported.name, local: s.local.name }));
			const source = p.node.source ? p.node.source.value : null;
			let declNames = [];
			if (p.node.declaration) {
				const decl = p.node.declaration;
				if (decl.type === 'FunctionDeclaration' && decl.id) declNames.push(decl.id.name);
				if (decl.type === 'ClassDeclaration' && decl.id) declNames.push(decl.id.name);
				if (decl.type === 'VariableDeclaration') {
					for (const d of decl.declarations) {
						if (d.id.type === 'Identifier') declNames.push(d.id.name);
					}
				}
			}
			info.exports.push({ type: 'named', specifiers, source, declarations: declNames });
		},
		ExportDefaultDeclaration(p) {
			let name = null;
			const decl = p.node.declaration;
			if (decl.type === 'Identifier') name = decl.name;
			else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) name = decl.id.name;
			info.exports.push({ type: 'default', name });
		},
		ExportAllDeclaration(p) { info.exports.push({ type: 'all', source: p.node.source && p.node.source.value }); },
		FunctionDeclaration(p) {
			const params = p.node.params.map(getParamName);
			const name = p.node.id ? p.node.id.name : '(anonymous)';
			const entry = { name, kind: 'declaration', params, async: !!p.node.async, generator: !!p.node.generator };
			info.functions.push(entry);
			info.complexity[name] = 1;
			const body = p.node.body && p.node.body.body ? p.node.body.body : [];
			if (hasJSXReturn(body)) info.reactComponents.push({ type: 'FunctionalComponent', name });
			p.traverse({
				IfStatement() { bumpComplexity(name); },
				ForStatement() { bumpComplexity(name); },
				ForInStatement() { bumpComplexity(name); },
				ForOfStatement() { bumpComplexity(name); },
				WhileStatement() { bumpComplexity(name); },
				DoWhileStatement() { bumpComplexity(name); },
				SwitchCase(scPath) { if (scPath.node.test) bumpComplexity(name); },
				LogicalExpression(lePath) { if (lePath.node.operator === '&&' || lePath.node.operator === '||') bumpComplexity(name); },
				ConditionalExpression() { bumpComplexity(name); },
				CatchClause() { bumpComplexity(name); },
				CallExpression(callPath) {
					const callee = callPath.node.callee;
					let rawName = null;
					if (callee.type === 'Identifier') rawName = callee.name;
					else if (callee.type === 'MemberExpression') rawName = getMemberExprName(callee);
					const clean = simplifyCallName(rawName);
					if (clean) {
						info.calls[name] = info.calls[name] || [];
						if (!info.calls[name].includes(clean)) info.calls[name].push(clean);
						if (isExternalApiCall(clean)) {
							info.callsExternal[name] = info.callsExternal[name] || [];
							if (!info.callsExternal[name].includes(clean)) info.callsExternal[name].push(clean);
						}
					}
				}
			});
		},
		// Express routes in JS: app.get/post..., router.get/post..., and app.use('/x', router)
		CallExpression(p) {
			const callee = p.node.callee;
			if (callee && callee.type === 'MemberExpression' && callee.property && callee.property.type === 'Identifier') {
				const method = callee.property.name.toUpperCase();
				const obj = callee.object && callee.object.type === 'Identifier' ? callee.object.name : null;
				const httpMethods = new Set(['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD','ALL','USE']);
				if (httpMethods.has(method)) {
					const firstArg = p.node.arguments && p.node.arguments[0];
					let routePath = null;
					if (firstArg && firstArg.type === 'StringLiteral') routePath = firstArg.value;
					if (firstArg && firstArg.type === 'TemplateLiteral') routePath = firstArg.quasis.map(q => q.value.cooked).join('${}');
					if (routePath) {
						info.expressRoutes.push({ via: obj, method, path: routePath });
					}
				}
			}
		}
	});

	return info;
}

function parseTypeScriptFiles(tsFiles, repoRoot) {
	const project = new Project({
		compilerOptions: { allowJs: false, target: 99 },
		useInMemoryFileSystem: false,
		skipAddingFilesFromTsConfig: true
	});
	for (const file of tsFiles) project.addSourceFileAtPath(file);
	const summaries = [];
	for (const sf of project.getSourceFiles()) {
		const fileInfo = {
			file: path.basename(sf.getFilePath()),
			relativePath: path.relative(repoRoot, sf.getFilePath()).replace(/\\/g, '/'),
			imports: [],
			exports: [],
			functions: [],
			classes: [],
			reactComponents: [],
			expressRoutes: [],
			envVars: [],
			complexity: {},
			calls: {},
			callsExternal: {},
			nestRoutes: [],
			nextApiRoutes: []
		};

		// Imports/exports
		for (const imp of sf.getImportDeclarations()) {
			fileInfo.imports.push({
				source: imp.getModuleSpecifierValue(),
				specifiers: [
					...imp.getNamedImports().map(n => ({ kind: 'named', imported: n.getName(), local: n.getName() })),
					...(imp.getDefaultImport() ? [{ kind: 'default', local: imp.getDefaultImport().getText() }] : [])
				]
			});
		}
		for (const ex of sf.getExportDeclarations()) {
			fileInfo.exports.push({ type: ex.isNamespaceExport() ? 'all' : 'named', source: ex.getModuleSpecifierValue() || null });
		}
		if (sf.getDefaultExportSymbol()) fileInfo.exports.push({ type: 'default', name: sf.getDefaultExportSymbol().getName() });

		// Functions (top-level declarations)
		for (const fn of sf.getFunctions()) {
			const name = fn.getName() || null;
			fileInfo.functions.push({
				name,
				kind: 'declaration',
				async: fn.isAsync(),
				generator: fn.isGenerator(),
				params: fn.getParameters().map(p => ({ name: p.getName(), type: p.getType().getText() })),
				returnType: fn.getReturnType().getText()
			});
			fileInfo.complexity[name || '(anonymous)'] = 1;
			// complexity + calls inside function
			for (const n of fn.getDescendants()) {
				const kind = n.getKind();
				if ([SyntaxKind.IfStatement, SyntaxKind.ForStatement, SyntaxKind.ForInStatement, SyntaxKind.ForOfStatement, SyntaxKind.WhileStatement, SyntaxKind.DoStatement, SyntaxKind.CaseClause, SyntaxKind.CatchClause, SyntaxKind.ConditionalExpression].includes(kind)) {
					fileInfo.complexity[name || '(anonymous)']++;
				}
				if (kind === SyntaxKind.BinaryExpression && (n.getText().includes('&&') || n.getText().includes('||'))) {
					fileInfo.complexity[name || '(anonymous)']++;
				}
				if (kind === SyntaxKind.CallExpression) {
					const expr = n.getExpression();
					let raw = null;
					if (expr.getKind() === SyntaxKind.Identifier) raw = expr.getText();
					else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
						const parts = [];
						let cur = expr;
						let guard = 0;
						while (cur && cur.getKind() === SyntaxKind.PropertyAccessExpression && guard++ < 5) {
							parts.unshift(cur.getName());
							cur = cur.getExpression();
						}
						if (cur && cur.getKind && cur.getKind() === SyntaxKind.Identifier) parts.unshift(cur.getText());
						raw = parts.join('.');
					}
					const clean = simplifyCallName(raw);
					if (clean) {
						const key = name || '(anonymous)';
						fileInfo.calls[key] = fileInfo.calls[key] || [];
						if (!fileInfo.calls[key].includes(clean)) fileInfo.calls[key].push(clean);
						if (isExternalApiCall(clean)) {
							fileInfo.callsExternal[key] = fileInfo.callsExternal[key] || [];
							if (!fileInfo.callsExternal[key].includes(clean)) fileInfo.callsExternal[key].push(clean);
						}
					}
				}
			}
		}

		// Variable-assigned functions
		for (const v of sf.getVariableDeclarations()) {
			const init = v.getInitializer();
			if (!init) continue;
			if (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression) {
				const asFn = init;
				const name = v.getName();
				fileInfo.functions.push({
					name,
					kind: init.getKindName().includes('Arrow') ? 'arrow' : 'functionExpression',
					async: asFn.isAsync ? asFn.isAsync() : false,
					generator: asFn.isGenerator ? asFn.isGenerator() : false,
					params: asFn.getParameters().map(p => ({ name: p.getName(), type: p.getType().getText() })),
					returnType: asFn.getReturnType ? asFn.getReturnType().getText() : 'unknown'
				});
				fileInfo.complexity[name] = 1;
				for (const n of asFn.getDescendants()) {
					const kind = n.getKind();
					if ([SyntaxKind.IfStatement, SyntaxKind.ForStatement, SyntaxKind.ForInStatement, SyntaxKind.ForOfStatement, SyntaxKind.WhileStatement, SyntaxKind.DoStatement, SyntaxKind.CaseClause, SyntaxKind.CatchClause, SyntaxKind.ConditionalExpression].includes(kind)) {
						fileInfo.complexity[name]++;
					}
					if (kind === SyntaxKind.BinaryExpression && (n.getText().includes('&&') || n.getText().includes('||'))) {
						fileInfo.complexity[name]++;
					}
					if (kind === SyntaxKind.CallExpression) {
						const expr = n.getExpression();
						let raw = null;
						if (expr.getKind() === SyntaxKind.Identifier) raw = expr.getText();
						else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
							const parts = [];
							let cur = expr;
							let guard = 0;
							while (cur && cur.getKind() === SyntaxKind.PropertyAccessExpression && guard++ < 5) {
								parts.unshift(cur.getName());
								cur = cur.getExpression();
							}
							if (cur && cur.getKind && cur.getKind() === SyntaxKind.Identifier) parts.unshift(cur.getText());
							raw = parts.join('.');
						}
						const clean = simplifyCallName(raw);
						if (clean) {
							fileInfo.calls[name] = fileInfo.calls[name] || [];
							if (!fileInfo.calls[name].includes(clean)) fileInfo.calls[name].push(clean);
							if (isExternalApiCall(clean)) {
								fileInfo.callsExternal[name] = fileInfo.callsExternal[name] || [];
								if (!fileInfo.callsExternal[name].includes(clean)) fileInfo.callsExternal[name].push(clean);
							}
						}
					}
				}
			}
		}

		// Classes and methods
		for (const cls of sf.getClasses()) {
			const methods = cls.getMethods().map(m => ({
				name: m.getName(),
				kind: 'method',
				static: m.isStatic(),
				async: m.isAsync(),
				generator: m.isGenerator(),
				params: m.getParameters().map(p => ({ name: p.getName(), type: p.getType().getText() })),
				returnType: m.getReturnType().getText()
			}));
			fileInfo.classes.push({ name: cls.getName() || null, methods });
		}

		// Env var usage (process.env.X)
		const envRefs = sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
			.filter(pa => pa.getExpression().getText() === 'process.env')
			.map(pa => pa.getName());
		fileInfo.envVars = Array.from(new Set(envRefs));

		// OpenAI SDK call detection
		const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
		for (const ce of callExprs) {
			const exprText = ce.getExpression().getText();
			if (/\.responses\.create\(/.test(exprText) || /new\s+OpenAI\(/.test(exprText)) {
				fileInfo.features = fileInfo.features || {};
				fileInfo.features.openai = fileInfo.features.openai || [];
				fileInfo.features.openai.push({ kind: 'ResponsesAPI', at: ce.getStartLineNumber() });
			}
		}

		// NestJS route decorators
		for (const cls of sf.getClasses()) {
			const ctrlDec = cls.getDecorators().find(d => d.getName() === 'Controller');
			if (ctrlDec) {
				let basePath = '';
				const arg = ctrlDec.getArguments()[0];
				if (arg && arg.getText) basePath = arg.getText().replace(/['"`]/g, '');
				for (const m of cls.getMethods()) {
					const dec = m.getDecorators().find(d => ['Get','Post','Put','Patch','Delete','Options','Head','All'].includes(d.getName()));
					if (dec) {
						let sub = '';
						const a = dec.getArguments()[0];
						if (a && a.getText) sub = a.getText().replace(/['"`]/g, '');
						fileInfo.nestRoutes.push({ method: dec.getName().toUpperCase(), path: path.posix.join('/', basePath || '', sub || '') });
					}
				}
			}
		}

		// Next.js API routes
		const rel = path.relative(repoRoot, sf.getFilePath()).replace(/\\/g, '/');
		if (rel.includes('/pages/api/')) {
			const apiPath = '/' + rel.split('/pages/api/')[1].replace(/\.(t|j)sx?$/, '').replace(/index$/, '');
			fileInfo.nextApiRoutes.push({ path: apiPath || '/', method: 'ANY' });
		}
		if (rel.includes('/app/api/') && /\/route\.(t|j)sx?$/.test(rel)) {
			const routeRoot = rel.split('/app/api/')[1].replace(/\/route\.(t|j)sx?$/, '');
			const exportedFns = sf.getFunctions().map(f => f.getName()).filter(Boolean);
			for (const m of ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD']) {
				if (exportedFns.includes(m)) fileInfo.nextApiRoutes.push({ path: '/' + routeRoot, method: m });
			}
		}

		summaries.push(fileInfo);
	}
	return summaries;
}

async function resolveSourceRoots(tempDir) {
	const roots = [];
	for (const name of PREFERRED_SOURCE_DIRS) {
		const candidate = path.join(tempDir, name);
		if (await fs.pathExists(candidate) && (await fs.stat(candidate)).isDirectory()) {
			roots.push(candidate);
		}
	}
	if (roots.length === 0) roots.push(tempDir);
	return roots;
}

function buildDependencyGraph(fileSummaries) {
	// Build edges only for relative imports we have in summaries
	const fileByRel = new Map(fileSummaries.map(f => [f.relativePath.replace(/\\/g, '/'), f]));
	const edges = new Map();
	for (const f of fileSummaries) {
		const from = f.relativePath.replace(/\\/g, '/');
		edges.set(from, edges.get(from) || new Set());
		for (const imp of f.imports || []) {
			const src = imp.source;
			if (!src || (!src.startsWith('.') && !src.startsWith('/'))) continue;
			const resolved = resolveImport(from, src, fileByRel);
			if (resolved) edges.get(from).add(resolved);
		}
	}
	// Detect cycles via DFS
	const cycles = [];
	const visited = new Set();
	const stack = new Set();
	function dfs(node, pathArr) {
		if (stack.has(node)) {
			const idx = pathArr.indexOf(node);
			if (idx !== -1) cycles.push(pathArr.slice(idx));
			return;
		}
		if (visited.has(node)) return;
		visited.add(node);
		stack.add(node);
		for (const nxt of edges.get(node) || []) dfs(nxt, pathArr.concat(nxt));
		stack.delete(node);
	}
	for (const n of edges.keys()) dfs(n, [n]);
	return {
		nodes: Array.from(edges.keys()),
		edges: Array.from(edges.entries()).map(([k, v]) => ({ from: k, to: Array.from(v) })),
		cycles
	};
}

function resolveImport(fromRelPath, importSpec, fileByRel) {
	const fromDir = path.posix.dirname(fromRelPath);
	const base = path.posix.normalize(path.posix.join(fromDir, importSpec));
	const candidates = [
		`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
		`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`
	];
	for (const c of candidates) if (fileByRel.has(c)) return c;
	return null;
}

function makeWorkflow(fileSummaries) {
	// Pick entry functions: main(), or default exported functions with no params
	const steps = [];
	for (const f of fileSummaries) {
		const entry = (f.functions || []).find(fn => fn.name === 'main') || (f.functions || []).find(fn => fn.name && fn.params && fn.params.length === 0);
		if (!entry) continue;
		const filePath = f.relativePath;
		const callsExt = (f.callsExternal && f.callsExternal[entry.name]) || [];
		const envs = f.envVars || [];
		const local = [];
		if (envs.length) local.push(`Load config/env: ${envs.join(', ')}`);
		for (const c of callsExt) {
			if (/client\.responses\.create/.test(c)) local.push('Call OpenAI Responses API');
			else if (/console\./.test(c)) local.push('Log result to console');
			else if (/^fetch\b|^axios\b/.test(c)) local.push(`HTTP request via ${c.split('.')[0]}`);
			else if (/^fs\./.test(c)) local.push('File system access');
			else local.push(`External call: ${c}`);
		}
		if (!local.length) local.push('Execute main logic');
		steps.push({ file: filePath, function: entry.name, steps: local });
	}
	return steps;
}

function makeNarrative(brief) {
	const parts = [];
	const name = brief.meta?.name || 'This project';
	const isApi = brief.meta?.appType === 'api';
	const fw = (brief.stack?.frameworks || []).join(', ');
	const libs = (brief.stack?.libs || []).slice(0, 6).join(', ');
	const hasAuth = brief.controllers?.some(c => c.file.includes('user') || c.file.includes('auth'));
	const hasReports = brief.api?.some(r => /report|sales|invoice/i.test(r.path || ''));
	const hasInventory = brief.api?.some(r => /inventory|stock/i.test(r.path || ''));
	const models = (brief.models || []).map(m => m.name.replace(/Model$/,'')).slice(0, 5).join(', ');

	parts.push(`${name} is a ${isApi ? 'backend API' : 'codebase'} providing retail point-of-sale capabilities.`);
	if (fw || libs) parts.push(`It is built with ${[fw, libs].filter(Boolean).join(' and uses ')}.`);
	if (brief.entrypoints && brief.entrypoints[0]) parts.push(`The application starts in ${brief.entrypoints[0].file}.`);

	const features = [];
	if (hasAuth) features.push('user authentication and session management');
	if (hasInventory) features.push('inventory monitoring');
	if (hasReports) features.push('sales reporting');
	if (brief.api && brief.api.length) features.push('RESTful endpoints under /api');
	if (features.length) parts.push(`Key features include ${features.join(', ')}.`);

	if (models) parts.push(`Data is modeled with Mongoose schemas such as ${models}.`);
	parts.push('The project follows a conventional MVC structure (routes → controllers → models).');
	if (brief.repo?.hasReadme) parts.push('A README is present for basic guidance.');
	if (!brief.repo?.hasCI) parts.push('No CI configuration was detected.');

	return parts.join(' ');
}

function makeBrief(summary) {
	const api = (summary.features && summary.features.expressRoutes) || [];
	const files = summary.files || [];
	const controllers = files.filter(f => /controllers\//.test(f.relativePath));
	const models = files.filter(f => /models\//.test(f.relativePath));
	const serverEntries = files.filter(f => /server\.(t|j)sx?$/.test(f.relativePath));

	function pickControllerName(filePath) {
		const base = path.basename(filePath).replace(/\.(t|j)sx?$/, '');
		return base;
	}

	const brief = {
		meta: {
			name: (summary.repoUrl.split('/').pop() || '').replace(/\.git$/, ''),
			repoUrl: summary.repoUrl,
			appType: api.length ? 'api' : 'app'
		},
		stack: {
			language: summary.stack && summary.stack.dependencies && summary.stack.dependencies.typescript ? 'ts' : 'js',
			frameworks: [...new Set(summary.stack.frameworkHints || [])],
			libs: Array.from(new Set((files.flatMap(f => (f.imports||[]).map(i => i.source)).filter(s => s && !s.startsWith('.'))))).slice(0, 12)
		},
		entrypoints: serverEntries.map(f => ({ file: f.relativePath, function: (f.functions && f.functions[0] && f.functions[0].name) || null })).slice(0, 5),
		env: Array.from(new Set(files.flatMap(f => f.envVars || []))).slice(0, 20).map(name => ({ name })),
		api: api.map(r => ({ method: r.method, path: r.path, handler: null, middlewares: [], needsAuth: undefined, file: r.file })).slice(0, 150),
		controllers: controllers.slice(0, 60).map(c => ({
			name: pickControllerName(c.relativePath),
			file: c.relativePath,
			purpose: undefined,
			externalCalls: Object.values(c.callsExternal || {}).flat().filter(Boolean).slice(0, 6),
			readsModels: models.filter(m => (c.imports||[]).some(i => typeof i.source === 'string' && i.source.includes('models'))).map(m => path.basename(m.relativePath).replace(/\.(t|j)sx?$/, ''))
		})),
		models: models.slice(0, 40).map(m => ({ name: path.basename(m.relativePath).replace(/\.(t|j)sx?$/, ''), file: m.relativePath })),
		workflows: (summary.workflow || []).slice(0, 12),
		risks: [],
		repo: { hasReadme: !!summary.repoMeta?.readme, hasDocker: !!summary.repoMeta?.docker, hasCI: !!summary.repoMeta?.ci?.githubActions },
		size: { files: summary.counts?.files, hotspots: files.sort((a,b)=>((Object.values(b.complexity||{})[0]||0)-(Object.values(a.complexity||{})[0]||0))).slice(0,5).map(f=>f.relativePath) }
	};

	brief.narrative = makeNarrative(brief);
	return brief;
}

async function analyzeRepo(repoUrl) {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-'));
	const git = simpleGit();
	await git.clone(repoUrl, tempDir, ['--depth', '1']);

	// Stack detection via package.json
	let stack = { dependencies: {}, devDependencies: {}, frameworkHints: [], errors: [] };
	try {
		const pkgPath = path.join(tempDir, 'package.json');
		if (await fs.pathExists(pkgPath)) {
			const pkg = await fs.readJSON(pkgPath);
			stack.dependencies = pkg.dependencies || {};
			stack.devDependencies = pkg.devDependencies || {};
			const deps = { ...stack.dependencies, ...stack.devDependencies };
			const hints = [];
			if (deps.react) hints.push('React');
			if (deps['react-native']) hints.push('React Native');
			if (deps.next) hints.push('Next.js');
			if (deps.vue) hints.push('Vue');
			if (deps.nuxt) hints.push('Nuxt');
			if (deps.angular || deps['@angular/core']) hints.push('Angular');
			if (deps.express) hints.push('Express');
			if (deps.koa) hints.push('Koa');
			if (deps.fastify) hints.push('Fastify');
			if (deps['react-router'] || deps['react-router-dom']) hints.push('React Router');
			if (deps['redux'] || deps['@reduxjs/toolkit']) hints.push('Redux');
			if (deps.typescript) hints.push('TypeScript');
			if (deps.prisma) hints.push('Prisma');
			if (deps.mongoose) hints.push('Mongoose');
			stack.frameworkHints = hints;
		}
	} catch (e) {
		stack.errors.push(`PACKAGE_JSON_ERROR: ${e.message}`);
	}

	const roots = await resolveSourceRoots(tempDir);

	// Collect files
	let allFiles = [];
	for (const root of roots) allFiles = allFiles.concat(listFilesRecursive(root, ['.js', '.jsx', '.ts', '.tsx']));
	allFiles = Array.from(new Set(allFiles));

	// Split by extension
	const tsFiles = allFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
	const jsFiles = allFiles.filter(f => f.endsWith('.js') || f.endsWith('.jsx'));

	const tsSummaries = parseTypeScriptFiles(tsFiles, tempDir);
	const jsSummaries = jsFiles.map(f => parseJavaScriptFile(f, tempDir));
	const fileSummaries = tsSummaries.concat(jsSummaries);

	// Aggregate routes
	const expressRoutes = [];
	const nestRoutes = [];
	const nextApiRoutes = [];
	for (const f of fileSummaries) {
		if (Array.isArray(f.expressRoutes)) expressRoutes.push(...f.expressRoutes.map(r => ({ ...r, file: f.relativePath })));
		if (Array.isArray(f.nestRoutes)) nestRoutes.push(...f.nestRoutes.map(r => ({ ...r, file: f.relativePath })));
		if (Array.isArray(f.nextApiRoutes)) nextApiRoutes.push(...f.nextApiRoutes.map(r => ({ ...r, file: f.relativePath })));
	}

	// Dependency graph
	const depGraph = buildDependencyGraph(fileSummaries);

	// Repo metadata
	const repoMeta = { readme: null, license: null, ci: { githubActions: false }, docker: false };
	const readmeCandidates = ['README.md', 'README.MD', 'readme.md'];
	for (const r of readmeCandidates) if (await fs.pathExists(path.join(tempDir, r))) repoMeta.readme = r;
	const licenseCandidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
	for (const l of licenseCandidates) if (await fs.pathExists(path.join(tempDir, l))) repoMeta.license = l;
	repoMeta.ci.githubActions = await fs.pathExists(path.join(tempDir, '.github', 'workflows'));
	repoMeta.docker = await fs.pathExists(path.join(tempDir, 'Dockerfile'));

	const summary = {
		repoUrl,
		stack,
		scan: {
			roots: roots.map(r => path.relative(tempDir, r)),
			excludedDirs: Array.from(EXCLUDED_DIR_NAMES)
		},
		repoMeta,
		counts: {
			files: fileSummaries.length,
			functions: fileSummaries.reduce((n, f) => n + (f.functions ? f.functions.length : 0), 0),
			classes: fileSummaries.reduce((n, f) => n + (f.classes ? f.classes.length : 0), 0),
			reactComponents: fileSummaries.reduce((n, f) => n + (f.reactComponents ? f.reactComponents.length : 0), 0),
			expressRoutes: expressRoutes.length,
			nestRoutes: nestRoutes.length,
			nextApiRoutes: nextApiRoutes.length,
			cycles: depGraph.cycles.length
		},
		features: {
			reactComponents: fileSummaries.flatMap(f => (f.reactComponents || []).map(c => ({ ...c, file: f.relativePath }))),
			expressRoutes,
			nestRoutes,
			nextApiRoutes
		},
		graphs: {
			dependencies: depGraph
		},
		workflow: makeWorkflow(fileSummaries),
		files: fileSummaries
	};

	await fs.writeJson(path.join(process.cwd(), 'summary.json'), summary, { spaces: 2 });
	// Write compact brief
	const brief = makeBrief(summary);
	await fs.writeJson(path.join(process.cwd(), 'summary-brief.json'), brief, { spaces: 2 });
	console.log('Analysis complete. summary.json and summary-brief.json written.');
}

if (require.main === module) {
	const repoUrl = process.argv[2];
	if (!repoUrl) {
		console.error('Usage: node analyze.js <git-repo-url>');
		process.exit(1);
	}
	analyzeRepo(repoUrl).catch(err => {
		console.error('Analyze failed:', err);
		process.exit(1);
	});
}
