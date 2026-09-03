// Capture the true rendered canvas content:
// render one frame via the debug hook, immediately export toDataURL in the
// same JS task (before the drawing buffer is invalidated), save as PNG.
(function () {
  var d = window.__3D_DEBUG__;
  if (!d) return 'no-debug';
  try {
    // freeze the RAF loop so no subsequent clear wipes the buffer
    window.__3D_FREEZE__ = true;
    window.__3D_FREEZE_ONCE__ = false;
    // render one full frame (composer when available at this tier, else raw)
    d.renderer.setViewport(0, 0, d.renderer.domElement.width / d.renderer.getPixelRatio(), d.renderer.domElement.height / d.renderer.getPixelRatio());
    d.renderer.setScissorTest(false);
    d.renderer.render(d.scene, d.camera);
    // gizmo on top
    var helper = window.__3D_VIEWHELPER__;
    if (helper && helper.render) {
      try { helper.render(d.renderer); } catch (e) { /* optional */ }
    }
    var url = d.renderer.domElement.toDataURL('image/png');
    window.__3D_FREEZE__ = false;
    return url.length > 1000 ? 'ok:' + url.length : 'bad-dataurl:' + url.length;
  } catch (e) {
    window.__3D_FREEZE__ = false;
    return 'err:' + String(e);
  }
})()
