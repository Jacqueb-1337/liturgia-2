'use strict';

// All layouts share one global verse index. Changing layout never changes
// the verse selected for Preview or Live.
const SONG_VERSE_VIEWS = Object.freeze(['full','grid','list']);
const normalizeSongVerseViewMode = value =>
  value === 'blocks' ? 'list' : SONG_VERSE_VIEWS.includes(value) ? value : 'full';
const escapeHTML = input => String(input == null ? '' : input).replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
})[char]);

function renderSongVerseCollection(song, options={}) {
  const view = normalizeSongVerseViewMode(options.mode);
  const render = typeof options.renderVerse === 'function' ? options.renderVerse : escapeHTML;
  const sections = Array.isArray(song && song.lyrics) ? song.lyrics : [];
  const selectedVerseIndex = options.selectedVerseIndex;
  let html = view === 'grid' ? '<div class="song-verse-grid-list">' :
    view === 'list' ? '<div class="song-verse-compact-list">' : '';
  let globalIndex=0;

  for (const section of sections) {
    const verses=String(section && section.text || '').split(/\n\n+/);
    const sectionTitle=escapeHTML(section && section.section || 'Verse');
    if(view==='full') html+='<h3>'+sectionTitle+'</h3>';
    for(let index=0;index<verses.length;index++) {
      const verse=verses[index];
      const selected=selectedVerseIndex===globalIndex;
      const identifier='data-verse-index="'+globalIndex+'"';
      const label=sectionTitle+(verses.length>1 ? ' ('+(index+1)+')' : '');
      if(view==='full') {
        html+='<p class="song-verse'+(selected?' selected':'')+'" '+identifier+' tabindex="0" role="button" aria-label="'+label+'" style="white-space:pre-wrap;padding:4px;margin:2px 0;cursor:pointer;border-radius:4px;'+(selected?'background:#0078d4;color:#fff;':'')+'">'+render(verse)+'</p>';
      } else if(view==='grid') {
        html+='<div class="song-verse song-verse-grid-item'+(selected?' selected':'')+'" '+identifier+' tabindex="0" role="button" aria-label="'+label+'" aria-pressed="'+selected+'"><div class="song-verse-grid-caption">'+label+'</div><div class="song-verse-grid-text">'+render(verse)+'</div></div>';
      } else {
        const line=verse.split('\n')[0].replace(/___HIGHLIGHT_(START|END)___/g,'').trim();
        const short=line.length>40 ? line.slice(0,40).trimEnd()+'…' : line;
        html+='<div class="song-verse-block'+(selected?' selected':'')+'" '+identifier+' tabindex="0" role="button" aria-label="'+label+': '+escapeHTML(short)+'" aria-pressed="'+selected+'"><span class="song-verse-list-label">'+label+':</span> <span class="song-verse-list-excerpt">'+escapeHTML(short)+'</span></div>';
      }
      globalIndex++;
    }
  }
  if(view==='grid'||view==='list')html+='</div>';
  return html;
}

module.exports={SONG_VERSE_VIEWS,normalizeSongVerseViewMode,renderSongVerseCollection};
