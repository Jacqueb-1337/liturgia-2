const {renderUpdateChangelog}=require('../lib/updateReleaseNotes');

test('GitHub release notes render bold labels, bullets, and safe clickable links',()=>{
  const el=document.createElement('section');
  renderUpdateChangelog(el,{
    changelog:[{version:'v6.1.36',body:'**Full Changelog**: https://github.com/Jacqueb-1337/liturgia-2/compare/v6.1.35...v6.1.36\n- Added song background grid\n## Fixes\n[Release notes](https://github.com/Jacqueb-1337/liturgia-2/releases/tag/v6.1.36)'}]
  });
  expect(el.querySelector('h3').textContent).toBe('v6.1.36');
  expect(el.querySelector('strong').textContent).toBe('Full Changelog');
  expect(el.textContent).not.toContain('**Full Changelog**');
  const links=el.querySelectorAll('a.update-cl-link');
  expect(links).toHaveLength(2);
  expect(links[0].href).toContain('/compare/v6.1.35...v6.1.36');
  expect(links[0].rel).toContain('noopener');
  expect(el.querySelector('.update-cl-bullet').textContent).toContain('Added song background grid');
  expect(el.querySelector('h4').textContent).toBe('Fixes');
});
test('untrusted GitHub notes cannot inject HTML, handlers, or JavaScript URLs',()=>{
 const container=document.createElement('section');
 renderUpdateChangelog(container,{latest:'v6.1.36',body:'<img src=x onerror=alert(1)>\n[Bad](javascript:alert(1))\n**Safe**'});
 expect(container.querySelector('img')).toBeNull();
 expect(container.querySelectorAll('a')).toHaveLength(0);
 expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
 expect(container.querySelector('strong').textContent).toBe('Safe');
});
test('empty changelog and release bodies still show useful fallback',()=>{
 const container=document.createElement('div');
 renderUpdateChangelog(container,{changelog:[]});
 expect(container.textContent).toContain('No release notes');
});
