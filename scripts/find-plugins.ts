import('../src/lib/circuit/components/index.ts').then(m => {
  const plugins = m.getAllPlugins();
  const zeroTerminal = plugins.filter(p => p.terminals.length === 0);
  console.log('Plugins with 0 terminals:', zeroTerminal.map(p => p.type));
  const outOfBBox = [];
  for (const p of plugins) {
    for (const t of p.terminals) {
      if (t.position.x < -2 || t.position.x > p.boundingBox.width + 2 ||
          t.position.y < -2 || t.position.y > p.boundingBox.height + 2) {
        outOfBBox.push({ type: p.type, term: t.id, x: t.position.x, y: t.position.y, w: p.boundingBox.width, h: p.boundingBox.height });
      }
    }
  }
  console.log('Terminals out of bbox:', outOfBBox.slice(0, 10));
  // Check default values
  const typeMismatch = [];
  for (const p of plugins) {
    for (const param of p.parameters) {
      if (param.type === 'number' && typeof param.default !== 'number') typeMismatch.push({type: p.type, param: param.key, decl: 'number', actual: typeof param.default});
      else if ((param.type === 'string' || param.type === 'select' || param.type === 'color') && typeof param.default !== 'string') typeMismatch.push({type: p.type, param: param.key, decl: param.type, actual: typeof param.default});
      else if (param.type === 'boolean' && typeof param.default !== 'boolean') typeMismatch.push({type: p.type, param: param.key, decl: 'boolean', actual: typeof param.default});
    }
  }
  console.log('Type mismatches:', typeMismatch.slice(0, 10));
}).catch(e => console.error(e));
