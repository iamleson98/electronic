(function () {
  var d = window.__3D_DEBUG__;
  if (!d) return 'no-debug';
  try {
    d.renderer.info.autoReset = false;
    d.renderer.info.reset();
    d.renderer.render(d.scene, d.camera);
    var info = d.renderer.info.render;
    d.renderer.info.autoReset = true;
    return JSON.stringify({ calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines });
  } catch (e) { return 'err:' + String(e); }
})()
