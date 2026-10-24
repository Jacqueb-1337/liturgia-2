'use strict';

// Liturgia's boot flame is vector art. GSAP interpolates smoothly between
// deliberately drawn contours instead of looping the old 20-frame raster GIF.
// Only invoked in the independent splash BrowserWindow.
const { gsap } = require('gsap');
const { MorphSVGPlugin } = require('gsap/MorphSVGPlugin');

const SHAPES = Object.freeze({
  body: {
    rest: 'M 81 39 C 78 54 67 62 59 74 C 49 89 46 100 48 115 C 49 133 60 147 76 155 C 80 157 84 159 87 161 C 80 148 78 133 83 119 C 87 107 93 99 95 90 C 94 104 102 115 104 129 C 107 142 103 153 97 160 C 112 155 122 141 123 123 C 126 101 116 86 104 70 C 92 55 84 48 81 39 Z',
    lift: 'M 78 35 C 77 51 65 59 57 73 C 49 88 47 102 49 117 C 51 134 62 147 76 155 C 81 158 85 160 89 161 C 81 146 79 132 84 116 C 90 103 96 94 97 85 C 97 103 105 117 106 129 C 108 143 102 154 98 160 C 114 155 123 140 121 122 C 122 100 114 84 102 69 C 88 53 82 44 78 35 Z',
    lean: 'M 85 40 C 80 52 70 62 61 75 C 49 91 47 104 49 117 C 51 135 61 148 76 154 C 81 157 85 158 88 161 C 80 147 79 132 83 120 C 85 108 89 100 91 91 C 91 107 99 116 103 129 C 107 143 102 153 96 160 C 112 153 121 141 123 121 C 127 102 119 87 107 73 C 96 58 86 49 85 40 Z'
  },
  hollow: {
    rest: 'M 91 98 C 84 109 79 121 79 134 C 79 145 83 156 91 164 C 99 152 101 140 100 129 C 99 115 94 105 91 98 Z',
    lift: 'M 93 96 C 86 108 80 120 80 134 C 80 148 85 158 93 165 C 100 150 102 140 101 128 C 100 115 96 103 93 96 Z',
    lean: 'M 89 101 C 84 112 79 123 79 135 C 80 148 84 156 90 164 C 97 152 99 141 99 130 C 98 115 93 107 89 101 Z'
  }
});

function createFlameBoot(root, options = {}) {
  if (!root) throw new Error('Flame SVG root is required');
  const body = root.querySelector('#boot-flame-body');
  const hollow = root.querySelector('#boot-flame-hollow');
  const symbol = root.querySelector('#boot-flame-art');
  if (!body || !hollow || !symbol) throw new Error('Incomplete flame SVG');
  const win = options.view || root.ownerDocument.defaultView;
  const mq = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let destroyed = false;
  let intro = null, loop = null;
  let animate = !mq?.matches && options.animate !== false;

  // Even without GSAP, the preauthored SVG displays an attractive static mark.
  body.setAttribute('d', SHAPES.body.rest);
  hollow.setAttribute('d', SHAPES.hollow.rest);
  if (animate) {
    gsap.registerPlugin(MorphSVGPlugin);
    gsap.set(symbol, {transformOrigin:'50% 72%'});
    // Intro plays only once. No overshoot, flicker, or cartoon bounce.
    if (!options.paused) {
      intro = gsap.fromTo(symbol, {y:5, scale:.956, opacity:.72}, {
        y:0, scale:1, opacity:1, duration:.64, ease:'power2.out'
      });
    }
    loop = gsap.timeline({
      paused:!!options.paused, repeat:-1, defaults:{ease:'sine.inOut'}
    });
    // A little movement in the tip and waist, with a stable, recognizable base.
    // Closing each loop in the same shape creates a seamless, nonflickering seam.
    loop.to(body, {duration:1.03, morphSVG:{shape:SHAPES.body.lift, type:'rotational'}}, 0)
      .to(hollow, {duration:1.12, morphSVG:{shape:SHAPES.hollow.lift, type:'rotational'}}, .08)
      .to(body, {duration:1.22, morphSVG:{shape:SHAPES.body.lean, type:'rotational'}}, 1.03)
      .to(hollow, {duration:1.15, morphSVG:{shape:SHAPES.hollow.lean, type:'rotational'}}, 1.2)
      .to(body, {duration:1.12, morphSVG:{shape:SHAPES.body.rest, type:'rotational'}}, 2.25)
      .to(hollow, {duration:1.17, morphSVG:{shape:SHAPES.hollow.rest, type:'rotational'}}, 2.35);
    if (!options.paused) loop.play(0);
  }
  function setTime(time) {
    if (destroyed || !loop) return;
    // Preview harness can seek every frame deterministically.
    loop.pause(Math.max(0, time));
  }
  function onPreference() {
    if (!loop || destroyed) return;
    if (mq.matches) {
      loop.pause(0);
      intro?.pause(0);
      gsap.set(symbol, {clearProps:'transform,opacity'});
      body.setAttribute('d', SHAPES.body.rest);
      hollow.setAttribute('d', SHAPES.hollow.rest);
    } else {
      loop.play();
    }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    mq?.removeEventListener?.('change', onPreference);
    win?.removeEventListener?.('pagehide', destroy);
    intro?.kill();
    loop?.kill();
  }
  mq?.addEventListener?.('change', onPreference);
  win?.addEventListener?.('pagehide', destroy, {once:true});
  return {setTime, destroy, get duration(){return loop?.duration() || 0;}, get isAnimated(){return animate;}};
}
module.exports = {createFlameBoot, SHAPES};