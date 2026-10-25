'use strict';

// Shared exact media-tile HTML used by Media tab and Song Background editor.
// The caller owns selection actions; neither grid can affect the live output
// through rendering alone.
const BACKGROUND_TYPES = new Set(['COLOR','JPG','JPEG','PNG','GIF','WEBP','BMP','MP4','WEBM','OGG','MOV','AVI']);
const supportsSongBackground = media => !!media && BACKGROUND_TYPES.has(String(media.type || '').toUpperCase());
const pathToFileURL = value => value ? 'file:///' + String(value).replace(/\\/g,'/') : '';
function renderMediaLibraryGrid({
  allMedia = [], selectedMediaIndex = null, query = '',
  defaultBackgrounds = {}, showCreateColor = true
}) {
  query = String(query || '').toLowerCase();
  const filteredMedia = query ?
    allMedia.filter(m => m.name.toLowerCase().includes(query)) :
    allMedia;

  let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 12px; padding: 10px;">';

  // Always show "Create Color/Gradient" as first item (unless searching)
  if (!query && showCreateColor) {
    html += `<div class="media-item media-create-color" data-index="-1" tabindex="0" style="cursor: pointer; border: 1px solid transparent; border-radius: 6px; padding: 6px; text-align: center;">`;
    html += `<div style="width: 100%; height: 60px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center; font-size: 30px; color: white;">
      <svg width="30" height="30" viewBox="0 0 16 16" fill="white"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
    </div>`;
    html += `<div style="font-size: 10px; font-weight: 500; margin-bottom: 3px;">New Color</div>`;
    html += `<div style="font-size: 8px; color: #666;">Create</div>`;
    html += `</div>`;
  }

  if (filteredMedia.length === 0 && query) {
    return '<div style="padding: 20px; text-align: center; color: #999;">No media files match your search.</div>';
  }

  filteredMedia.forEach((media, index) => {
    const actualIndex = allMedia.indexOf(media);
    const isImage   = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
    const isVideo   = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
    const isColor   = media.type === 'COLOR';
    const isWebsite = media.type === 'WEBSITE';
    const isObsWidget = media.type === 'OBS_WIDGET';
    const isAnnouncement = media.type === 'ANNOUNCEMENT';
    const isPresentation = media.type === 'PRESENTATION';

    const displayName = media.name.length > 20 ? media.name.substring(0, 17) + '...' : media.name;
    const isSelected = selectedMediaIndex === actualIndex;

    html += `<div class="media-item${isSelected ? ' selected' : ''}" data-index="${actualIndex}" draggable="true" tabindex="0" style="cursor: pointer; border: 1px solid ${isSelected ? '#0078d4' : 'transparent'}; border-radius: 6px; padding: 6px; text-align: center;">`;

    // Thumbnail (wrap in media-thumb container to allow badge overlays)
    // Thumbnail (wrap in media-thumb container to allow badge overlays)
    let thumbHtml = '';
    if (isWebsite || isObsWidget) {
      if (media.thumbnail) {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #000; border-radius: 3px; overflow: hidden; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
          <img src="${media.thumbnail}" style="max-width: 100%; max-height: 100%; object-fit: cover;" />
        </div>`;
      } else if (isObsWidget) {
        const badge = (media.kind || 'widget').toUpperCase();
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #152238; border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 2px; color: white;">
          <div style="font-size: 11px; font-weight: 700;">${badge}</div>
          <div style="font-size: 8px; opacity: 0.75;">OBS</div>
        </div>`;
      } else {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #e8f4fd; border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 2px;">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0078d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        </div>`;
      }
    } else if (isPresentation) {
      const imageURL = media.slides?.[0]?.path ? pathToFileURL(media.slides[0].path) : '';
      thumbHtml = '<div class="media-thumb" style="width:100%;height:60px;background:#172843;border-radius:3px;overflow:hidden;margin-bottom:6px;display:flex;align-items:center;justify-content:center;">'
        + (imageURL ? '<img src="'+imageURL+'" style="width:100%;height:100%;object-fit:contain;">' : '<span style="color:#a4c8f3;font-size:22px;">▣</span>')+'</div>';
    } else if (isColor) {
      thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: ${media.color}; border-radius: 3px; margin-bottom: 6px;"></div>`;
    } else if (isAnnouncement) {
      const bgCol = media.backgroundColor || '#1a1a2e';
      const txtCol = media.textColor || '#ffffff';
      const titleText = media.title ? (media.title.length > 18 ? media.title.substring(0, 15) + '...' : media.title) : '';
      const bodyText  = media.body  ? (media.body.length  > 22 ? media.body.substring(0, 19)  + '...' : media.body)  : '';
      thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: ${bgCol}; border-radius: 3px; margin-bottom: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4px; box-sizing: border-box; overflow: hidden;">
        ${titleText ? `<div style="color: ${txtCol}; font-size: 9px; font-weight: bold; text-align: center; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">${titleText}</div>` : ''}
        ${bodyText  ? `<div style="color: ${txtCol}; font-size: 7px; text-align: center; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">${bodyText}</div>`  : ''}
      </div>`;
    } else {
      const fileURL = media.path ? media.path : ''; // will be converted to file URL by pathToFileURL() when used
      if (isImage) {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; overflow: hidden; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
          <img src="${pathToFileURL(fileURL)}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
        </div>`;
      } else if (isVideo) {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; overflow: hidden; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
          <video src="${pathToFileURL(fileURL)}" style="max-width: 100%; max-height: 100%; object-fit: contain;"></video>
        </div>`;
      } else {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
            <svg width="30" height="30" viewBox="0 0 16 16" fill="#666"><path d="M5.5 7a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5zM5 9.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"/><path d="M9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5L9.5 0zm0 1v2A1.5 1.5 0 0 0 11 4.5h2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5.5z"/></svg>
        </div>`;
      }
    }

    // Badges for defaults
    if (defaultBackgrounds.songs === actualIndex) {
      // music icon (FontAwesome 'music' SVG)
      thumbHtml = thumbHtml.replace(/<\/div>\s*$/, '<div class="fa-badge fa-bottom-right" title="Default background for songs">'+
        '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M499.1 6.3c8.1 6 12.9 15.6 12.9 25.7l0 72 0 264c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6L448 147 192 223.8 192 432c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6L128 200l0-72c0-14.1 9.3-26.6 22.8-30.7l320-96c9.7-2.9 20.2-1.1 28.3 5z"/></svg></div></div>');
    }
    if (defaultBackgrounds.verses === actualIndex) {
      // book icon (FontAwesome 'book-open' SVG)
      thumbHtml = thumbHtml.replace(/<\/div>\s*$/, '<div class="fa-badge fa-bottom-left" title="Default background for verses">'+
        '<svg viewBox="0 0 576 512" xmlns="http://www.w3.org/2000/svg"><path d="M249.6 471.5c10.8 3.8 22.4-4.1 22.4-15.5l0-377.4c0-4.2-1.6-8.4-5-11C247.4 52 202.4 32 144 32C93.5 32 46.3 45.3 18.1 56.1C6.8 60.5 0 71.7 0 83.8L0 454.1c0 11.9 12.8 20.2 24.1 16.5C55.6 460.1 105.5 448 144 448c33.9 0 79 14 105.6 23.5zm76.8 0C353 462 398.1 448 432 448c38.5 0 88.4 12.1 119.9 22.6c11.3 3.8 24.1-4.6 24.1-16.5l0-370.3c0-12.1-6.8-23.3-18.1-27.6C529.7 45.3 482.5 32 432 32c-58.4 0-103.4 20-123 35.6c-3.3 2.6-5 6.8-5 11L304 456c0 11.4 11.7 19.3 22.4 15.5z"/></svg></div></div>');
    }

    html += thumbHtml;

    // Labels
    html += `<div style="font-size: 10px; font-weight: 500; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${media.name}">${displayName}</div>`;
    html += `<div style="font-size: 8px; color: #666;">${isObsWidget ? (media.kind || 'widget') : isWebsite ? (media.url || 'No URL') : isAnnouncement ? 'Announcement' : isPresentation ? (media.slides?.length || 0)+' slides' : `${media.type} \u2022 ${media.size}`}</div>`;
    html += `</div>`;
  });

  html += '</div>';

  // Empty state hint (no items added yet, not searching)
  if (allMedia.length === 0 && !query) {
    html += '<div style="padding: 20px; text-align: center; color: #999; font-size: 13px;">No media yet. Click + to add photos, videos, or websites, or use the New Color tile above.</div>';
  }

  return html;


}
module.exports = {renderMediaLibraryGrid,supportsSongBackground,BACKGROUND_TYPES};
