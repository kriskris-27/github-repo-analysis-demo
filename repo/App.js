import React from 'react';
import Calculator from './Calculator';

function App() {
  const calc = new Calculator();
  console.log(calc.add(2,3));
  return <div>Hello World</div>;
}
export default App;
