(function () {
  var d = window.__3D_DEBUG__;
  if (!d) return 'no-debug';
  var out = {};
  try {
    out.autoClear = d.renderer.autoClear;
    out.scissorTest = d.renderer.getScissorTest();
    var gl = d.renderer.getContext();
    var vp = gl.getParameter(gl.VIEWPORT);
    out.glViewport = Array.from(vp);
    out.camPos = d.camera.position.toArray().map(function (v) { return Math.round(v); });
    out.camTarget = d.controls.target.toArray().map(function (v) { return Math.round(v); });
    out.sceneVisible = d.scene.visible;
    out.childVisibility = d.scene.children.map(function (c) { return c.visible ? 1 : 0; }).join('');
    out.childCount = d.scene.children.length;
    out.localClip = d.renderer.localClippingEnabled;
    out.globalClipCount = d.renderer.clippingPlanes.length;
    // count visible meshes in frustum
    var THREE = window.THREE;
    out.camNearFar = [d.camera.near, d.camera.far];
    out.camAspect = Math.round(d.camera.aspect * 100) / 100;
    var probe = new THREE.Vector3();
    d.camera.getWorldPosition(probe);
    out.camWorldPos = probe.toArray().map(function (v) { return Math.round(v); });
  } catch (e) { out.error = String(e); }
  return JSON.stringify(out);
})()
