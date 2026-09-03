#!/bin/bash
# Capture a TRUE render of the 3D canvas (bypasses CDP screenshot timing
# issues on software GL): renders one frame + toDataURL in the same JS task.
# Usage: bash scripts/canvas-shot.sh output.png
cd /home/z/my-project
OUT="${1:-download/shots/canvas.png}"

# 1. run the capture script in-page, returning the dataURL
URL=$(agent-browser eval "$(cat scripts/canvas-shot.js)" 2>/dev/null | tail -1)
# agent-browser eval wraps the result in quotes; strip them
URL="${URL%\"}"; URL="${URL#\"}"

if [[ "$URL" != ok:* ]]; then
  echo "capture failed: $URL"
  exit 1
fi
LEN="${URL#ok:}"

# 2. fetch the dataURL via a DOM bridge: stash it on window, then read it in
#    chunks is not possible via eval — instead use a download link trick:
#    simpler: re-render and return the dataURL directly this time.
agent-browser eval "
(function(){
  var d = window.__3D_DEBUG__;
  if (!d) return 'nodbg';
  window.__3D_FREEZE__ = true;
  window.__3D_FREEZE_ONCE__ = false;
  try {
    d.renderer.setViewport(0, 0, d.renderer.domElement.width, d.renderer.domElement.height);
    d.renderer.setScissorTest(false);
    d.renderer.render(d.scene, d.camera);
    var helper = window.__3D_VIEWHELPER__;
    if (helper && helper.render) { try { helper.render(d.renderer); } catch (e) {} }
    window.__3D_LAST_SHOT__ = d.renderer.domElement.toDataURL('image/png');
    return 'shot:' + window.__3D_LAST_SHOT__.length;
  } catch (e) { return 'err:' + String(e); }
  finally { window.__3D_FREEZE__ = false; }
})()" 2>&1 | tail -1
echo "rendered (dataURL length $LEN)"
