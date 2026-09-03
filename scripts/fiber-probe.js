// Debug probe: walk React fiber tree from the 3D canvas to find the PCB store.
// Run via agent-browser eval with the file contents inlined.
(function () {
  var out = {};
  try {
    var canvas = document.querySelector('canvas');
    if (!canvas) return { error: 'no canvas' };
    // canvas is created by three.js imperatively — start from its React parent
    var startEl = canvas.parentElement;
    while (startEl && !Object.keys(startEl).some(function (k) { return k.indexOf('__reactFiber') === 0; })) {
      startEl = startEl.parentElement;
    }
    if (!startEl) return { error: 'no react parent' };
    var fk = Object.keys(startEl).find(function (k) { return k.indexOf('__reactFiber') === 0; });
    var node = startEl[fk];
    var names = [];
    var fpArr = null, boardObj = null;
    while (node && names.length < 40) {
      var t = node.type;
      var name = typeof t === 'function' ? (t.displayName || t.name || 'anon') : (typeof t === 'string' ? t : (t ? 'obj' : 'null'));
      names.push(name);
      var h = node.memoizedState;
      while (h) {
        var st = h.memoizedState;
        if (Array.isArray(st) && st.length && st[0] && st[0].pads && st[0].bodySize && !fpArr) fpArr = st;
        if (st && typeof st === 'object' && !Array.isArray(st) && typeof st.width === 'number' && typeof st.height === 'number' && st.width > 10 && !boardObj) boardObj = st;
        h = h.next;
      }
      node = node.return;
    }
    out.names = names;
    if (fpArr) {
      var xs = fpArr.map(function (f) { return f.position.x; });
      var ys = fpArr.map(function (f) { return f.position.y; });
      var padXs = [], padYs = [];
      fpArr.forEach(function (f) {
        (f.pads || []).forEach(function (p) { padXs.push(p.x); padYs.push(p.y); });
      });
      out.fps = {
        board: boardObj,
        count: fpArr.length,
        xMin: Math.min.apply(null, xs), xMax: Math.max.apply(null, xs),
        yMin: Math.min.apply(null, ys), yMax: Math.max.apply(null, ys),
        firstTypes: fpArr.slice(0, 8).map(function (f) { return f.componentType; }),
      };
    } else {
      out.fps = null;
    }
  } catch (e) { out.error = String(e); }
  return JSON.stringify(out);
})();
