const fs = require('fs-extra');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// Folder to analyze
const REPO_DIR = path.join(__dirname, 'repo');

// Helper: get all JS/JSX files recursively
function getJSFiles(dir) {
  let results = [];
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getJSFiles(fullPath));
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Helpers
function getParamName(param) {
  // Produce a readable string for different param patterns
  switch (param.type) {
    case 'Identifier':
      return param.name;
    case 'AssignmentPattern':
      return `${getParamName(param.left)}=`; // indicate default exists
    case 'RestElement':
      return `...${getParamName(param.argument)}`;
    case 'ObjectPattern':
      return '{…}';
    case 'ArrayPattern':
      return '[…]';
    default:
      return 'unknown';
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
  // extends React.Component
  if (node.superClass.type === 'MemberExpression') {
    const obj = node.superClass.object;
    const prop = node.superClass.property;
    if (obj && obj.type === 'Identifier' && obj.name === 'React' && prop && prop.type === 'Identifier' && prop.name === 'Component') {
      return true;
    }
  }
  // extends Component (imported from react)
  if (node.superClass.type === 'Identifier' && node.superClass.name === 'Component') {
    return reactImports.has('Component');
  }
  return false;
}

// Parse each file and extract info
function parseFile(filePath) {
  let code = '';
  try {
    code = fs.readFileSync(filePath, 'utf-8');
  } catch (readErr) {
    return {
      file: path.basename(filePath),
      relativePath: path.relative(REPO_DIR, filePath),
      functions: [],
      classes: [],
      reactComponents: [],
      imports: [],
      exports: [],
      error: `READ_ERROR: ${readErr.message}`
    };
  }

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'classProperties']
    });
  } catch (parseErr) {
    return {
      file: path.basename(filePath),
      relativePath: path.relative(REPO_DIR, filePath),
      functions: [],
      classes: [],
      reactComponents: [],
      imports: [],
      exports: [],
      error: `PARSE_ERROR: ${parseErr.message}`
    };
  }

  const fileInfo = {
    file: path.basename(filePath),
    relativePath: path.relative(REPO_DIR, filePath),
    functions: [],
    classes: [],
    reactComponents: [],
    imports: [],
    exports: []
  };

  const reactImports = new Set(); // track named imports from 'react'

  traverse(ast, {
    // Imports
    ImportDeclaration(path) {
      const source = path.node.source.value;
      const specifiers = path.node.specifiers.map(s => {
        if (s.type === 'ImportDefaultSpecifier') {
          return { kind: 'default', local: s.local.name };
        }
        if (s.type === 'ImportNamespaceSpecifier') {
          return { kind: 'namespace', local: s.local.name };
        }
        return { kind: 'named', imported: s.imported && s.imported.name, local: s.local.name };
      });
      fileInfo.imports.push({ source, specifiers, loc: path.node.loc });

      if (source === 'react') {
        for (const sp of specifiers) {
          if (sp.kind === 'default') reactImports.add('React');
          if (sp.kind === 'named' && sp.imported) reactImports.add(sp.imported);
          if (sp.kind === 'namespace') reactImports.add('*');
        }
      }
    },

    // Exports
    ExportNamedDeclaration(path) {
      const specifiers = path.node.specifiers.map(s => ({ exported: s.exported.name, local: s.local.name }));
      const source = path.node.source ? path.node.source.value : null;
      let declNames = [];
      if (path.node.declaration) {
        const decl = path.node.declaration;
        if (decl.type === 'FunctionDeclaration' && decl.id) declNames.push(decl.id.name);
        if (decl.type === 'ClassDeclaration' && decl.id) declNames.push(decl.id.name);
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id.type === 'Identifier') declNames.push(d.id.name);
          }
        }
      }
      fileInfo.exports.push({ type: 'named', specifiers, source, declarations: declNames, loc: path.node.loc });
    },
    ExportDefaultDeclaration(path) {
      let name = null;
      const decl = path.node.declaration;
      if (decl.type === 'Identifier') name = decl.name;
      else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) name = decl.id.name;
      fileInfo.exports.push({ type: 'default', name, loc: path.node.loc });
    },
    ExportAllDeclaration(path) {
      const source = path.node.source && path.node.source.value;
      fileInfo.exports.push({ type: 'all', source, loc: path.node.loc });
    },

    // Function declarations
    FunctionDeclaration(path) {
      const params = path.node.params.map(getParamName);
      const funcEntry = {
        name: path.node.id ? path.node.id.name : null,
        kind: 'declaration',
        params,
        async: !!path.node.async,
        generator: !!path.node.generator,
        loc: path.node.loc
      };
      fileInfo.functions.push(funcEntry);

      // Detect React Functional Component: returns JSX
      const body = path.node.body && path.node.body.body ? path.node.body.body : [];
      if (hasJSXReturn(body)) {
        fileInfo.reactComponents.push({ type: 'FunctionalComponent', name: funcEntry.name });
      }
    },

    // Variable-declared functions (arrow or function expressions)
    VariableDeclarator(path) {
      if (path.node.id.type !== 'Identifier') return;
      const varName = path.node.id.name;
      const init = path.node.init;
      if (!init) return;

      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        const params = init.params.map(getParamName);
        const funcEntry = {
          name: varName,
          kind: init.type === 'ArrowFunctionExpression' ? 'arrow' : 'functionExpression',
          params,
          async: !!init.async,
          generator: !!init.generator,
          loc: init.loc
        };
        fileInfo.functions.push(funcEntry);

        // React functional component detection for arrow functions
        if (init.type === 'ArrowFunctionExpression') {
          if (init.body && init.body.type !== 'BlockStatement' && isJSXNode(init.body)) {
            fileInfo.reactComponents.push({ type: 'FunctionalComponent', name: varName });
          } else if (init.body && init.body.type === 'BlockStatement' && hasJSXReturn(init.body.body)) {
            fileInfo.reactComponents.push({ type: 'FunctionalComponent', name: varName });
          }
        }
      }
    },

    // Class declarations
    ClassDeclaration(path) {
      const methods = [];
      for (const el of path.node.body.body) {
        if (el.type === 'ClassMethod') {
          methods.push({
            name: el.key && el.key.name,
            kind: el.kind, // constructor | method | get | set
            static: !!el.static,
            async: !!el.async,
            generator: !!el.generator,
            params: el.params.map(getParamName)
          });
        }
      }

      fileInfo.classes.push({
        name: path.node.id ? path.node.id.name : null,
        methods
      });

      // Detect React Class Component
      if (isReactComponentClass(path.node, reactImports)) {
        fileInfo.reactComponents.push({ type: 'ClassComponent', name: path.node.id ? path.node.id.name : null });
      }
    }
  });

  return fileInfo;
}

// Main: parse all files
function parseRepo() {
  const files = getJSFiles(REPO_DIR);
  const repoInfo = files.map(parseFile);
  return repoInfo;
}

// Run and output JSON
const result = parseRepo();
fs.writeFileSync('repo-analysis.json', JSON.stringify(result, null, 2));
console.log('Repo analysis complete! Check repo-analysis.json');
