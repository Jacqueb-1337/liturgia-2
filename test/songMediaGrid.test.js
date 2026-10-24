const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {renderMediaLibraryGrid,supportsSongBackground}=require('../lib/mediaLibraryGrid');

const media=[
  {type:'COLOR',name:'Soft violet',color:'linear-gradient(45deg, #112233, #445566)',size:'0 B',path:null},
  {type:'PNG',name:'Backdrop.png',path:'C:\\media\\Backdrop.png',size:'123 KB'},
  {type:'GIF',name:'Loop.gif',path:'C:\\media\\Loop.gif',size:'234 KB'},
  {type:'MP4',name:'Motion.mp4',path:'C:\\media\\Motion.mp4',size:'1 MB'},
  {type:'WEBSITE',name:'A website',url:'https://example.test'}
];

test('Media tab and Song editor call the same grid builder for eligible media',()=>{
  expect(media.filter(supportsSongBackground)).toHaveLength(4);
  const full=renderMediaLibraryGrid({allMedia:media,defaultBackgrounds:{songs:2},showCreateColor:true});
  const chooser=renderMediaLibraryGrid({allMedia:media.filter(supportsSongBackground),selectedMediaIndex:0,showCreateColor:true});
  expect(full).toContain('media-create-color');
  expect(chooser).toContain('media-create-color');
  const element=document.createElement('section');
  element.innerHTML=chooser;
  const names=[...element.querySelectorAll('.media-item:not(.media-create-color)')].map(tile=>tile.textContent);
  expect(names).toHaveLength(4);
  expect(names[0]).toContain('Soft violet');
  expect(element.querySelector('[data-index="0"].selected .media-thumb').getAttribute('style')).toContain('linear-gradient');
  expect(element.querySelector('[data-index="1"] img').src).toContain('Backdrop.png');
  expect(element.querySelector('[data-index="2"] img').src).toContain('Loop.gif');
  expect(element.querySelector('[data-index="3"] video').src).toContain('Motion.mp4');
  expect(full).toContain('Default background for songs');
});

test('Search filters all same tile types without renumbering selected index',()=>{
  const filtered=renderMediaLibraryGrid({allMedia:media,query:'motion',selectedMediaIndex:3});
  const element=document.createElement('section'); element.innerHTML=filtered;
  const selected=element.querySelector('.media-item.selected');
  expect(selected.dataset.index).toBe('3');
  expect(element.querySelectorAll('.media-item')).toHaveLength(1);
});

test('The song background reference resolver preserves legacy paths and virtual colors',()=>{
  const renderer=fs.readFileSync(path.join(__dirname,'..','renderer.js'),'utf8');
  const start=renderer.indexOf('function getBackgroundMedia(backgroundIndex) {');
  const end=renderer.indexOf('\nfunction updateImagePreview()',start);
  expect(start).toBeGreaterThan(0);
  const ctx={allMedia:media};
  const resolver=vm.runInNewContext(renderer.slice(start,end)+';getBackgroundMedia',ctx);
  expect(resolver({path:'C:\\media\\Backdrop.png'}).type).toBe('PNG');
  expect(resolver(2).type).toBe('GIF');
  expect(resolver({type:'COLOR',color:media[0].color}).type).toBe('COLOR');
  expect(resolver({type:'COLOR',color:'#bb8899'}).color).toBe('#bb8899');
});

test('Song styling window contains grid and no dropdown, and main sends full media records',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','style-window.html'),'utf8');
  const renderer=fs.readFileSync(path.join(__dirname,'..','renderer.js'),'utf8');
  expect(html).toContain("require('./lib/mediaLibraryGrid')");
  expect(html).toContain('id="song-bg-media-grid"');
  expect(html).not.toContain('id="song-bg-media"');
  expect(renderer).toContain('mediaChoices: allMedia.filter(supportsSongBackground).map(m => ({...m}))');
  expect(renderer).toContain('getBackgroundMedia(verseData.backgroundOverride)');
});
