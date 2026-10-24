'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');

test('the actual View menu opens, restores legacy preference, saves new mode, and dismisses with Escape/outside click',async()=>{
  const renderer=fs.readFileSync(path.join(__dirname,'..','renderer.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  const start=html.indexOf('<div id="song-view-picker"');
  const end=html.indexOf('<button id="song-add-btn"',start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  document.body.innerHTML=html.slice(start,end);
  const menu=document.getElementById('song-view-menu'),toggle=document.getElementById('song-view-toggle');
  const updates=[];
  const ctx={
    document, console,
    selectedSongIndices: [],
    normalizeSongVerseViewMode: require('../lib/songVerseViews').normalizeSongVerseViewMode,
    ipcRenderer: {invoke:async(channel,payload)=>{
      if(channel==='load-settings')return {songVerseViewMode:'blocks'};
      if(channel==='update-settings')updates.push(payload);
      return {};
    }},
    requestAnimationFrame:cb=>cb(),
    scrollSelectedSongVerseIntoView:()=>{},
    displaySelectedSong:()=>{},
    initSongEditor:()=>{},
    initSongContextMenu:()=>{},
    initSongListDragDrop:()=>{},
    openSongEditor:()=>{},
    switchTab:()=>{},
  };
  vm.createContext(ctx);
  const saveStart=renderer.indexOf('async function saveSongViewMode()');
  const saveEnd=renderer.indexOf('\nlet draggedScheduleIndex',saveStart);
  const initStart=renderer.indexOf('function initTabs()');
  const initEnd=renderer.indexOf('\nfunction switchTab(',initStart);
  expect(saveStart).toBeGreaterThan(0);
  expect(initStart).toBeGreaterThan(0);
  vm.runInContext("var songVerseViewMode = 'full';\n"+renderer.slice(saveStart,saveEnd)+'\n'+renderer.slice(initStart,initEnd),ctx);
  vm.runInContext('initTabs()',ctx);
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(vm.runInContext('songVerseViewMode',ctx)).toBe('list');
  expect(menu.querySelector('[data-song-view="list"]').getAttribute('aria-checked')).toBe('true');
  toggle.click();
  expect(menu.hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  menu.querySelector('[data-song-view="grid"]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(vm.runInContext('songVerseViewMode',ctx)).toBe('grid');
  expect(updates).toEqual([{songVerseViewMode:'grid'}]);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(menu.hidden).toBe(true);
  expect(menu.querySelector('[data-song-view="grid"]').getAttribute('aria-checked')).toBe('true');
  toggle.click();
  menu.querySelector('[data-song-view="grid"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  expect(document.activeElement).toBe(menu.querySelector('[data-song-view="list"]'));
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  expect(menu.hidden).toBe(true);
  toggle.click();
  document.body.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));
  expect(menu.hidden).toBe(true);
});
