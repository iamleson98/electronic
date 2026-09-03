(function () {
  var prefix = ITEM_PREFIX;
  var it = Array.from(document.querySelectorAll('[role=menuitem]')).find(function (x) { return x.textContent.trim().indexOf(prefix) === 0; });
  if (!it) return 'not-found:' + document.querySelectorAll('[role=menuitem]').length;
  it.click();
  return 'clicked:' + prefix;
})()
