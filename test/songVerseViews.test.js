'use strict';
const {SONG_VERSE_VIEWS,normalizeSongVerseViewMode,renderSongVerseCollection}=require('../lib/songVerseViews');
const fs=require('fs'),path=require('path');

const song={title:'Amazing Grace',lyrics:[
  {section:'Verse',text:'Amazing grace how sweet the sound\nThat saved a wretch like me\nAnd it keeps going to prove the entire verse text is retained.\n\nAnother full verse with more words on multiple lines'},
  {section:'Chorus',text:'I once was lost but now am found\nWas blind but now I see'}
]};
const render=(mode,selectedVerseIndex=1)=> {
  const host=document.createElement('main');
  host.innerHTML=renderSongVerseCollection(song,{mode,selectedVerseIndex,renderVerse:t=>t.replace(/\n/g,'<br>')});
  return host;
};

test('three modes supported with a safe mapping for saved Verse Blocks settings',()=>{
  expect(SONG_VERSE_VIEWS).toEqual(['full','grid','list']);
  expect(normalizeSongVerseViewMode('blocks')).toBe('list');
  expect(normalizeSongVerseViewMode('grid')).toBe('grid');
  expect(normalizeSongVerseViewMode('full')).toBe('full');
  expect(normalizeSongVerseViewMode('unknown')).toBe('full');
});

test.each(SONG_VERSE_VIEWS)('%s retains all verses, global indexes and highlighted selection',mode=>{
  const host=render(mode);
  const verses=[...host.querySelectorAll('[data-verse-index]')];
  expect(verses).toHaveLength(3);
  expect(verses.map(e=>e.dataset.verseIndex)).toEqual(['0','1','2']);
  expect(verses.filter(e=>e.classList.contains('selected'))).toHaveLength(1);
  expect(host.querySelector('[data-verse-index="1"].selected')).not.toBeNull();
});

test('full view shows complete text in stacked full-width verses',()=>{
  const host=render('full');
  expect(host.querySelectorAll('.song-verse-grid-item')).toHaveLength(0);
  expect(host.querySelectorAll('.song-verse')).toHaveLength(3);
  expect(host.querySelector('h3').textContent).toBe('Verse');
  expect(host.textContent).toContain('And it keeps going to prove the entire verse text is retained.');
});

test('grid contains full verse text in responsive cards and section captions',()=>{
  const host=render('grid');
  expect(host.querySelector('.song-verse-grid-list')).not.toBeNull();
  expect(host.querySelectorAll('.song-verse-grid-item')).toHaveLength(3);
  expect(host.textContent).toContain('And it keeps going to prove the entire verse text is retained.');
  expect(host.textContent).toContain('I once was lost but now am found');
  expect(host.querySelector('[data-verse-index="1"] .song-verse-grid-caption').textContent).toBe('Verse (2)');
  expect(host.querySelector('[data-verse-index="2"] .song-verse-grid-caption').textContent).toBe('Chorus');
});

test('compact list shows only opening words, escaping song content safely',()=>{
  const host=render('list');
  expect(host.querySelectorAll('.song-verse-block')).toHaveLength(3);
  expect(host.textContent).toContain('Amazing grace how sweet the sound');
  expect(host.textContent).not.toContain('That saved a wretch like me');
  expect(host.textContent).not.toContain('And it keeps going to prove the entire verse text is retained.');
  const malicious=renderSongVerseCollection({lyrics:[{section:'A',text:'<img src=x onerror=alert(1)>'}]},{mode:'list'});
  const el=document.createElement('div');el.innerHTML=malicious;
  expect(el.querySelector('img')).toBeNull();
  expect(el.textContent).toContain('<img src=x');
});

test('Explorer-style single View control replaces old text toggle and persists compatible setting',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  const code=fs.readFileSync(path.join(__dirname,'..','renderer.js'),'utf8');
  expect(html).toContain('id="song-view-menu"');
  expect(html).toContain('data-song-view="full"');
  expect(html).toContain('data-song-view="grid"');
  expect(html).toContain('data-song-view="list"');
  expect(html).not.toContain('>Verse Blocks</button>');
  expect(code).toContain('normalizeSongVerseViewMode(settings.songVerseViewMode)');
  expect(code).toContain('renderSongVerseCollection(song, {');
  expect(code).toContain("update-settings', { songVerseViewMode }");
});
