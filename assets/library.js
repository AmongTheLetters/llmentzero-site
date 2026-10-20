// Skill library: the Filters panel starts closed on narrow screens and is always open on wide ones.
// Without JavaScript it is simply open. No other behaviour: every filter is a normal link.
(function () {
  var d = document.getElementById("lib-facets");
  if (!d || !window.matchMedia) return;
  var mq = window.matchMedia("(max-width: 899px)");
  function sync() { d.open = !mq.matches; }
  sync();
  if (mq.addEventListener) mq.addEventListener("change", sync);
})();
