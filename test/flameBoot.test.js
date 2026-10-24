const fs=require('fs'),path=require('path');
const {createFlameBoot,pathAt,geometryAt,FRAME_COUNT,DURATION,SHAPES}=require('../lib/flameBoot');
const source=require('../lib/flameSourceFrames.json');
const markup='<svg xmlns="http://www.w3.org/2000/svg"><path id="boot-flame-body"/></svg>';

test('the source includes all original 20 substantial moving silhouettes', () => {
  expect(FRAME_COUNT).toBe(20);
  expect(DURATION).toBe(2);
  expect(source.frames).toHaveLength(20);
  expect(source.pointsPerFrame).toBeGreaterThanOrEqual(48);
  const topYs=source.frames.map(frame=>Math.min(...frame.map(p=>p[1])));
  expect(Math.max(...topYs)-Math.min(...topYs)).toBeGreaterThan(60);
  const widths=source.frames.map(frame=>Math.max(...frame.map(p=>p[0]))-Math.min(...frame.map(p=>p[0])));
  expect(Math.max(...widths)-Math.min(...widths)).toBeGreaterThan(35);
});

test('GSAP contour interpolation draws different in-between silhouettes and a seamless seam', () => {
  expect(pathAt(0)).toEqual(pathAt(20));
  expect(pathAt(.5)).not.toBe(pathAt(0));
  expect(pathAt(.5)).not.toBe(pathAt(1));
  expect(pathAt(4.5)).not.toBe(pathAt(4));
  expect(pathAt(4.5)).not.toBe(pathAt(5));
  const a=geometryAt(0),b=geometryAt(.5);
  expect(a).toHaveLength(source.pointsPerFrame);
  expect(a.some((point,i)=>Math.abs(point[0]-b[i][0])+Math.abs(point[1]-b[i][1])>.05)).toBe(true);
  expect(SHAPES.body.rest).toMatch(/^M/);
  expect(SHAPES.body.rest.trim()).toMatch(/Z$/);
});

test('static mode displays the original flame without starting a loop', () => {
  const host=document.createElement('div');
  host.innerHTML=markup;
  const root=host.querySelector('svg');
  const session=createFlameBoot(root,{animate:false,view:window});
  expect(session.isAnimated).toBe(false);
  expect(session.duration).toBe(2);
  expect(root.querySelector('#boot-flame-body').getAttribute('d')).toBe(pathAt(0));
  session.setTime(.45);
  expect(root.querySelector('#boot-flame-body').getAttribute('d')).toBe(pathAt(4.5));
  session.destroy();
});

test('splash preserves original image fallback and uses an SVG open-bottom outline', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','splash.html'),'utf8');
  expect(html).toContain('id="flame-logo"');
  expect(html).toContain('id="boot-flame-body"');
  expect(html).toContain(pathAt(0)); // the first paint matches the interpolated animation
  expect(html).not.toContain('id="boot-flame-cutout"');
  expect(html).toContain("require('./lib/flameBoot')");
  expect(html).toContain('class="logo-fallback" src="loading.gif"');
});
