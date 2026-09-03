(function () {
  var text = CLICK_TEXT;
  var b = Array.from(document.querySelectorAll('button')).find(function (x) { return x.textContent.trim() === text; });
  if (!b) return 'no-button:' + text;
  b.click();
  return 'clicked:' + text;
})()
