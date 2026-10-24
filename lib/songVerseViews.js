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
  // List previews run into subsequent verses when a verse is short. This is
  // visual context only. Every clickable row retains its own source index.
  const flattened = [];
  for (const section of sections) {
    const pieces=String(section && section.text || '').split(/\n\n+/);
    pieces.forEach((text,i)=>flattened.push({
      text, label:String(section && section.section || 'Verse')+
        (pieces.length>1?' ('+(i+1)+')':'')
    }));
  }
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
        // Fill the available single-line width with this verse and as much
        // following material as fits. Ellipsis is imposed by actual CSS width,
        // never by a fixed 40-character cutoff.
        let short='';
        for (let next=globalIndex;next<flattened.length;next++) {
          const item=flattened[next];
          const words=item.text.replace(/___HIGHLIGHT_(START|END)___/g,'').replace(/\s+/g,' ').trim();
          short+=(next===globalIndex?'':'  ·  '+item.label+': ')+words;
          if (short.length>1100) break; // avoids huge hidden DOM on very long songs
        }
        html+='<div class="song-verse-block'+(selected?' selected':'')+'" '+identifier+' tabindex="0" role="button" aria-label="'+label+': '+escapeHTML(short)+'" aria-pressed="'+selected+'"><span class="song-verse-list-label">'+label+':</span> <span class="song-verse-list-excerpt">'+escapeHTML(short)+'</span></div>';
      }
      globalIndex++;
    }
  }
  if(view==='grid'||view==='list')html+='</div>';
  return html;
}

module.exports={SONG_VERSE_VIEWS,normalizeSongVerseViewMode,renderSongVerseCollection};
