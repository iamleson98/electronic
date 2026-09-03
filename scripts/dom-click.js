// Open a Radix dropdown by button text via synthetic pointer events.
// Usage: agent-browser eval "$(cat scripts/dom-click.js)" -- via wrapper
(function () {
  var text = CLICK_TEXT;
  var b = Array.from(document.querySelectorAll('button')).find(function (x) { return x.textContent.trim() === text; });
  if (!b) return 'no-button:' + text;
  var r = b.getBoundingClientRect();
  var opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
  b.dispatchEvent(new PointerEvent('pointerdown', opts));
  b.dispatchEvent(new PointerEvent('pointerup', opts));
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  return 'clicked:' + text;
})()
