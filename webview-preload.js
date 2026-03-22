// webview-preload.js
// Silently block native requestFullscreen() so websites cannot trigger OS-level
// fullscreen on the BrowserWindow. Our own floating button in the host UI handles
// "fill canvas with video" without needing the Fullscreen API at all.

(function () {
  const noop = () => Promise.resolve();
  Element.prototype.requestFullscreen       = noop;
  Element.prototype.webkitRequestFullscreen = function () {};
  Element.prototype.webkitRequestFullScreen = function () {};
  Element.prototype.mozRequestFullScreen    = noop;
  Element.prototype.msRequestFullscreen     = noop;
  document.exitFullscreen      = noop;
  document.webkitExitFullscreen = function () {};
  document.mozCancelFullScreen  = noop;
  document.msExitFullscreen     = noop;
})();
