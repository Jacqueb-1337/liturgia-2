const fs=require('fs'),path=require('path');
const {createFlameBoot,SHAPES}=require('../lib/flameBoot');

const markup = '<svg xmlns="http://www.w3.org/2000/svg">'
  + '<g id="boot-flame-art"><path id="boot-flame-body"/></g>'
  + '<path id="boot-flame-hollow"/></svg>';

test('flame provides distinct closed contours with a stable loop destination', () => {
  for(const role of ['body','hollow']){
    const {rest,lift,lean}=SHAPES[role];
    expect(new Set([rest,lift,lean]).size).toBe(3);
    for(const d of [rest,lift,lean]) {
      expect(d).toMatch(/^M\s/);
      expect(d.trim()).toMatch(/Z$/);
      expect((d.match(/\bC\b/g)||[]).length).toBeGreaterThanOrEqual(4);
    }
  }
});

test('static flame renders correctly without motion', () => {
  const host=document.createElement('div');
  host.innerHTML=markup;
  const root=host.querySelector('svg');
  const session=createFlameBoot(root,{animate:false,view:window});
  expect(session.isAnimated).toBe(false);
  expect(session.duration).toBe(0);
  expect(root.querySelector('#boot-flame-body').getAttribute('d')).toBe(SHAPES.body.rest);
  expect(root.querySelector('#boot-flame-hollow').getAttribute('d')).toBe(SHAPES.hollow.rest);
  session.destroy();
});

test('startup uses an SVG with GIF retained only as fallback', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','splash.html'),'utf8');
  expect(html).toContain('id="flame-logo"');
  expect(html).toContain('id="boot-flame-cutout"');
  expect(html).toContain("require('./lib/flameBoot')");
  expect(html).toContain('class="logo-fallback" src="loading.gif"');
});