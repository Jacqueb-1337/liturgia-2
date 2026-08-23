// renderer.js

const fs = require('fs');
const path = require('path');
const { ipcRenderer, shell } = require('electron');
// Secure storage API using IPC to main (uses keytar in main if available)
const secure = {
  async getToken() { try { return await ipcRenderer.invoke('secure-get-token'); } catch (e) { console.error('secure get token error', e); return null; } },
  async setToken(token) { try { return await ipcRenderer.invoke('secure-set-token', token); } catch (e) { console.error('secure set token error', e); return false; } },
  async deleteToken() { try { return await ipcRenderer.invoke('secure-delete-token'); } catch (e) { console.error('secure delete token error', e); return false; } }
};

// Handle deep link authentication (when user clicks magic link from email)
ipcRenderer.on('deep-link:auth-token', async (event, data) => {
  try {
    if (data && data.token) {
      console.log('[renderer] Received deep link auth token, signing in...');
      // Save token and trigger sign-in flow
      await secure.setToken(data.token);
      // Reload the page or show the UI to reflect the new auth state
      window.location.reload();
    }
  } catch (err) {
    console.error('[renderer] Failed to handle deep link auth token', err);
  }
});

ipcRenderer.on('open-tutorial-hub', () => {
  openTutorialHub();
});

let fetch;
if (typeof window !== 'undefined' && window.fetch) {
  fetch = window.fetch.bind(window);
} else {
  try {
    fetch = require('node-fetch');
  } catch (e) {
    console.warn('node-fetch not available and no global fetch available');
    fetch = null;
  }
}
const {
  ensureBibleJson,
  loadAllVersesFromDisk,
  fetchChapter,
  downloadRemainingChapters
} = require('./scriptureData');
const { renderWindow } = require('./virtualList');
const { safeStatus } = require('./uiHelpers');
const {
  VERSION, CDN_BASE, ITEM_HEIGHT, WINDOW_SIZE, BUFFER, BOOKS, CHAPTER_COUNTS, VERSE_COUNTS, BIBLE_STORAGE_DIR
} = require('./constants');

// Dynamic metadata derived from the currently loaded Bible.
// Updated every time allVerses changes (init + bible switch).
let dynamicBibleMeta = { bookNames: [], chapterCounts: {}, verseCounts: {} };

// Saved search-box config so we can re-apply it with updated book names.
let searchBoxConfig = null;

/**
 * Derive book names, chapter counts, and verse counts directly from the
 * allVerses array.  Keys are formatted "BookName chapter:verse" so all
 * metadata we need is already encoded in the key strings.
 */
function extractBibleMetadata(verses) {
  const bookOrder = [];
  const chapterCounts = {};
  const verseCounts = {};
  if (!Array.isArray(verses)) return { bookNames: [], chapterCounts: {}, verseCounts: {} };
  for (const v of verses) {
    const key = v && v.key ? v.key : '';
    const m = key.match(/^(.+?) (\d+):(\d+)$/);
    if (!m) continue;
    const book = m[1];
    const chap = parseInt(m[2], 10);
    const verse = parseInt(m[3], 10);
    if (bookOrder.indexOf(book) === -1) bookOrder.push(book);
    if (!chapterCounts[book] || chapterCounts[book] < chap) chapterCounts[book] = chap;
    const vk = `${book} ${chap}`;
    if (!verseCounts[vk] || verseCounts[vk] < verse) verseCounts[vk] = verse;
  }
  return { bookNames: bookOrder, chapterCounts, verseCounts };
}

/**
 * Recompute dynamicBibleMeta from allVerses, update the search box books list,
 * and notify the main process (which forwards to the speech worker window).
 */
function applyDynamicBibleMeta() {
  if (!allVerses || !allVerses.length) return;
  dynamicBibleMeta = extractBibleMetadata(allVerses);
  // Re-wire the search box with the real book names from the loaded Bible.
  if (searchBoxConfig && typeof updateSearchBox === 'function') {
    try { updateSearchBox({ ...searchBoxConfig, books: dynamicBibleMeta.bookNames }); } catch (e) {}
  }
  // Inform the speech worker (via main process broadcast) of the new book list.
  try { ipcRenderer.send('bible-books-updated', dynamicBibleMeta.bookNames); } catch (e) {}
}

const desktopRuntime = (typeof window !== 'undefined') ? window.desktopRuntime : null;
const AI_HINT_MESSAGE = 'Verse suggestions will appear once Liturgia hears you.';
const aiSuggestionState = { 
  enabled: true, 
  disposers: [], 
  renderPending: false, 
  lastPayload: null,
  lastProcessedPayload: null,
  suggestionGroups: [],
  lastRenderedKey: null,
  lastHintHidden: null,
  isHovering: false,
  autoScrollId: null,
  newGroupCount: 0,
  pendingGroups: []
};
if (desktopRuntime && typeof desktopRuntime.getCachedAiEnabled === 'function') {
  try { aiSuggestionState.enabled = !!desktopRuntime.getCachedAiEnabled(); } catch (_) {}
}

function extractSuggestionGroups(payload) {
  if (!payload) return [];
  
  // If already has groups structure, use it
  if (Array.isArray(payload.groups)) {
    return payload.groups.filter(g => g && Array.isArray(g.items) && g.items.length > 0);
  }
  
  // Get all items from various payload formats
  let items = [];
  if (Array.isArray(payload.items)) items = payload.items;
  else if (Array.isArray(payload.suggestions)) items = payload.suggestions;
  else if (Array.isArray(payload)) items = payload;
  
  if (items.length === 0) return [];
  
  // Group items by their primary reference (book+chapter)
  const groupMap = {};
  const groupOrder = [];
  
  items.forEach((item) => {
    const ref = item.ref || item.reference || '';
    // Extract primary reference (book + chapter, e.g., "Genesis 12" from "Genesis 12:4")
    const primaryRef = ref.split(':')[0].trim().toLowerCase();
    
    if (!groupMap[primaryRef]) {
      groupMap[primaryRef] = { id: primaryRef, items: [] };
      groupOrder.push(primaryRef);
    }
    
    // Add item to group (max 2 per group)
    if (groupMap[primaryRef].items.length < 2) {
      groupMap[primaryRef].items.push(item);
    }
  });
  
  // Return groups in order they were first seen
  return groupOrder.map(key => groupMap[key]);
}

function normalizeSuggestionItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.suggestions)) return payload.suggestions;
  if (Array.isArray(payload.groups)) {
    return payload.groups.flatMap((group) => group && Array.isArray(group.items) ? group.items : []);
  }
  if (payload.best && Array.isArray(payload.best)) return payload.best;
  return [];
}

function createSuggestionEmptyRow(message) {
  const placeholder = document.createElement('div');
  placeholder.className = 'ai-suggestion-card ai-suggestion-card-empty';
  placeholder.textContent = message;
  return placeholder;
}

function parseSuggestionReference(text) {
  if (!text) return null;
  const activeBooks = dynamicBibleMeta.bookNames.length ? dynamicBibleMeta.bookNames : BOOKS;
  if (typeof window !== 'undefined' && typeof window.parseReference === 'function') {
    const parsed = window.parseReference(text, activeBooks);
    if (parsed) {
      return {
        book: parsed.book,
        chapter: parsed.chapter || 1,
        verse: parsed.verse || 1,
        verseEnd: parsed.verseEnd || null
      };
    }
  }
  const match = text.trim().match(/^([1-3]?\s*[A-Za-z ]+)\s*(\d+)(?::(\d+))?(?:\s*-\s*(\d+))?/);
  if (!match) return null;
  const bookName = match[1].trim().toLowerCase();
  const resolvedBook = activeBooks.find((b) => b.toLowerCase().startsWith(bookName)) || match[1].trim();
  return {
    book: resolvedBook,
    chapter: parseInt(match[2], 10) || 1,
    verse: parseInt(match[3] || '1', 10),
    verseEnd: match[4] ? parseInt(match[4], 10) : null
  };
}

// Type a reference string into the verse search bar and trigger its input handler.
// Used by suggestion cards so the search box handles filtering/navigation for us.
function typeIntoSearchBar(text) {
  const searchInput = document.getElementById('search-autocomplete-input');
  if (!searchInput) return;
  searchInput.value = text;
  searchInput.focus();
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
}

// Build the best partial reference string to type from a parsed ref object + raw refText.
// Prefers the already-formatted refText; falls back to constructing from parsed parts.
function refTextForSearch(parsed, rawRefText) {
  if (rawRefText && rawRefText.trim()) return rawRefText.trim();
  if (!parsed) return '';
  let s = parsed.book || '';
  if (parsed.chapter != null) s += ` ${parsed.chapter}`;
  if (parsed.verse   != null) s += `:${parsed.verse}`;
  if (parsed.verseEnd != null && parsed.verseEnd !== parsed.verse) s += `-${parsed.verseEnd}`;
  return s.trim();
}

async function handleSuggestionCardDoubleClick(item) {
  if (!item) return;
  const refText = item.ref || item.reference;
  const parsed = parseSuggestionReference(refText);

  // For a complete book+chapter:verse reference, go live directly.
  if (parsed && parsed.book && parsed.chapter && parsed.verse) {
    const success = await selectReferenceRange(parsed);
    if (success) {
      safeStatus(`Loaded ${refText} — Going Live`);
      await handleVerseDoubleClick(selectedIndices);
      return;
    }
  }

  // Partial reference (book-only or book+chapter) — type into search bar so user can complete it.
  const searchText = refTextForSearch(parsed, refText);
  if (!searchText) { safeStatus('Unable to parse suggestion reference.'); return; }
  typeIntoSearchBar(searchText);
  safeStatus(`Searching for ${searchText}…`);
}

async function handleSuggestionCardClick(item) {
  if (!item) return;
  const refText = item.ref || item.reference;
  const parsed = parseSuggestionReference(refText);

  // Always type into the search bar — let the search box handle finding and highlighting.
  const searchText = refTextForSearch(parsed, refText);
  if (!searchText) { safeStatus('Unable to parse suggestion reference.'); return; }

  typeIntoSearchBar(searchText);
  safeStatus(`Searching for ${searchText}…`);
}

function isReferenceValid(ref) {
  if (!ref || !ref.book) return false;
  const book = ref.book.toLowerCase();

  // Prefer dynamic metadata derived from the currently loaded Bible.
  // Fall back to the hardcoded KJV constants only when no Bible has been loaded yet.
  const activeBookNames = dynamicBibleMeta.bookNames.length ? dynamicBibleMeta.bookNames : BOOKS;
  const activeChapterCounts = dynamicBibleMeta.bookNames.length ? dynamicBibleMeta.chapterCounts : CHAPTER_COUNTS;
  const activeVerseCounts   = dynamicBibleMeta.bookNames.length ? dynamicBibleMeta.verseCounts   : VERSE_COUNTS;

  const normalizedBook = activeBookNames.find((b) => b.toLowerCase() === book);
  if (!normalizedBook) return false;
  const maxChapter = activeChapterCounts[normalizedBook] || 0;
  if (!maxChapter || ref.chapter < 1 || ref.chapter > maxChapter) return false;

  if (typeof activeVerseCounts === 'object' && activeVerseCounts) {
    const verseCountsKey = `${normalizedBook} ${ref.chapter}`;
    const maxVerse = activeVerseCounts[verseCountsKey] || 0;
    if (maxVerse && (ref.verse < 1 || ref.verse > maxVerse)) return false;
    if (ref.verseEnd && maxVerse && ref.verseEnd > maxVerse) return false;
  }

  return true;
}

function renderAiSuggestionPayload(payload, ui, state) {
  if (!ui || !ui.list) return;
  
  state.lastPayload = payload;
  if (state.renderPending) return;
  state.renderPending = true;
  
  requestAnimationFrame(() => {
    state.renderPending = false;
    
    // Update hint visibility
    if (ui.context) {
      const hasSuggestions = state.enabled && state.suggestionGroups.length > 0;
      const hintText = state.enabled ? AI_HINT_MESSAGE : 'Enable Speech Recognition in Settings to resume suggestions.';
      if (state.lastHintHidden !== !hasSuggestions) {
        ui.context.textContent = hintText;
        ui.context.classList.toggle('ai-hint-hidden', hasSuggestions);
        state.lastHintHidden = !hasSuggestions;
      }
    }
    
    const wasEmpty = ui.list.children.length === 0;
    const scrollLeftBefore = ui.list.scrollLeft;
    let newGroupWidth = 0;
    
    // Skip if this payload has already been processed (avoid duplicates)
    if (payload && JSON.stringify(payload) === state.lastProcessedPayload) {
      return;
    }
    
    // Extract new items from payload and add to groups (preserve group structure)
    if (state.enabled && state.lastPayload) {
      // Mark this payload as processed
      if (state.lastPayload) {
        state.lastProcessedPayload = JSON.stringify(state.lastPayload);
      }
      const newGroups = extractSuggestionGroups(state.lastPayload);
      
      if (newGroups.length > 0) {
        const newGroup = newGroups[0];
        const newItems = newGroup.items || [];
        
        // Check if this is a refinement of the current (first) group
        const currentGroup = state.suggestionGroups.length > 0 ? state.suggestionGroups[0] : null;
        const currentItems = currentGroup && currentGroup.items ? currentGroup.items : [];
        
        const newPrimaryRef = newItems.length > 0 ? (newItems[0].ref || newItems[0].reference || '').toLowerCase() : '';
        const currentPrimaryRef = currentItems.length > 0 ? (currentItems[0].ref || currentItems[0].reference || '').toLowerCase() : '';
        
        // Check if new reference starts with current reference (e.g., "genesis" -> "genesis 12" -> "genesis 12:1")
        const isSameSuggestion = currentPrimaryRef && newPrimaryRef.startsWith(currentPrimaryRef.split(/[\s:]/)[0]);
        
        if (isSameSuggestion && currentGroup) {
          // Update the first group with refined items
          currentGroup.items = newItems;
        } else if (newPrimaryRef) {
          // New suggestion: queue it if hovering, otherwise prepend immediately
          if (state.isHovering) {
            // Check if this reference is already queued to avoid duplicates
            const alreadyQueued = state.pendingGroups.some(g => {
              const ref = (g.items && g.items[0] && (g.items[0].ref || g.items[0].reference)) || '';
              return ref.toLowerCase().split(/[\s:]/)[0] === newPrimaryRef.split(/[\s:]/)[0];
            });
            
            if (!alreadyQueued) {
              // Queue it to be added when unhover (prevents items shifting under cursor)
              state.pendingGroups.unshift(newGroup);
              // Show arrow when groups are queued
              if (state.arrowElement) {
                state.arrowElement.classList.add('visible');
              }
            }
          } else {
            // Not hovering, prepend immediately
            state.suggestionGroups.unshift(newGroup);
            state.newGroupCount++;
          }
        }
        
        // Keep total items under 20 by trimming groups from the end
        let totalItems = 0;
        let keepUpTo = 0;
        for (let i = 0; i < state.suggestionGroups.length; i++) {
          const itemsInGroup = (state.suggestionGroups[i].items || []).length;
          if (totalItems + itemsInGroup <= 20) {
            totalItems += itemsInGroup;
            keepUpTo = i + 1;
          } else {
            break;
          }
        }
        state.suggestionGroups = state.suggestionGroups.slice(0, keepUpTo);
      }
    }
    
    // Create a key to detect if we need to re-render
    const groupsKey = state.suggestionGroups.map(g => 
      (g.items || []).map(item => item.ref || item.reference || '').join(',')
    ).join('|');
    
    if (state.lastRenderedKey === groupsKey && ui.list.children.length > 0) return;
    state.lastRenderedKey = groupsKey;
    
    // Clear and rebuild list
    ui.list.innerHTML = '';
    if (!state.enabled) {
      return;
    }
    if (state.suggestionGroups.length === 0) {
      state.newGroupCount = 0;
      return;
    }
    
    // Render each group as a column (preserving group integrity)
    state.suggestionGroups.forEach((group, groupIdx) => {
      const groupColumn = document.createElement('div');
      groupColumn.className = 'ai-suggestion-group';
      

      
      // Only add animation to the first group if it's new
      if (groupIdx === 0 && !wasEmpty && state.newGroupCount > 0) {
        groupColumn.classList.add('ai-suggestion-group-new');
        // Remove the animation class after animation completes to prevent replay
        groupColumn.addEventListener('animationend', () => {
          groupColumn.classList.remove('ai-suggestion-group-new');
        }, { once: true });
      }
      
      // Render all items in this group (1 or 2, never mixing groups)
      const items = group.items || [];
      items.forEach((item) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'ai-suggestion-card';
        
        const isInvalid = !isReferenceValid(parseSuggestionReference(item.ref || item.reference));
        if (isInvalid) {
          card.classList.add('ai-suggestion-card-invalid');
          card.title = `Invalid verse: ${item.ref || item.reference}`;
        } else {
          card.title = item.ref || item.reference || 'Reference';
        }
        
        const ref = document.createElement('div');
        ref.className = 'ai-suggestion-ref';
        ref.textContent = item.ref || item.reference || 'Reference';
        card.appendChild(ref);
        
        card.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleSuggestionCardClick(item);
        });
        card.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleSuggestionCardDoubleClick(item);
        });
        
        groupColumn.appendChild(card);
      });
      
      ui.list.appendChild(groupColumn);
    });
    
    // Clear the new group counter after rendering
    if (state.newGroupCount > 0) {
      state.newGroupCount = 0;
    }
    
    // After adding new item, scroll to show it if not hovering
    if (!state.isHovering && !wasEmpty) {
      requestAnimationFrame(() => {
        // Scroll to the leftmost position to show the new item
        ui.list.scrollLeft = 0;
        startAutoScroll(ui, state);
      });
    }
    
    // Setup hover handlers on panel (only once)
    const panel = ui.list.closest('#ai-suggestion-panel');
    if (panel && !panel.hasHoverHandlers) {
      panel.hasHoverHandlers = true;
      
      panel.addEventListener('mouseenter', () => {
        state.isHovering = true;
        // Stop auto-scroll (but suggestions keep adding to beginning)
        if (state.autoScrollId) {
          cancelAnimationFrame(state.autoScrollId);
          state.autoScrollId = null;
        }
        // Show arrow ONLY if there are pending suggestions queued waiting to display
        const arrow = state.arrowElement || ui.list.previousElementSibling;
        if (arrow && arrow.classList.contains('ai-suggestion-arrow')) {
          if (state.pendingGroups.length > 0) {
            arrow.classList.add('visible');
          } else {
            arrow.classList.remove('visible');
          }
        }
      });
      
      panel.addEventListener('mouseleave', () => {
        state.isHovering = false;
        // Always hide arrow when leaving hover (never show outside of hover)
        const arrow = state.arrowElement || ui.list.previousElementSibling;
        if (arrow && arrow.classList.contains('ai-suggestion-arrow')) {
          arrow.classList.remove('visible');
        }
        
        // Add any queued groups that arrived while hovering
        if (state.pendingGroups.length > 0) {
          state.suggestionGroups.unshift(...state.pendingGroups);
          state.newGroupCount += state.pendingGroups.length;
          state.pendingGroups = [];
          // Force DOM re-render without re-processing the payload
          renderAiSuggestionPayload(null, ui, state);
        }
        
        // Smoothly scroll back to start and resume auto-scroll
        requestAnimationFrame(() => {
          smoothScrollToStart(ui, state);
        });
      });
    }
  });
}

function startAutoScroll(ui, state) {
  if (state.isHovering) return;
  if (state.autoScrollId) {
    cancelAnimationFrame(state.autoScrollId);
  }
  
  const scrollStep = () => {
    if (state.isHovering) {
      state.autoScrollId = null;
      return;
    }
    
    // Auto-scroll left (items move from right to left)
    ui.list.scrollLeft += 2;
    
    // Stop if we've reached near the end
    if (ui.list.scrollLeft >= ui.list.scrollWidth - ui.list.clientWidth - 10) {
      state.autoScrollId = null;
      return;
    }
    
    state.autoScrollId = requestAnimationFrame(scrollStep);
  };
  
  state.autoScrollId = requestAnimationFrame(scrollStep);
}

function smoothScrollToStart(ui, state) {
  if (!ui.list) return;
  
  const currentScroll = ui.list.scrollLeft;
  if (currentScroll === 0) {
    // Already at start, just resume auto-scroll
    startAutoScroll(ui, state);
    return;
  }
  
  const startTime = performance.now();
  const duration = 600; // 0.6s smooth scroll
  
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  
  const animate = (currentTime) => {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(progress);
    
    ui.list.scrollLeft = currentScroll * (1 - eased);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      ui.list.scrollLeft = 0;
      // Resume auto-scroll after reaching start
      startAutoScroll(ui, state);
    }
  };
  
  requestAnimationFrame(animate);
}

function initAiSuggestionPanel() {
  const panel = document.getElementById('ai-suggestion-panel');
  if (!panel) return;
  const ui = {
    panel,
    pill: document.getElementById('ai-suggestion-pill'),
    subtitle: document.getElementById('ai-suggestion-subtitle'),
    context: document.getElementById('ai-suggestion-context'),
    list: document.getElementById('ai-suggestion-list')
  };
  
  // Create the arrow element
  if (!ui.list.previousElementSibling || !ui.list.previousElementSibling.classList.contains('ai-suggestion-arrow')) {
    const arrow = document.createElement('div');
    arrow.className = 'ai-suggestion-arrow';
    arrow.textContent = '→';
    arrow.classList.remove('visible'); // Ensure it starts hidden
    ui.list.parentElement.insertBefore(arrow, ui.list);
    aiSuggestionState.arrowElement = arrow;
  } else {
    // Use existing arrow and cache it
    const existingArrow = ui.list.previousElementSibling;
    existingArrow.classList.remove('visible'); // Ensure it's hidden on init
    aiSuggestionState.arrowElement = existingArrow;
  }
  
  if (ui.context) {
    ui.context.textContent = AI_HINT_MESSAGE;
    ui.context.classList.remove('ai-hint-hidden');
  }

  if (!desktopRuntime || typeof desktopRuntime.onSuggestions !== 'function') {
    panel.classList.add('ai-suggestion-panel-disabled');
    if (ui.subtitle) ui.subtitle.textContent = 'Speech recognition unavailable in this window.';
    if (ui.pill) {
      ui.pill.textContent = 'Unavailable';
      ui.pill.classList.add('tone-err');
    }
    if (ui.list) {
      ui.list.appendChild(createSuggestionEmptyRow('AI runtime unavailable in this window.'));
    }
    return;
  }

  const addDisposer = (fn) => {
    if (typeof fn === 'function') {
      aiSuggestionState.disposers.push(fn);
    }
  };

  const applyStatus = (status = {}) => {
    const aiDisabled = typeof status.aiDisabled === 'boolean' ? status.aiDisabled : !aiSuggestionState.enabled;
    if (typeof status.aiDisabled === 'boolean') {
      aiSuggestionState.enabled = !status.aiDisabled;
    }
    const unavailable = status.statusMessage === 'sidecar-disabled';
    panel.classList.toggle('ai-suggestion-panel-disabled', aiDisabled || unavailable);
    if (ui.pill) {
      ui.pill.classList.remove('tone-ok', 'tone-warn', 'tone-err');
      let tone = 'tone-warn';
      let text = 'Starting';
      if (unavailable) {
        tone = 'tone-err';
        text = 'Unavailable';
      } else if (aiDisabled) {
        tone = 'tone-warn';
        text = 'Disabled';
      } else if (!status.portOpen) {
        tone = 'tone-err';
        text = 'Offline';
      } else if (status.modelReady) {
        tone = 'tone-ok';
        text = 'Ready';
      }
      ui.pill.textContent = text;
      ui.pill.classList.add(tone);
    }
    if (ui.subtitle) {
      if (aiDisabled) {
        ui.subtitle.textContent = 'Enable Speech Recognition in Settings to resume suggestions.';
      } else if (status.lastError) {
        ui.subtitle.textContent = status.lastError;
      } else if (status.statusMessage) {
        ui.subtitle.textContent = status.statusMessage.replace(/-/g, ' ');
      } else {
        ui.subtitle.textContent = 'Speech recognition warming up…';
      }
    }
  };

  desktopRuntime.getSidecarStatus().then(applyStatus).catch(() => {});
  if (typeof desktopRuntime.onSidecarStatus === 'function') {
    addDisposer(desktopRuntime.onSidecarStatus(applyStatus));
  }

  const renderPayload = (payload) => renderAiSuggestionPayload(payload, ui, aiSuggestionState);
  desktopRuntime.getLatestSuggestions().then(renderPayload).catch(() => {});
  addDisposer(desktopRuntime.onSuggestions(renderPayload));

  if (typeof desktopRuntime.getAiEnabled === 'function') {
    desktopRuntime.getAiEnabled().then((res) => {
      const enabled = (res && typeof res.enabled === 'boolean') ? res.enabled : !!res;
      aiSuggestionState.enabled = enabled;
      panel.classList.toggle('ai-suggestion-panel-disabled', !enabled);
      if (res && res.status) applyStatus(res.status);
      if (!enabled) {
        renderPayload({ clearContext: true });
      }
    }).catch(() => {});
  } else {
    panel.classList.toggle('ai-suggestion-panel-disabled', !aiSuggestionState.enabled);
  }

  if (typeof desktopRuntime.onAiEnabledChanged === 'function') {
    addDisposer(desktopRuntime.onAiEnabledChanged((enabled) => {
      aiSuggestionState.enabled = !!enabled;
      if (!enabled) {
        aiSuggestionState.groupQueue = [];
        aiSuggestionState.currentGroup = null;
      }
      panel.classList.toggle('ai-suggestion-panel-disabled', !enabled);
      if (!enabled) {
        renderPayload({ clearContext: true });
        if (ui.subtitle) ui.subtitle.textContent = 'Enable Speech Recognition in Settings to resume suggestions.';
      }
    }));
  }

  window.addEventListener('beforeunload', () => {
    aiSuggestionState.disposers.forEach((dispose) => { try { dispose && dispose(); } catch (_) {} });
    aiSuggestionState.disposers = [];
  }, { once: true });
}

let allVerses = [];
let allSongs = [];
let filteredSongs = []; // For search results
let lastRelayState = null;

function getCurrentLiveFields() {
  if (!liveMode) return { bible: [], songs: [] };
  return {
    bible: lastRelayState ? (lastRelayState.bible || []) : [],
    songs: lastRelayState ? (lastRelayState.songs || []) : []
  };
}

// The browser remote has two canvases.  Keep the selected preview separate
// from the currently-live content so the left pane never falls back to a copy
// of the right pane while a new verse or song is being prepared.
function getCurrentPreviewFields() {
  if (currentTab === 'verses' && selectedIndices.length) {
    const indices = selectedIndices.filter((index) => allVerses[index]);
    if (!indices.length) return { bible: [], songs: [] };
    const bible = parseVerseReferenceWithRange(indices.map((index) => allVerses[index].key));
    if (bible.length) {
      bible[0].text = indices.map((index) => {
        const verse = allVerses[index];
        return `${verse.key.split(':')[1]}  ${(verse.text || '').replace(/(\.\d+[\s\S]*)$/, '')}`;
      }).join('\n\n');
    }
    return { bible, songs: [] };
  }
  if (currentTab === 'songs' && selectedSongIndices.length && selectedSongVerseIndex !== null) {
    const song = allSongs[selectedSongIndices[0]];
    const verse = getSongVerseText(selectedSongVerseIndex);
    if (song && verse) return { bible: [], songs: [{ title: song.title, author: song.author || '', section: verse.section || '', text: verse.text || '', lyricIndex: selectedSongVerseIndex }] };
  }
  return { bible: [], songs: [] };
}

function buildBrowserRemoteState() {
  const state = {
    ...(lastRelayState || {}),
    ...getCurrentLiveFields(),
    preview: getCurrentPreviewFields(),
    scheduling: {
      totalItems: scheduleItems.length,
      currentItem: currentLiveScheduleIndex,
      hasSchedule: scheduleItems.length > 0
    },
    allScheduleItems: buildRelayAllScheduleItems(),
    allSongs: allSongs.map((song, index) => ({ index, title: song.title, author: song.author || '', lyrics: song.lyrics || [] })),
    verseMeta: { verseCounts: dynamicBibleMeta.verseCounts, bookNames: dynamicBibleMeta.bookNames },
    verseRefs: allVerses.map((verse, index) => ({ index, key: verse.key })),
    previewStyles: { ...previewStyles },
    lastUpdated: Date.now()
  };
  state.remoteCanvases = getRemoteCanvasSnapshots();
  return state;
}

async function pushBrowserRemoteState() {
  const state = buildBrowserRemoteState();
  lastRelayState = state;
  await ipcRenderer.invoke('relay-push-state', state);
}

// The LAN Browser Remote uses compact snapshots of the actual desktop canvases
// for its wide-screen Preview and Live panes. This keeps backgrounds, fonts,
// safe areas, and media rendering visually identical without sending full-size
// display frames to the cloud relay.
function getRemoteCanvasSnapshots() {
  const snapshot = (id) => {
    const source = document.getElementById(id);
    if (!source || !source.width || !source.height) return null;
    try {
      const maximumWidth = 1280;
      const scale = Math.min(1, maximumWidth / source.width);
      const target = document.createElement('canvas');
      target.width = Math.max(1, Math.round(source.width * scale));
      target.height = Math.max(1, Math.round(source.height * scale));
      target.getContext('2d').drawImage(source, 0, 0, target.width, target.height);
      return target.toDataURL('image/jpeg', 0.86);
    } catch (error) {
      console.warn('[remote] Could not snapshot', id, error.message || error);
      return null;
    }
  };
  return { preview: snapshot('preview-canvas'), live: snapshot('live-canvas') };
}

function buildRelayAllScheduleItems() {
  return scheduleItems.map((item, idx) => {
    if (item.type === 'verses') {
      const label = item.indices ? getScheduleItemLabel(item.indices) : 'Unknown';
      const subItems = item.indices ? item.indices.map(vi => ({
        label: allVerses[vi] ? allVerses[vi].key : String(vi),
        verseIndex: vi
      })) : [];
      return { index: idx, label, type: 'verses', subItems };
    } else if (item.type === 'song') {
      const song = item.songIndex !== undefined ? allSongs[item.songIndex] : null;
      const label = song ? song.title : 'Unknown Song';
      const subItems = song && song.lyrics ? song.lyrics.map((section, si) => ({
        label: section.section || ('Section ' + (si + 1)),
        sectionIndex: si,
        preview: section.text ? section.text.split('\n')[0].substring(0, 60) : ''
      })) : [];
      return { index: idx, label, type: 'song', songIndex: item.songIndex, subItems };
    } else if (item.type === 'media') {
      const media = item.mediaIndex !== undefined ? allMedia[item.mediaIndex] : null;
      const label = media ? (media.name || media.filename || 'Media') : 'Media';
      return { index: idx, label, type: 'media', subItems: [] };
    }
    return { index: idx, label: 'Item', type: item.type || 'unknown', subItems: [] };
  });
}

async function pushScheduleUpdate() {
  try {
    const allScheduleItems = buildRelayAllScheduleItems();
    const scheduling = {
      totalItems: scheduleItems.length,
      currentItem: currentLiveScheduleIndex,
      hasSchedule: scheduleItems.length > 0
    };
    const liveFields = getCurrentLiveFields();
    const state = lastRelayState ? {
      ...lastRelayState,
      ...liveFields,
      allScheduleItems,
      scheduling,
      lastUpdated: Date.now()
    } : {
      ...liveFields,
      schedule: [],
      scheduling,
      allScheduleItems,
      allSongs: allSongs.map((song, i) => ({
        index: i,
        title: song.title,
        author: song.author || '',
        lyrics: song.lyrics || []
      })),
      lastUpdated: Date.now()
    };
    state.remoteCanvases = getRemoteCanvasSnapshots();
    lastRelayState = state;
    await ipcRenderer.invoke('relay-push-state', state);
  } catch (err) {
    console.error('[relay] Failed to push schedule update:', err);
  }
}

// Safety stub for showPopover: queues calls if popover isn't initialized yet
if (typeof window !== 'undefined' && !window.showPopover) {
  const _showPopoverStub = function(name, key) {
    console.warn('showPopover called before popover initialized:', name, key);
    document.addEventListener('DOMContentLoaded', () => {
      // If real showPopover replaced the stub, call it
      if (window.showPopover && window.showPopover !== _showPopoverStub) {
        try { window.showPopover(name, key); } catch (e) { console.warn('Deferred showPopover failed', e); }
      }
    }, { once: true });
  };
  window.showPopover = _showPopoverStub;
}

let currentSearchQuery = ''; // Track current search query for highlighting
let selectedSongVerseIndex = null; // Track selected verse within a song
let selectedIndices = [];
let selectedSongIndices = [];
let currentTab = 'verses'; // 'verses' or 'songs'
let songVerseViewMode = 'full'; // 'full' or 'blocks' - controls how song is displayed
let anchorIndex = null;
let currentBibleFile = null; // e.g. 'en_kjv.json'
let secondaryBibleFile = null;    // secondary translation filename
let secondaryVerseMap = new Map(); // key → {key, text} for fast lookup
let dualTranslationEnabled = false;
let previewStyles = { verseNumber: '', verseText: '', verseReference: '', verseSubscript: '' };
let cachedDisplaySettings = {}; // Cache of settings.displaySettings for per-display style overrides
let liveMode = false;
let clearMode = false;
let blackMode = false;
let _websiteIsLive = false; // true while a website is the active live source
let _rememberedWidget = null;
window.__activeObsWidget = window.__activeObsWidget || {
  url: '',
  layout: null,
  visible: false,
  transitionOut: 'fade'
};
let _tutorialState = null;
let _tutorialPrompted = false;
let _tutorialSignedIn = false;

const TUTORIAL_TOPICS = {
  displays: {
    title: 'Displays',
    intro: 'Set up your preview/live outputs and network displays.',
    steps: [
      { title: 'Open display settings', body: 'Go to Settings and choose Displays to configure your output screens.' },
      { title: 'Enable a network display', body: 'Turn on the network display server for the screen you want to mirror.' },
      { title: 'Pick the target screen', body: 'Select the display you want Liturgia to send output to.' }
    ]
  },
  songs: {
    title: 'Songs',
    intro: 'Add songs and send them live.',
    steps: [
      { title: 'Open Songs', body: 'Use the Songs tab to manage and search your song library.' },
      { title: 'Add a song', body: 'Create or import a song, then save it to the library.' },
      { title: 'Go live', body: 'Select a song and press Go Live to display it.' }
    ]
  },
  bibles: {
    title: 'Bibles',
    intro: 'Load Bible versions and prepare verse service slides.',
    steps: [
      { title: 'Open Bible tools', body: 'Go to the Bible section and choose the version you want.' },
      { title: 'Import or select a Bible', body: 'Add the Bible translation you need for service.' },
      { title: 'Use verses live', body: 'Select verses and send them live just like a song.' }
    ]
  },
  widgets: {
    title: 'Widgets',
    intro: 'Create timers, alerts, and lower thirds.',
    steps: [
      { title: 'Add a widget', body: 'Use the media menu and choose Local OBS Widget.' },
      { title: 'Pick a type', body: 'Choose Timer, Lower Third, or Alert from the widget picker.' },
      { title: 'Use the tutorial preview', body: 'Edit placement, text, and transitions, then go live.' }
    ]
  },
  relay: {
    title: 'Relay',
    intro: 'Connect remote control and auth.',
    steps: [
      { title: 'Sign in', body: 'Use your account so the relay can authorize your session.' },
      { title: 'Start the relay', body: 'Make sure the websocket relay is running on the host.' },
      { title: 'Test remote control', body: 'Open the remote page or another device and verify it connects.' }
    ]
  }
};

const TUTORIAL_ONBOARDING = [
  { title: 'Welcome', body: 'This quick tour covers the minimum steps needed before a service.' },
  { title: 'Displays', body: 'Set up your preview, live, and any network displays first.' },
  { title: 'Songs and Bibles', body: 'Add at least one song and one Bible so you can send text live.' },
  { title: 'Ready to go live', body: 'After that, you can use widgets, media, and the remote features as needed.' }
];

function _syncWidgetButtonVisibility() {
  const widgetBtn = document.getElementById('lower-third-btn');
  if (!widgetBtn) return;
  const hasWidget = !!(_rememberedWidget && _rememberedWidget.url);
  widgetBtn.style.display = hasWidget ? '' : 'none';
  if (!hasWidget) {
    widgetBtn.classList.remove('active');
    widgetBtn.textContent = 'Widget';
    return;
  }
  if (window.__activeObsWidget && window.__activeObsWidget.visible) {
    widgetBtn.textContent = 'Widget: On';
    widgetBtn.classList.add('active');
  } else {
    widgetBtn.textContent = 'Widget';
    widgetBtn.classList.remove('active');
  }
}
let keybinds = {}; // Loaded from settings

// Refresh keybinds whenever settings are saved from the settings window
ipcRenderer.on('settings-updated', (event, data) => {
  if (data && data.keybinds) {
    const defaultKeybinds = {
      'next-verse': 'ArrowRight',
      'prev-verse': 'ArrowLeft',
      'go-live': 'Enter',
      'focus-search': 'Ctrl+f',
      'toggle-clear': '',
      'toggle-black': '',
    };
    keybinds = { ...defaultKeybinds, ...data.keybinds };
  }
});

// Listen for import notifications from main process
ipcRenderer.on('songs-imported', (event, info) => {
  const added  = info && info.addedCount ? info.addedCount : 0;
  const total  = info && info.totalFound ? info.totalFound : 0;
  const source = (info && info.source) || 'easyworship';
  const label  = source === 'videopsalm' ? 'VideoPsalm' : 'EasyWorship';
  // Use a non-blocking in-app toast instead of alert() — native alert() causes
  // Electron on Windows to lose pointer focus on the BrowserWindow, making the
  // UI unresponsive until the app is restarted.
  const _t = document.createElement('div');
  _t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0078d4;color:#fff;padding:10px 20px;border-radius:6px;font-size:13px;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,0.35);pointer-events:none;white-space:nowrap;';
  _t.textContent = `${label}: found ${total} song(s), imported ${added} new song(s).`;
  document.body.appendChild(_t);
  setTimeout(() => { try { document.body.removeChild(_t); } catch (e) {} }, 4000);
  // Refresh songs list from disk
  loadSongs();
});

ipcRenderer.on('easyworship-import-disabled', (event, info) => {
  if (info && info.reason === 'sql-missing') {
    alert('EasyWorship import is disabled: sql.js is not installed. Run "npm install" in the app directory and restart.');
  } else {
    alert('EasyWorship import is disabled.');
  }
});
let scheduleItems = []; // Array of { indices: [], expanded: false, selectedVerses: [] }
let selectedScheduleItems = []; // Indices of selected schedule items for multi-select
let currentLiveScheduleIndex = null; // Track which schedule item is currently being displayed live
let anchorScheduleIndex = null; // For shift-click range selection
let focusedScheduleItem = null; // { type: 'header'|'verse', itemIndex: number, verseIndex?: number }
let allMedia = []; // Media files
let selectedMediaIndex = null; // Currently selected media item
let defaultBackgrounds = { songs: null, verses: null }; // Default background images

// Load settings on startup and apply dark theme if needed
async function loadAndApplySettings() {
  const settings = await ipcRenderer.invoke('load-settings');
  if (settings && settings.darkTheme) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
  if (settings && settings.previewStyles) {
    previewStyles = settings.previewStyles;
    applyPreviewStyles();
  }
  if (settings && settings.displaySettings) {
    cachedDisplaySettings = settings.displaySettings;
  }
  if (settings && settings.tutorialState) {
    _tutorialState = settings.tutorialState;
  }
  // Load keybinds with defaults
  const defaultKeybinds = {
    'next-verse': 'ArrowRight',
    'prev-verse': 'ArrowLeft',
    'go-live': 'Enter',
    'focus-search': 'Ctrl+f',
    'toggle-clear': '',
    'toggle-black': '',
    'select-chorus-1': 'Alt+c',
    'select-verse-1': 'Alt+1',
    'select-verse-2': 'Alt+2',
    'select-verse-3': 'Alt+3',
    'select-verse-4': 'Alt+4',
    'select-verse-5': 'Alt+5',
    'select-verse-6': 'Alt+6',
    'select-verse-7': 'Alt+7',
    'select-verse-8': 'Alt+8',
    'select-verse-9': 'Alt+9',
    'select-chorus-2': '',
    'select-chorus-3': '',
    'select-chorus-4': '',
    'select-chorus-5': '',
    'select-chorus-6': '',
    'select-chorus-7': '',
    'select-chorus-8': '',
    'select-chorus-9': ''
  };
  keybinds = { ...defaultKeybinds, ...(settings.keybinds || {}) };
  console.log('[renderer] Keybinds loaded:', keybinds);
  // Restore dual translation state — file is loaded after initScripture.
  if (settings && settings.secondaryBibleFile) secondaryBibleFile = settings.secondaryBibleFile;
  if (settings && settings.dualTranslationEnabled !== undefined) dualTranslationEnabled = !!settings.dualTranslationEnabled;
}

function applyPreviewStyles() {
  // Create/update a style tag for global preview CSS
  const styleId = 'preview-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  let css = '';
  if (previewStyles.verseNumber) css += `#verse-number { ${atob(previewStyles.verseNumber)} }\n`;
  if (previewStyles.verseText) css += `#verse-text { ${atob(previewStyles.verseText)} }\n`;
  if (previewStyles.verseReference) css += `#verse-reference { ${atob(previewStyles.verseReference)} }\n`;
  if (previewStyles.verseSubscript) css += `.verse-num { ${atob(previewStyles.verseSubscript)} }\n`;
  // Song preview styles
  if (previewStyles.songTitle) css += `#song-title { ${atob(previewStyles.songTitle)} }\n`;
  if (previewStyles.songText) css += `#song-text { ${atob(previewStyles.songText)} }\n`;
  if (previewStyles.songReference) css += `#song-reference { ${atob(previewStyles.songReference)} }\n`;
  styleEl.textContent = css;

  // Also apply inline styles to any existing preview/live elements (keeps both behaviors)
  Object.keys(previewStyles).forEach(key => {
    const el = document.getElementById(key.toLowerCase().replace('verse', ''));
    if (el && previewStyles[key]) {
      el.style.cssText = atob(previewStyles[key]);
    }
  });
  Object.keys(previewStyles).forEach(key => {
    const liveEl = document.getElementById('live-' + key.toLowerCase().replace('verse', ''));
    if (liveEl && previewStyles[key]) {
      liveEl.style.cssText = atob(previewStyles[key]);
    }
  });
}

// Parse base64-encoded CSS and return allowed canvas style properties
function parseCanvasStyleFromB64(b64) {
  if (!b64) return {};
  try {
    const css = decodeURIComponent(escape(atob(b64)));
    const get  = (re) => { const m = css.match(re); return m ? m[1].trim() : null; };
    const getN = (re, d=0) => { const m = css.match(re); return m ? parseFloat(m[1]) : d; };
    return {
      color:          get(/\bcolor\s*:\s*([^;]+)/i),
      sizeMultiplier: (() => { const m = css.match(/font-size\s*:\s*([\d.]+)em/i); return m ? parseFloat(m[1]) : null; })(),
      fontFamily:     get(/font-family\s*:\s*([^;]+)/i) || 'Arial',
      fontWeight:     get(/font-weight\s*:\s*(bold)/i) ? 'bold' : null,
      fontStyle:      get(/font-style\s*:\s*(italic)/i) ? 'italic' : null,
      letterSpacing:  getN(/letter-spacing\s*:\s*([\d.]+)/i),
      textAlign:      get(/text-align\s*:\s*([^;]+)/i) || 'center',
      shadowColor:    get(/shadow-color\s*:\s*([^;]+)/i) || '#000000',
      shadowBlur:     getN(/shadow-blur\s*:\s*([\d.]+)/i),
      shadowX:        getN(/shadow-x\s*:\s*(-?[\d.]+)/i),
      shadowY:        getN(/shadow-y\s*:\s*(-?[\d.]+)/i),
      strokeColor:    get(/stroke-color\s*:\s*([^;]+)/i) || '#000000',
      strokeWidth:    getN(/stroke-width\s*:\s*([\d.]+)/i),
    };
  } catch (e) { return {}; }
}

function parseGlobalStyleFromB64(b64) {
  const def = { overlayOpacity: 0.4, bgBlur: 0, lineHeight: 1.2, verticalPosition: 'center', safeArea: { x: 0.04, y: 0.04, w: 0.92, h: 0.92 }, songInline: false };
  if (!b64) return def;
  try {
    const css = decodeURIComponent(escape(atob(b64)));
    const getN = (re, d) => { const m = css.match(re); return m ? parseFloat(m[1]) : d; };
    const getS = (re, d) => { const m = css.match(re); return m ? m[1].trim() : d; };
    return {
      overlayOpacity:   getN(/overlay-opacity\s*:\s*([\d.]+)/i, 0.4),
      bgBlur:           getN(/bg-blur\s*:\s*([\d.]+)/i, 0),
      lineHeight:       getN(/line-height\s*:\s*([\d.]+)/i, 1.2),
      verticalPosition: getS(/vertical-position\s*:\s*([^;]+)/i, 'center'),
      safeArea: {
        x: getN(/safe-area-x\s*:\s*([\d.]+)/i, 0.04),
        y: getN(/safe-area-y\s*:\s*([\d.]+)/i, 0.04),
        w: getN(/safe-area-w\s*:\s*([\d.]+)/i, 0.92),
        h: getN(/safe-area-h\s*:\s*([\d.]+)/i, 0.92),
      },
      songInline: /song-inline\s*:\s*1/.test(css),
    };
  } catch { return def; }
}

function getCanvasStylesFor(type) {
  // type: 'verse' or 'song'
  const map = {};
  if (type === 'verse') {
    map.text      = parseCanvasStyleFromB64(previewStyles.verseText);
    map.number    = parseCanvasStyleFromB64(previewStyles.verseNumber);
    map.reference = parseCanvasStyleFromB64(previewStyles.verseReference);
    map.subscript = parseCanvasStyleFromB64(previewStyles.verseSubscript);
  } else {
    map.text      = parseCanvasStyleFromB64(previewStyles.songText      || previewStyles.verseText);
    map.title     = parseCanvasStyleFromB64(previewStyles.songTitle     || previewStyles.verseNumber);
    map.reference = parseCanvasStyleFromB64(previewStyles.songReference || previewStyles.verseReference);
    map.subscript = parseCanvasStyleFromB64(previewStyles.verseSubscript);
  }
  map.global = parseGlobalStyleFromB64(previewStyles.global);
  return map;
}

// Build a { [displayId]: parsedStyles } map for per-display style overrides.
// Returns null if no display has per-display styles enabled.
function getPerDisplayStyleOverrides(type) {
  const overrides = {};
  for (const [displayId, ds] of Object.entries(cachedDisplaySettings)) {
    if (!ds || !ds.perDisplayStylesEnabled || !ds.perDisplayStyles) continue;
    const raw = ds.perDisplayStyles;
    const parsed = {};
    if (type === 'verse') {
      if (raw.verseText)      parsed.text      = parseCanvasStyleFromB64(raw.verseText);
      if (raw.verseNumber)    parsed.number    = parseCanvasStyleFromB64(raw.verseNumber);
      if (raw.verseReference) parsed.reference = parseCanvasStyleFromB64(raw.verseReference);
      if (raw.verseSubscript) parsed.subscript = parseCanvasStyleFromB64(raw.verseSubscript);
    } else {
      const t = raw.songText      || raw.verseText;
      const r = raw.songReference || raw.verseReference;
      if (t) parsed.text      = parseCanvasStyleFromB64(t);
      if (r) parsed.reference = parseCanvasStyleFromB64(r);
      if (raw.verseSubscript) parsed.subscript = parseCanvasStyleFromB64(raw.verseSubscript);
    }
    if (raw.global) parsed.global = parseGlobalStyleFromB64(raw.global);
    if (Object.keys(parsed).length > 0) overrides[String(displayId)] = parsed;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

// -----------------------------------------------------------------------
// Text Styling Modal
// -----------------------------------------------------------------------

function _tsGetColor(key) {
  // Extract hex color from base64-encoded CSS in previewStyles[key]
  if (!previewStyles[key]) return null;
  try {
    const css = atob(previewStyles[key]);
    const m = css.match(/color\s*:\s*([^;]+)\s*;?/i);
    if (!m) return null;
    const raw = m[1].trim();
    // Return as hex — for named/rgb colors, create element to convert
    if (raw.startsWith('#') && (raw.length === 4 || raw.length === 7)) return raw;
    const el = document.createElement('div');
    el.style.color = raw;
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color;
    document.body.removeChild(el);
    const rgb = computed.match(/\d+/g);
    if (!rgb) return null;
    return '#' + rgb.map(v => parseInt(v).toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}

function _tsGetSize(key) {
  // Extract font-size em string from base64 CSS (e.g. "0.6em"), or "" if not set
  if (!previewStyles[key]) return '';
  try {
    const css = atob(previewStyles[key]);
    const m = css.match(/font-size\s*:\s*(\d*\.?\d+em)/i);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function _tsSetStyle(key, colorHex, sizeEm) {
  // Build CSS string and store base64-encoded in previewStyles
  let css = '';
  if (colorHex) css += `color: ${colorHex}; `;
  if (sizeEm) css += `font-size: ${sizeEm}; `;
  css = css.trim();
  if (css) {
    previewStyles[key] = btoa(css);
  } else {
    delete previewStyles[key];
  }
}

function rerenderPreviewForStyles() {
  // Re-render the preview (left) canvas with current styles applied.
  // Prefer previewContent (last updatePreview call) but fall back to currentContent.
  const type = currentTab === 'songs' ? 'song' : 'verse';
  const newStyles = getCanvasStylesFor(type);

  const previewCanvas = document.getElementById('preview-canvas');
  const previewSrc = window.previewContent || window.currentContent;
  if (previewCanvas && previewSrc) {
    const updatedPreview = { ...previewSrc, styles: newStyles };
    renderToCanvas(previewCanvas, updatedPreview, updatedPreview.width || 1920, updatedPreview.height || 1080);
  }

  // Also update the live canvas (right preview) and push to the actual live window
  if (window.currentContent) {
    const updatedLive = { ...window.currentContent, styles: newStyles };
    const _displayStyleOverrides = getPerDisplayStyleOverrides(type);
    if (_displayStyleOverrides) updatedLive._displayStyleOverrides = _displayStyleOverrides;
    const liveCanvas = document.getElementById('live-canvas');
    if (liveCanvas) {
      if (blackMode) {
        const lctx = liveCanvas.getContext('2d');
        liveCanvas.width  = updatedLive.width  || 1920;
        liveCanvas.height = updatedLive.height || 1080;
        lctx.fillStyle = '#000';
        lctx.fillRect(0, 0, liveCanvas.width, liveCanvas.height);
      } else if (clearMode) {
        const noText = { ...updatedLive, number: '', text: '', reference: '', secondaryText: '', secondaryRef: '' };
        renderToCanvas(liveCanvas, noText, noText.width || 1920, noText.height || 1080);
      } else {
        renderToCanvas(liveCanvas, updatedLive, updatedLive.width || 1920, updatedLive.height || 1080);
      }
    }
    // Push updated styles to the live window if it is open
    if (liveMode) {
      ipcRenderer.send('update-live-window', updatedLive);
    }
  }
}

function openTextStyleModal() {
  const content = window.previewContent || window.currentContent || null;
  const isDark = document.body.classList.contains('dark-theme');
  // Capture background-only snapshot (no text) for video/GIF backgrounds
  let bgSnapshot = null;
  const media = content && content.backgroundMedia;
  if (media && (media.type === 'GIF' || ['MP4','WEBM','OGG','MOV','AVI'].includes(media.type))) {
    try {
      const pc = document.getElementById('preview-canvas');
      const src = pc && pc._bgSource;
      if (src && (src.tagName === 'IMG' ? (src.complete && src.naturalWidth > 0) : src.readyState >= 2)) {
        const off = document.createElement('canvas');
        off.width = pc.width;
        off.height = pc.height;
        const octx = off.getContext('2d');
        octx.drawImage(src, 0, 0, off.width, off.height);
        bgSnapshot = off.toDataURL('image/jpeg', 0.85);
      }
    } catch (e) {}
  }
  ipcRenderer.send('open-style-window', {
    previewStyles: { ...previewStyles },
    content: content ? { ...content } : null,
    darkMode: isDark,
    bgSnapshot
  });
}

function setupTextStyleModal() {
  // Style editing is now a BrowserWindow (style-window.html).
  // This function registers the global opener and the 'styles-updated' listener
  // so the main renderer refreshes when the user changes something in the style window.
  window.openTextStyleModal = openTextStyleModal;

  ipcRenderer.on('styles-updated', (event, newStyles) => {
    // Full replacement for the keys the style window manages —
    // clear them first so a Reset All (which sends {}) correctly removes overrides.
    ['verseText', 'verseNumber', 'verseSubscript', 'verseReference', 'songText', 'songTitle', 'songReference', 'global'].forEach(k => delete previewStyles[k]);
    Object.keys(newStyles).forEach(k => {
      if (newStyles[k]) previewStyles[k] = newStyles[k];
    });
    applyPreviewStyles();
    rerenderPreviewForStyles();
  });

  ipcRenderer.on('display-styles-updated', (event, { displayId, styles }) => {
    cachedDisplaySettings[String(displayId)] = cachedDisplaySettings[String(displayId)] || {};
    cachedDisplaySettings[String(displayId)].perDisplayStyles = styles;
  });

  ipcRenderer.on('display-setting-changed', (event, { displayId, key, value }) => {
    cachedDisplaySettings[String(displayId)] = cachedDisplaySettings[String(displayId)] || {};
    cachedDisplaySettings[String(displayId)][key] = value;
  });
}

function setupPopover() {
  // Ensure popover DOM elements exist; if not, defer initialization until DOMContentLoaded
  const popover = document.getElementById('css-popover');
  const textarea = document.getElementById('css-textarea');
  const cssSelect = document.getElementById('css-select');
  const saveBtn = document.getElementById('css-save');
  const cancelBtn = document.getElementById('css-cancel');
  const errorDiv = document.getElementById('css-error');

  if (!popover || !textarea || !cssSelect || !saveBtn || !cancelBtn || !errorDiv) {
    console.warn('setupPopover: popover elements missing, deferring until DOMContentLoaded');
    document.addEventListener('DOMContentLoaded', () => {
      try { setupPopover(); } catch (e) { console.warn('setupPopover retry failed', e); }
    }, { once: true });
    return;
  }

  let currentElement = null;
  let _triggersAttached = false;
  function attachPopoverTriggers(retries = 6) {
    if (_triggersAttached) return;
    const vn = document.getElementById('verse-number');
    const vt = document.getElementById('verse-text');
    const vr = document.getElementById('verse-reference');
    if (vn || vt || vr) {
      if (vn) vn.addEventListener('click', () => showPopover('Verse Number', 'verseNumber'));
      if (vt) vt.addEventListener('click', () => showPopover('Verse Text', 'verseText'));
      if (vr) vr.addEventListener('click', () => showPopover('Verse Reference', 'verseReference'));
      _triggersAttached = true;
      return;
    }
    if (retries > 0) {
      // Retry after a short delay to allow UI to render
      setTimeout(() => attachPopoverTriggers(retries - 1), 250);
    } else {
      console.warn('attachPopoverTriggers: could not find trigger elements after retries — falling back to MutationObserver');
      // Fallback: observe DOM mutations and attach listeners when elements appear
      try {
        const observer = new MutationObserver((mutations, obs) => {
          const vn2 = document.getElementById('verse-number');
          const vt2 = document.getElementById('verse-text');
          const vr2 = document.getElementById('verse-reference');
          if (vn2 || vt2 || vr2) {
            if (vn2) vn2.addEventListener('click', () => showPopover('Verse Number', 'verseNumber'));
            if (vt2) vt2.addEventListener('click', () => showPopover('Verse Text', 'verseText'));
            if (vr2) vr2.addEventListener('click', () => showPopover('Verse Reference', 'verseReference'));
            _triggersAttached = true;
            obs.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      } catch (obsErr) {
        console.warn('attachPopoverTriggers: MutationObserver fallback failed', obsErr);
      }
    }
  }
  // Attempt to attach immediately
  attachPopoverTriggers();

  function showPopover(name, key) {
    currentElement = key;
    document.getElementById('css-element-name').textContent = name;
    if (key === 'verseReference') {
      textarea.style.display = 'none';
      cssSelect.style.display = 'block';
      const currentCSS = previewStyles[key] ? atob(previewStyles[key]) : '';
      const fontSizeMatch = currentCSS.match(/font-size:\s*(\d*\.?\d+)em/);
      if (fontSizeMatch) {
        const size = parseFloat(fontSizeMatch[1]);
        if (size <= 0.7) cssSelect.value = 'small';
        else if (size <= 0.9) cssSelect.value = 'medium';
        else cssSelect.value = 'large';
      } else {
        cssSelect.value = 'medium'; // default
      }
    } else {
      cssSelect.style.display = 'none';
      textarea.style.display = 'block';
      textarea.value = previewStyles[key] ? atob(previewStyles[key]) : '';
    }
    errorDiv.textContent = '';
    popover.style.display = 'block';
  }

  // Expose showPopover globally so external UI (menus/buttons) can call it
  window.showPopover = showPopover;

  saveBtn.addEventListener('click', async () => {
    let css = '';
    if (currentElement === 'verseReference') {
      const sizeMap = { small: '0.6em', medium: '0.8em', large: '1.0em' };
      css = `font-size: ${sizeMap[cssSelect.value]};`;
    } else {
      css = textarea.value.trim();
      if (!validateCSS(css)) {
        errorDiv.textContent = 'Invalid CSS syntax.';
        return;
      }
      // Remove font-size and related properties to prevent overriding scaling
      css = css.replace(/font-size\s*:\s*[^;]+;?/gi, '');
      css = css.replace(/font\s*:\s*[^;]+;?/gi, '');
      css = css.replace(/line-height\s*:\s*[^;]+;?/gi, '');
    }
    if (css.trim() === '') {
      delete previewStyles[currentElement];
    } else {
      previewStyles[currentElement] = btoa(css);
    }
    applyPreviewStyles();
    await ipcRenderer.invoke('update-settings', { previewStyles });
    popover.style.display = 'none';
  });

  cancelBtn.addEventListener('click', () => {
    popover.style.display = 'none';
  });
}

function validateCSS(css) {
  // Simple validation: check for balanced quotes, no invalid chars
  try {
    // Try to parse as CSS
    const testEl = document.createElement('div');
    testEl.style.cssText = css;
    return true;
  } catch {
    return false;
  }
}

function toggleClear() {
  if (_websiteIsLive) {
    if (clearMode) {
      // Un-clear while website is source: restore mirror
      clearMode = false;
      if (window.clearButton) window.clearButton.classList.remove('active');
      ipcRenderer.send('update-live-window', { isWebsite: true });
      startWebsiteMirror();
      return;
    }
    if (blackMode) {
      // Black → Clear: live window already has BG content, just switch mode
      blackMode = false; clearMode = true;
      if (window.blackButton) window.blackButton.classList.remove('active');
      if (window.clearButton) window.clearButton.classList.add('active');
      ipcRenderer.send('set-live-mode', 'clear');
      return;
    }
    // Entering clear from website: stop mirror polling (keeps audio), fall through to normal
    _mirrorActive = false;
    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
  }
  // If black mode is active, switch directly to clear on the live window (avoid flashing normal)
  if (blackMode) {
    blackMode = false;
    clearMode = true;

    // Update button states
    if (window.blackButton) window.blackButton.classList.remove('active');
    if (window.clearButton) window.clearButton.classList.add('active');

    // Update preview to show background without text
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        const width = window.currentContent.width;
        const height = window.currentContent.height;
        const contentWithoutText = { ...window.currentContent, number: '', text: '', reference: '', secondaryText: '', secondaryRef: '' };
        renderToCanvas(liveCanvas, contentWithoutText, width, height);
      }
    }

    // Directly instruct live window to enter clear mode
    ipcRenderer.send('set-live-mode', 'clear');
    return;
  }

  clearMode = !clearMode;

  // Update button state
  if (window.clearButton) {
    if (clearMode) {
      window.clearButton.classList.add('active');
    } else {
      window.clearButton.classList.remove('active');
    }
  }

  if (clearMode) {
    // Update preview to show background without text
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        const width = window.currentContent.width;
        const height = window.currentContent.height;
        const contentWithoutText = { ...window.currentContent, number: '', text: '', reference: '', secondaryText: '', secondaryRef: '' };
        renderToCanvas(liveCanvas, contentWithoutText, width, height);
      }
    }
    // Tell live window to enter clear mode
    ipcRenderer.send('set-live-mode', 'clear');
  } else {
    // Turn off clear: restore preview and tell live window to return to normal
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) renderToCanvas(liveCanvas, window.currentContent, window.currentContent.width, window.currentContent.height);
    }
    ipcRenderer.send('set-live-mode', 'normal');
  }
}

function clearLiveText() {
  const liveNumber = document.getElementById('live-number');
  const liveText = document.getElementById('live-text');
  const liveReference = document.getElementById('live-reference');
  if (liveNumber) liveNumber.style.display = 'none';
  if (liveText) liveText.style.display = 'none';
  if (liveReference) liveReference.style.display = 'none';
}

function showLiveText() {
  const liveNumber = document.getElementById('live-number');
  const liveText = document.getElementById('live-text');
  const liveReference = document.getElementById('live-reference');
  if (liveNumber) liveNumber.style.display = '';
  if (liveText) liveText.style.display = '';
  if (liveReference) liveReference.style.display = '';
}

function setLiveBackground(color) {
  const bg = color === 'black' ? '#000' : '#000'; // already black
  document.getElementById('live-container').style.background = bg;
}

function resetLiveCanvas() {
  showLiveText();
  setLiveBackground('default');
}

// Listen for dark theme changes from settings window
ipcRenderer.on('set-dark-theme', (event, enabled) => {
  if (enabled) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
});

// Notify user when an update is available (sent from main on startup or when detected)
ipcRenderer.on('update-available', (event, res) => {
  try {

    // If the DOM isn't ready yet (rare), request any pending update from main
    function ensureAndHandle(info) {
      try {
        if (!info) return;
        function createInlineUpdateNotice(info, targetCard) {
          // Add a compact update notice into the given container (e.g., setup modal) to avoid overlapping UI
          const existing = targetCard.querySelector('.inline-update-notice');
          if (existing) return existing;
          const note = document.createElement('div');
          note.className = 'inline-update-notice';
          note.style.marginTop = '8px';
          note.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="flex:1">Update available: <strong>${info.latest||''}</strong></div>
              <div style="display:flex;gap:8px">
                <button class="btn small" data-action="open-release">Open Release</button>
                <button class="btn small primary" data-action="download">Download</button>
              </div>
            </div>
            <div class="inline-progress" style="margin-top:8px;display:none">
              <div class="progress"><div class="progress-inner" style="width:0%"></div></div>
              <div style="margin-top:6px;font-size:12px;color:var(--muted,#666);" class="inline-progress-text">0%</div>
            </div>
          `;
          targetCard.appendChild(note);

          note.querySelector('[data-action="open-release"]').onclick = () => { require('electron').shell.openExternal(info.html_url); };
          const downloadBtn = note.querySelector('[data-action="download"]');
          const inlineProgress = note.querySelector('.inline-progress');
          const progressInner = note.querySelector('.progress-inner');
          const progressText = note.querySelector('.inline-progress-text');
          let currentFile = null;
          let downloading = false;
          downloadBtn.onclick = async () => {
            if (downloading) return;
            const asset = (info.assets || []).find(a => a.name && a.name.endsWith('.exe')) || (info.assets && info.assets[0]);
            if (!asset || !asset.url) { alert('No downloadable installer found for this platform.'); return; }
            downloading = true;
            inlineProgress.style.display = 'block';
            downloadBtn.disabled = true;
            try {
              const res = await ipcRenderer.invoke('download-update', { url: asset.url });
              if (res && res.ok && res.file) {
                currentFile = res.file;
                progressInner.style.width = '100%';
                progressText.textContent = 'Download complete';
                downloadBtn.textContent = 'Run';
                downloadBtn.disabled = false;
                downloadBtn.onclick = async () => { await ipcRenderer.invoke('run-installer', currentFile); };
              } else {
                alert('Download failed: ' + (res && res.error));
                downloadBtn.disabled = false;
                downloading = false;
              }
            } catch (e) {
              alert('Download failed: ' + e);
              downloadBtn.disabled = false;
              downloading = false;
            }
          };

          ipcRenderer.on('update-download-progress', (ev, p) => {
            if (p && p.file) {
              const percent = p.percent || (p.total ? Math.round(p.downloaded / p.total * 100) : 0);
              progressInner.style.width = (percent || 0) + '%';
              progressText.textContent = (percent ? percent + '%' : `${Math.round((p.downloaded || 0) / 1024)} KB`);
            }
          });

          return note;
        }

        // If the setup/login modal is open, attach an inline update notice there instead of creating a new modal
        const setupModal = document.getElementById('setup-modal');
        if (setupModal) {
          const card = setupModal.querySelector('.setup-card');
          if (card) {
            createInlineUpdateNotice(info, card);
            return;
          }
        }

        function createUpdateModal(info) {
          if (document.getElementById('update-modal')) return;
          const modal = document.createElement('div');
          modal.id = 'update-modal';
          modal.className = 'update-overlay';

          // Build changelog HTML: all versions newer than current, or fall back to latest body.
          let changelogHtml = '';
          const entries = (info.changelog && info.changelog.length) ? info.changelog
            : (info.body ? [{ version: info.latest || '', body: info.body }] : []);
          if (entries.length) {
            changelogHtml = entries.map(e => {
              const lines = (e.body || '').trim().split('\n')
                .map(l => l.trim()).filter(Boolean)
                .map(l => `<div class="update-cl-line">${l.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`)
                .join('');
              return `<div class="update-cl-version">${e.version.replace(/</g,'&lt;')}</div>${lines}`;
            }).join('');
          }

          modal.innerHTML = `
            <div class="setup-card">
              <h2>Update available: ${info.latest || ''}</h2>
              <div class="update-changelog-wrap">
                <div class="update-changelog-scroll">${changelogHtml || '<div style="color:var(--muted,#888)">No release notes.</div>'}</div>
              </div>
              <div style="margin-top:12px;display:flex;gap:8px;">
                <button id="update-open-release" class="btn">Open Release Page</button>
                <button id="update-download" class="btn primary">Download &amp; Install</button>
                <button id="update-dismiss" class="btn">Dismiss</button>
              </div>
              <div id="update-progress">
                <div class="progress"><div class="progress-inner" style="width:0%"></div></div>
                <div style="display:flex;justify-content:space-between;margin-top:6px;"><span id="update-progress-text">0%</span><button id="update-cancel" class="btn">Cancel</button></div>
              </div>
            </div>
          `;
          document.body.appendChild(modal);
          document.getElementById('update-open-release').onclick = () => { require('electron').shell.openExternal(info.html_url); };
          document.getElementById('update-dismiss').onclick = () => { modal.remove(); };

          const downloadBtn = document.getElementById('update-download');
          const progressEl = document.getElementById('update-progress');
          const progressBar = modal.querySelector('.progress-inner');
          const progressText = document.getElementById('update-progress-text');
          let currentFile = null;
          let downloading = false;
          downloadBtn.onclick = async () => {
            if (downloading) return;
            const asset = (info.assets || []).find(a => a.name && a.name.endsWith('.exe')) || (info.assets && info.assets[0]);
            if (!asset || !asset.url) { alert('No downloadable installer found for this platform.'); return; }
            downloading = true;
            // Use rAF so the element is in the DOM at max-height:0 before we add .visible
            requestAnimationFrame(() => requestAnimationFrame(() => progressEl.classList.add('visible')));
            downloadBtn.disabled = true;
            try {
              const res = await ipcRenderer.invoke('download-update', { url: asset.url });
              if (res && res.ok && res.file) {
                currentFile = res.file;
                progressBar.style.width = '100%';
                progressText.textContent = 'Download complete';
                downloadBtn.textContent = 'Run Installer';
                downloadBtn.disabled = false;
                downloadBtn.onclick = async () => {
                  await ipcRenderer.invoke('run-installer', currentFile);
                };
              } else {
                alert('Download failed: ' + (res && res.error));
                downloadBtn.disabled = false;
                downloading = false;
              }
            } catch (e) {
              alert('Download failed: ' + e);
              downloadBtn.disabled = false;
              downloading = false;
            }
          };

          ipcRenderer.on('update-download-progress', (ev, p) => {
            if (p && p.file) {
              const percent = p.percent || (p.total ? Math.round(p.downloaded / p.total * 100) : 0);
              progressBar.style.width = (percent || 0) + '%';
              progressText.textContent = (percent ? percent + '%' : `${Math.round((p.downloaded || 0) / 1024)} KB`);
            }
          });

          document.getElementById('update-cancel').onclick = async () => {
            if (currentFile) {
              await ipcRenderer.invoke('cancel-update-download', { file: currentFile });
            }
            modal.remove();
          };
        }
        createUpdateModal(info);
      } catch (e) { console.warn('update-available handler error', e); }
    }

    // If the DOM looks ready, handle immediately; otherwise we query main for pending update
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      ensureAndHandle(res);
    } else {
      ipcRenderer.invoke('get-pending-update').then(info => ensureAndHandle(info)).catch(()=>{});
    }
  } catch (e) { console.warn('update-available handler error', e); }
});
// Allow other windows (Settings) to request the setup modal
ipcRenderer.on('show-setup-modal', () => {
  try { createSetupModal(); } catch (e) { console.error('Failed to open setup modal from IPC', e); }
});

// Allow other windows (Settings) to request the setup modal
ipcRenderer.on('show-setup-modal', () => {
  try { createSetupModal(); } catch (e) { console.error('Failed to open setup modal from IPC', e); }
});
// Handle default-bible updates from main process
ipcRenderer.on('default-bible-changed', async (event, bible) => {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const baseName = bible.endsWith('.json') ? bible.replace('.json','') : bible;
    const biblePath = path.join(userData, 'bibles', baseName);
    const localBibleFile = path.join(biblePath, 'bible.json');
    const legacyFile = path.join(userData, BIBLE_STORAGE_DIR, bible);

    // Update current bible tracking
    currentBibleFile = bible;

    // Migrate legacy single-file download into the expected per-version folder
    if (!fs.existsSync(localBibleFile) && fs.existsSync(legacyFile)) {
      try {
        await fs.promises.mkdir(biblePath, { recursive: true });
        const txt = await fs.promises.readFile(legacyFile, 'utf8');
        await fs.promises.writeFile(localBibleFile, txt, 'utf8');
      } catch (err) {
        console.error('Failed to migrate legacy bible file:', err);
      }
    }

    try {
      allVerses = await loadAllVersesFromDisk(biblePath);
    } catch (err) {
      safeStatus('Failed to load selected Bible.');
      console.error('Failed to load selected bible:', err);
      return;
    }

    // Update dynamic metadata (book names, chapter/verse counts) from the new Bible.
    applyDynamicBibleMeta();

    document.getElementById('virtual-list').style.height = `${allVerses.length * ITEM_HEIGHT}px`;
    renderWindow(allVerses, 0, selectedIndices, handleVerseClick);
    safeStatus(`Switched to ${baseName.replace('_', ' ')}.`);
    
    // Re-render schedule with new verse data
    if (scheduleItems.length > 0) {
      renderSchedule();
    }

    // Restore last selection if it belongs to this bible
    try {
      const settings = await ipcRenderer.invoke('load-settings');
      if (settings && settings.lastSelected && settings.lastSelected.bible === currentBibleFile) {
        const start = allVerses.findIndex(v => v.key === settings.lastSelected.startKey);
        const end = settings.lastSelected.endKey ? allVerses.findIndex(v => v.key === settings.lastSelected.endKey) : start;
        if (start !== -1) {
          const realEnd = (end !== -1) ? end : start;
          selectedIndices = [];
          for (let k = Math.min(start, realEnd); k <= Math.max(start, realEnd); k++) selectedIndices.push(k);
          anchorIndex = selectedIndices[0];
          updateVerseDisplay();
          updatePreview(allVerses[selectedIndices[0]]);
          jumpToVerse(selectedIndices[0]);
          renderWindow(allVerses, document.getElementById('verse-list').scrollTop, selectedIndices, handleVerseClick);
        }
      }
    } catch (err) { console.error('Failed to restore last selection after bible change:', err); }
  } catch (err) {
    console.error('Error handling default-bible-changed:', err);
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  // Install renderer-side logging buffer
  try {
    window.appLogs = window.appLogs || [];
    const _rlog = console.log;
    const _rwarn = console.warn;
    const _rerr = console.error;
    console.log = function(...args) { try { window.appLogs.push({ ts: new Date().toISOString(), level: 'log', msg: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') }); } catch (e) {} ; _rlog.apply(console, args); };
    console.warn = function(...args) { try { window.appLogs.push({ ts: new Date().toISOString(), level: 'warn', msg: args.join(' ') }); } catch (e) {} ; _rwarn.apply(console, args); };
    console.error = function(...args) { try { window.appLogs.push({ ts: new Date().toISOString(), level: 'error', msg: args.join(' ') }); } catch (e) {} ; _rerr.apply(console, args); };
  } catch (e) {}

  await loadAndApplySettings();

  // Check auth/license before showing main UI
  await ensureAuthSetup();
  
  // Continue with initial render
  loadCoreUI();

  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;

  // Track last known inner height so we can expand/shrink verse area proportionally on resize
  let _lastWindowInnerHeight = window.innerHeight;

  // Initial render
  renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  // Other UI initialization moved into loadCoreUI so it only runs after auth check

  // Scroll handler
  listContainer.addEventListener('scroll', () => {
    renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  });

  initScripture();
  loadSongs();
  loadMedia();
  initColorEditor();
  initImageEditor();
  initVideoEditor();
  initGifEditor();
  initWebsiteModal();
  initLocalWidgetModal();
  initAnnouncementModal();
  initLowerThird();
  initWebsitePanels();
  initTabs();
  initVideoLiveBar();
  setupPopover(); // Enabled: required so style buttons and menus can open the CSS popover
  setupTextStyleModal();

  // Click on the left (preview) canvas or its hover overlay opens the text styling modal
  const _previewCanvasEl = document.getElementById('preview-canvas');
  if (_previewCanvasEl) {
    _previewCanvasEl.style.cursor = 'pointer';
    _previewCanvasEl.addEventListener('click', () => openTextStyleModal());
  }
  const _previewOverlay = document.getElementById('preview-edit-overlay');
  if (_previewOverlay) {
    _previewOverlay.addEventListener('click', () => openTextStyleModal());
  }
  initSchedule();
  initResizers();
  restoreDividerPositions();
  initAiSuggestionPanel();

  // Re-validate divider positions after a window resize to avoid off-screen panels
  let _dividerResizeTimeout = null;
  window.addEventListener('resize', () => {
    clearTimeout(_dividerResizeTimeout);
    _dividerResizeTimeout = setTimeout(async () => {
      // Re-clamp and save if needed
      const scheduleSidebar = document.getElementById('schedule-sidebar');
      const slidePreview = document.getElementById('slide-preview');
      const slideContainer = document.getElementById('slide-container');
      const versePanel = document.getElementById('verse-panel');
      if (!scheduleSidebar || !slidePreview || !slideContainer || !versePanel) return;

      const scheduleWidthPx = Math.round(scheduleSidebar.getBoundingClientRect().width);
      const containerRect = slideContainer.getBoundingClientRect();
      const previewPercent = Math.round((slidePreview.getBoundingClientRect().width / (containerRect.width || 1)) * 100);
      const verseHeightPx = Math.round(versePanel.getBoundingClientRect().height);

      // Clamp same as restore for schedule/preview
      const clampedSchedule = Math.max(100, Math.min(scheduleWidthPx, Math.max(150, window.innerWidth - 400)));
      const clampedPreview = Math.max(10, Math.min(previewPercent, 90));

      // Verse panel keeps its absolute pixel height when the window grows — only clamp it
      // if the window shrinks so much that the verse panel would overflow.
      const windowMaxVerse = Math.max(100, window.innerHeight - 100);
      const clampedVerse = Math.max(50, Math.min(verseHeightPx, windowMaxVerse));
      // Top section always recomputed from the current window height.
      const newTop = Math.max(50, window.innerHeight - clampedVerse - 16);
      const topSection = document.getElementById('top-section');
      const currentTopHeight = topSection ? Math.round(topSection.getBoundingClientRect().height) : 0;

      let changed = false;
      if (clampedSchedule !== scheduleWidthPx) {
        scheduleSidebar.style.width = clampedSchedule + 'px';
        changed = true;
      }
      if (clampedPreview !== previewPercent) {
        slidePreview.style.flex = `${clampedPreview} 1 0%`;
        document.getElementById('live-panel-wrapper').style.flex = `${100 - clampedPreview} 1 0%`;
        changed = true;
      }
      // Update top+verse whenever either changed or top section needs to fill new window height
      if (clampedVerse !== verseHeightPx || Math.abs(newTop - currentTopHeight) > 2) {
        if (topSection) topSection.style.flex = `0 0 ${newTop}px`;
        versePanel.style.flex = `0 0 ${clampedVerse}px`;
        changed = true;
      }

      // Remember last window size for next resize calculation
      _lastWindowInnerHeight = window.innerHeight;

      if (changed) await saveDividerPositions();
    }, 150);
  });

  // Listen for report requests from main and prepare renderer payload
  // Show a non-blocking toast when main process detects errors
ipcRenderer.on('error-report-prompt', (event, data) => {
  // De-duplicate: only one toast per session
  if (document.getElementById('_err-report-toast')) return;

  // Prefer errors passed from main process; fall back to renderer's own log
  const passedErrors = data && Array.isArray(data.errors) && data.errors.length ? data.errors : null;
  const rendererErrors = (window.appLogs || []).filter(l => l.level === 'error').map(l => `[${l.ts}] ${l.msg}`);
  const allErrors = passedErrors || rendererErrors;
  const errorText = allErrors.length ? allErrors.join('\n') : '(no error details captured)';

  const toast = document.createElement('div');
  toast.id = '_err-report-toast';
  toast.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'z-index:9999',
    'border:1px solid #c0392b', 'border-radius:8px', 'padding:16px 18px',
    'box-shadow:0 4px 24px rgba(0,0,0,0.45)', 'max-width:360px',
    'backdrop-filter:blur(12px)', '-webkit-backdrop-filter:blur(12px)'
  ].join(';');
  toast.className = 'song-editor-panel'; // inherits theming (dark/light)
  toast.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;color:#e74c3c;">Errors detected</div>
    <div style="font-size:0.9em;margin-bottom:8px;">One or more errors occurred. Save a diagnostic report to share with support?</div>
    <div style="margin-bottom:10px;">
      <button id="_err-toggle" style="background:none;border:none;padding:0;font-size:0.8em;cursor:pointer;color:#e74c3c;text-decoration:underline;">Show errors</button>
      <pre id="_err-detail" style="display:none;margin-top:6px;font-size:0.75em;line-height:1.5;white-space:pre-wrap;word-break:break-all;overflow-y:auto;max-height:110px;background:rgba(0,0,0,0.2);border-radius:4px;padding:6px 8px;"></pre>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="_err-dismiss" class="btn">Dismiss</button>
      <button id="_err-save" class="btn" style="background:#c0392b;color:#fff;">Save Report</button>
    </div>
  `;
  document.body.appendChild(toast);

  // Populate error text safely without innerHTML injection
  toast.querySelector('#_err-detail').textContent = errorText;

  let detailVisible = false;
  toast.querySelector('#_err-toggle').addEventListener('click', () => {
    detailVisible = !detailVisible;
    toast.querySelector('#_err-detail').style.display = detailVisible ? 'block' : 'none';
    toast.querySelector('#_err-toggle').textContent = detailVisible ? 'Hide errors' : 'Show errors';
  });

  const remove = () => { try { document.body.removeChild(toast); } catch (e) {} };
  toast.querySelector('#_err-dismiss').addEventListener('click', remove);
  toast.querySelector('#_err-save').addEventListener('click', async () => {
    remove();
    try { await ipcRenderer.invoke('trigger-save-report'); } catch (e) { console.error('Failed to trigger save report:', e); }
  });
});

ipcRenderer.on('prepare-renderer-report', async () => {
    try {
      const docHtml = document.documentElement.outerHTML;
      const previewCanvas = document.getElementById('preview-canvas');
      let previewDataUrl = null;
      let previewInfo = null;
      if (previewCanvas) {
        try {
          previewDataUrl = previewCanvas.toDataURL('image/png');
          previewInfo = { width: previewCanvas.width, height: previewCanvas.height };
        } catch (e) {
          previewInfo = { error: String(e) };
        }
      }

      const settingsSnapshot = {
        username: document.getElementById('username') ? document.getElementById('username').value : null,
        darkTheme: document.getElementById('dark-theme') ? document.getElementById('dark-theme').checked : null,
        theme: document.getElementById('theme') ? document.getElementById('theme').value : null,
        dividerPositions: {
          scheduleWidth: document.getElementById('schedule-sidebar') ? document.getElementById('schedule-sidebar').style.width : null,
          previewFlex: document.getElementById('slide-preview') ? document.getElementById('slide-preview').style.flex : null,
          verseHeight: document.getElementById('verse-panel') ? document.getElementById('verse-panel').style.flex : null
        }
      };

      const rendererLogs = window.appLogs || [];
      const settingsFile = await ipcRenderer.invoke('load-settings');

      ipcRenderer.send('renderer-report', {
        docHtml,
        previewDataUrl,
        previewInfo,
        settingsSnapshot,
        settingsFile,
        rendererLogs
      });
    } catch (err) {
      console.error('Failed to prepare renderer report:', err);
      ipcRenderer.send('renderer-report', { error: String(err) });
    }
  });

  // After any button click, return focus to body so global keybinds keep working.
  document.addEventListener('click', (e) => {
    if (e.target && e.target.tagName === 'BUTTON') {
      e.target.blur();
    }
  });

  // Returns true when any modal/overlay/editor is currently open so global
  // keybinds should be fully suppressed (they never steal Enter, arrows, etc.)
  function isAnyModalOpen() {
    // 1. Active focus is inside a modal container
    const active = document.activeElement;
    if (active && active.closest(
      '#song-editor-modal, #setup-modal, #token-entry-modal, #update-modal, ' +
      '#color-editor-modal, #image-editor-modal, #video-editor-modal, ' +
      '#gif-editor-modal, #transition-editor-modal, .dual-bible-picker-modal, ' +
      '.song-editor-panel, [role="dialog"]'
    )) return true;
    // 2. Modals shown via style.display
    if (['song-editor-modal', 'setup-modal', 'token-entry-modal',
         'update-modal', 'transition-editor-modal'].some(id => {
      const m = document.getElementById(id);
      return m && m.style.display === 'flex';
    })) return true;
    // 3. Modals shown via .active class
    if (document.querySelector(
      '#color-editor-modal.active, #image-editor-modal.active, ' +
      '#video-editor-modal.active, #gif-editor-modal.active'
    )) return true;
    // 4. Dual bible picker (appended dynamically)
    if (document.querySelector('.dual-bible-picker-modal')) return true;
    return false;
  }

  // Keyboard navigation - use keybinds system
  window.addEventListener('keydown', (e) => {
    // Suppress ALL global keybinds when any modal / editor panel is open.
    // This also fixes Enter (go-live) firing inside the song editor textarea.
    if (isAnyModalOpen()) return;

    // Check for go-live keybind first, before text input check (should work globally)
    if (matchesKeybind(keybinds['go-live'], e)) {
      e.preventDefault();
      handleVerseDoubleClick(); // Calls the same logic as "Go Live" button
      return;
    }
    // Focus the active tab's search bar (works even when a text input is focused)
    if (matchesKeybind(keybinds['focus-search'], e)) {
      e.preventDefault();
      const searchEl = currentTab === 'songs'
        ? document.getElementById('song-search-input')
        : document.getElementById('search-autocomplete-input');
      if (searchEl) { searchEl.focus(); searchEl.select(); }
      return;
    }
    // Toggle clear / black (work globally, before text-input guard)
    if (keybinds['toggle-clear'] && matchesKeybind(keybinds['toggle-clear'], e)) { e.preventDefault(); toggleClear(); return; }
    if (keybinds['toggle-black'] && matchesKeybind(keybinds['toggle-black'], e)) { e.preventDefault(); toggleBlack(); return; }
    
    // Check current state
    const isInSongsTab = currentTab === 'songs';
    const songDisplay = document.getElementById('song-display');
    const isSongDisplayOpen = selectedSongIndices.length > 0 && songDisplay && songDisplay.style.display !== 'none';
    const active = document.activeElement;
    
    // Don't intercept other keybinds when text editing (must be after go-live check)
    const isTextInput = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
    if (isTextInput) return;
    
    // Check if we're on a schedule song verse (these have their own focus)
    const isSongScheduleVerse = active && active.classList.contains('schedule-verse-item') && 
                                  focusedScheduleItem && focusedScheduleItem.type === 'song-verse';
    
    // Handle schedule song verse navigation
    if (isSongScheduleVerse && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        navigateScheduleSongVerse(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        navigateScheduleSongVerse(1);
      }
      return;
    }
    
    // Ignore if focus is on other schedule items (they have their own handlers)
    if (active && (active.closest('.schedule-item-header') || (active.closest('.schedule-verse-item') && !isSongScheduleVerse))) return;
    
    // Check keybinds in songs tab
    if (isInSongsTab && isSongDisplayOpen) {
      // Previous verse
      if (matchesKeybind(keybinds['prev-verse'], e)) {
        e.preventDefault();
        selectPrevSongVerse();
        return;
      }
      
      // Next verse
      if (matchesKeybind(keybinds['next-verse'], e)) {
        e.preventDefault();
        selectNextSongVerse();
        return;
      }
      
      // Verse selection keybinds (Alt+1-9)
      if (matchesKeybind(keybinds['select-verse-1'], e)) { e.preventDefault(); selectSongVerseByNumber(1); return; }
      if (matchesKeybind(keybinds['select-verse-2'], e)) { e.preventDefault(); selectSongVerseByNumber(2); return; }
      if (matchesKeybind(keybinds['select-verse-3'], e)) { e.preventDefault(); selectSongVerseByNumber(3); return; }
      if (matchesKeybind(keybinds['select-verse-4'], e)) { e.preventDefault(); selectSongVerseByNumber(4); return; }
      if (matchesKeybind(keybinds['select-verse-5'], e)) { e.preventDefault(); selectSongVerseByNumber(5); return; }
      if (matchesKeybind(keybinds['select-verse-6'], e)) { e.preventDefault(); selectSongVerseByNumber(6); return; }
      if (matchesKeybind(keybinds['select-verse-7'], e)) { e.preventDefault(); selectSongVerseByNumber(7); return; }
      if (matchesKeybind(keybinds['select-verse-8'], e)) { e.preventDefault(); selectSongVerseByNumber(8); return; }
      if (matchesKeybind(keybinds['select-verse-9'], e)) { e.preventDefault(); selectSongVerseByNumber(9); return; }
      
      // Chorus selection keybinds (Alt+C and Alt+2-9)
      if (matchesKeybind(keybinds['select-chorus-1'], e)) { e.preventDefault(); selectSongChorusByNumber(1); return; }
      if (matchesKeybind(keybinds['select-chorus-2'], e)) { e.preventDefault(); selectSongChorusByNumber(2); return; }
      if (matchesKeybind(keybinds['select-chorus-3'], e)) { e.preventDefault(); selectSongChorusByNumber(3); return; }
      if (matchesKeybind(keybinds['select-chorus-4'], e)) { e.preventDefault(); selectSongChorusByNumber(4); return; }
      if (matchesKeybind(keybinds['select-chorus-5'], e)) { e.preventDefault(); selectSongChorusByNumber(5); return; }
      if (matchesKeybind(keybinds['select-chorus-6'], e)) { e.preventDefault(); selectSongChorusByNumber(6); return; }
      if (matchesKeybind(keybinds['select-chorus-7'], e)) { e.preventDefault(); selectSongChorusByNumber(7); return; }
      if (matchesKeybind(keybinds['select-chorus-8'], e)) { e.preventDefault(); selectSongChorusByNumber(8); return; }
      if (matchesKeybind(keybinds['select-chorus-9'], e)) { e.preventDefault(); selectSongChorusByNumber(9); return; }
    }
    
    // Check keybinds in Bible tab
    if (!isInSongsTab) {
      // Previous verse
      if (matchesKeybind(keybinds['prev-verse'], e)) {
        e.preventDefault();
        selectPrevVerse(e.shiftKey);
        return;
      }
      
      // Next verse
      if (matchesKeybind(keybinds['next-verse'], e)) {
        e.preventDefault();
        selectNextVerse(e.shiftKey);
        return;
      }
    }
  });

  // Signal main process that renderer is ready to display
  // Called at the END of DOMContentLoaded after all sync initialization completes
  try {
    await ipcRenderer.invoke('renderer-ready');
    console.log('[renderer] Signaled main process at end of DOMContentLoaded');
  } catch (err) {
    console.error('[renderer] Error signaling renderer-ready:', err);
  }
});

async function selectReferenceRange(ref) {
  if (!ref || !ref.book || !ref.chapter || !allVerses.length) return false;
  const startVerse = Math.max(1, ref.verse || 1);
  const endVerse = Math.max(startVerse, ref.verseEnd || startVerse);
  const startKey = `${ref.book} ${ref.chapter}:${startVerse}`.toLowerCase();
  let startIdx = allVerses.findIndex((v) => v.key && v.key.toLowerCase() === startKey);
  if (startIdx === -1) {
    safeStatus('Verse not found.');
    return false;
  }
  let endIdx = startIdx;
  if (endVerse !== startVerse) {
    const endKey = `${ref.book} ${ref.chapter}:${endVerse}`.toLowerCase();
    const maybeEnd = allVerses.findIndex((v) => v.key && v.key.toLowerCase() === endKey);
    if (maybeEnd !== -1) {
      endIdx = maybeEnd;
    }
  }
  selectedIndices = [];
  for (let k = Math.min(startIdx, endIdx); k <= Math.max(startIdx, endIdx); k++) {
    selectedIndices.push(k);
  }
  anchorIndex = selectedIndices[0];
  updateVerseDisplay();
  if (selectedIndices.length === 1) {
    await updatePreview(selectedIndices[0]);
  } else {
    await updatePreview(selectedIndices);
  }
  jumpToVerse(selectedIndices[0]);
  const listContainer = document.getElementById('verse-list');
  if (listContainer) {
    renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  }
  await saveLastSelectionToSettings();
  return true;
}

async function initScripture() {
  safeStatus('Initializing…');
  allVerses = [];
  selectedIndices = [];
  anchorIndex = null;

  const userData = await ipcRenderer.invoke('get-user-data-path');

  // Prefer saved default bible if present, otherwise fall back to constants.VERSION
  const savedDefault = await ipcRenderer.invoke('get-default-bible');
  const defaultBibleFile = savedDefault || `${VERSION}.json`;
  currentBibleFile = defaultBibleFile;
  const baseName = defaultBibleFile.endsWith('.json') ? defaultBibleFile.replace('.json','') : defaultBibleFile;
  const baseDir = path.join(userData, 'bibles', baseName);
  await fs.promises.mkdir(baseDir, { recursive: true });

  // Download bible.json if needed
  await ensureBibleJson(baseDir);

  allVerses = await loadAllVersesFromDisk(baseDir);

  // Update dynamic metadata (book names, chapter/verse counts) from the loaded Bible.
  applyDynamicBibleMeta();

  document.getElementById('virtual-list').style.height = `${allVerses.length * ITEM_HEIGHT}px`;
  // Ensure left column is wide enough to show the longest verse reference (clamped to a sane maximum)
  try { adjustVerseListWidth(allVerses); } catch(e) { console.warn('adjustVerseListWidth failed', e); }
  renderWindow(allVerses, 0, selectedIndices, handleVerseClick);
  safeStatus(`Loaded ${allVerses.length} verses.`);
  
  // Render schedule now that allVerses is populated
  if (scheduleItems.length > 0) {
    renderSchedule();
  }

  // Compute and set verse-list width based on measured text (used above)
  function adjustVerseListWidth(allVersesList) {
    const listEl = document.getElementById('verse-list');
    if (!listEl || !allVersesList || allVersesList.length === 0) return;

    // Create a temporary element to pick up computed font styles
    const sample = document.createElement('div');
    sample.className = 'verse-item';
    sample.style.position = 'absolute'; sample.style.visibility = 'hidden'; sample.style.whiteSpace = 'nowrap';
    document.body.appendChild(sample);
    const computedFont = window.getComputedStyle(sample).font || '14px Arial';
    document.body.removeChild(sample);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = computedFont;

    // Measure the longest key
    let maxW = 0;
    for (let i = 0; i < allVersesList.length; i++) {
      const key = allVersesList[i] && allVersesList[i].key ? String(allVersesList[i].key) : '';
      const w = ctx.measureText(key).width;
      if (w > maxW) maxW = w;
    }

    // Add padding and clamp to reasonable bounds
    const padding = 16; // 8px left + 8px right (we already have those)
    const minW = 120;
    const maxAllowed = Math.min(420, Math.floor(window.innerWidth * 0.45));
    const desired = Math.ceil(maxW + padding);
    const final = Math.max(minW, Math.min(desired, maxAllowed));

    document.documentElement.style.setProperty('--verse-list-width', `${final}px`);
  }

  // Recompute on resize (debounced)
  let _verseListResizeTimer = null;
  window.addEventListener('resize', () => {
    if (_verseListResizeTimer) clearTimeout(_verseListResizeTimer);
    _verseListResizeTimer = setTimeout(() => adjustVerseListWidth(allVerses), 150);
  });
  // Try to restore last selection if it belongs to this bible
  try {
    const settings = await ipcRenderer.invoke('load-settings');
    if (settings && settings.lastSelected && settings.lastSelected.bible === currentBibleFile) {
      const start = allVerses.findIndex(v => v.key === settings.lastSelected.startKey);
      const end = settings.lastSelected.endKey ? allVerses.findIndex(v => v.key === settings.lastSelected.endKey) : start;
      if (start !== -1) {
        const realEnd = (end !== -1) ? end : start;
        selectedIndices = [];
        for (let k = Math.min(start, realEnd); k <= Math.max(start, realEnd); k++) selectedIndices.push(k);
        anchorIndex = selectedIndices[0];
        updateVerseDisplay();
        updatePreview(allVerses[selectedIndices[0]]);
        jumpToVerse(selectedIndices[0]);
        renderWindow(allVerses, document.getElementById('verse-list').scrollTop, selectedIndices, handleVerseClick);
      }
    }
  } catch (err) {
    console.error('Failed to restore last selection:', err);
  }

  // Set preview aspect ratio
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  if (defaultDisplayId) {
    const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
    if (display) {
      const aspect = (display.bounds.height / display.bounds.width) * 100;
      document.documentElement.style.setProperty('--preview-aspect', `${aspect}%`);
    }
  }

  // Preload secondary translation data if previously saved
  if (secondaryBibleFile) {
    loadSecondaryBible(secondaryBibleFile, { enable: dualTranslationEnabled, quiet: true }).catch(() => {});
  }

  // Setup the EasyWorship-style search box.
  // Save config so applyDynamicBibleMeta() can re-call updateSearchBox with new book names.
  searchBoxConfig = {
    containerId: 'search-box-container',
    onReferenceSelected: async (ref) => {
      await selectReferenceRange(ref);
    },
    onNavigate: (direction) => {
      if (direction === 'prev') selectPrevVerse();
      else selectNextVerse();
    },
    onEnter: () => {
      // Go live using the current selection (supports multi-select); if a single
      // verse is focused/present it'll still work because selectedIndices will contain it.
      if (selectedIndices.length > 0) handleVerseDoubleClick();
    },
    onToggleLive: toggleLive,
    onToggleClear: toggleClear,
    onToggleBlack: toggleBlack,
    onToggleDual: handleToggleDual,
    onPickDual: openDualBiblePicker,
    // Use dynamic book names when available; fall back to hardcoded KJV list until Bible loads.
    books: dynamicBibleMeta.bookNames.length ? dynamicBibleMeta.bookNames : BOOKS
  };
  setupSearchBox(searchBoxConfig);

  // Update Dual button state if secondary translation was preloaded before button existed
  if (secondaryBibleFile && secondaryVerseMap.size > 0) {
    if (window.dualButton) {
      window.dualButton.style.display = '';
      window.dualButton.textContent = getSecondaryDisplayName();
      window.dualButton.classList.toggle('active', dualTranslationEnabled);
    }
  }
}

// Jump to verse (e.g. after search)
function jumpToVerse(idx) {
  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;
  listContainer.scrollTop = idx * ITEM_HEIGHT;
  // renderWindow will be called by the scroll event
}

// ── Dual translation helpers ─────────────────────────────────────────────────
function getPrimaryDisplayLabel() {
  if (!currentBibleFile) return 'KJV';
  const base = currentBibleFile.replace(/\.json$/, '');
  const parts = base.split('_');
  return (parts.length >= 2 ? parts.slice(1) : parts).join(' ').toUpperCase();
}

function getSecondaryDisplayName() {
  if (!secondaryBibleFile) return '';
  const base = secondaryBibleFile.endsWith('.json') ? secondaryBibleFile.slice(0, -5) : secondaryBibleFile;
  const parts = base.split('_');
  return (parts.length >= 2 ? parts.slice(1) : parts).join(' ').toUpperCase();
}

// Returns { secondaryText, secondaryRef } for the given allVerses indices, or {}.
function buildSecondaryForCanvas(indices) {
  if (!dualTranslationEnabled || secondaryVerseMap.size === 0 || !indices || indices.length === 0) return {};
  const parts = [];
  const foundIndices = [];
  indices.forEach(i => {
    const sv = secondaryVerseMap.get(allVerses[i].key);
    if (sv) {
      const verseNum = allVerses[i].key.split(':')[1];
      const clean = sv.text.replace(/(\.(\d+)[\s\S]*)$/, '');
      parts.push(`${verseNum}  ${clean}`);
      foundIndices.push(i);
    }
  });
  if (parts.length === 0) return {};
  const secName = getSecondaryDisplayName();
  const secondaryRef = foundIndices.length === 1
    ? `${allVerses[foundIndices[0]].key} (${secName})`
    : `${allVerses[foundIndices[0]].key} \u2013 ${allVerses[foundIndices[foundIndices.length - 1]].key} (${secName})`;
  return { secondaryText: parts.join(' '), secondaryRef };
}

async function loadSecondaryBible(bibleFileName, { enable = true, quiet = false } = {}) {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const baseName = bibleFileName.endsWith('.json') ? bibleFileName.replace('.json', '') : bibleFileName;
    const baseDir = path.join(userData, 'bibles', baseName);
    const verses = await loadAllVersesFromDisk(baseDir);
    secondaryBibleFile = bibleFileName;
    // Re-key secondary verses by position against the primary allVerses array so that
    // translations with different book names (e.g. "Génesis" vs "Genesis") still match.
    secondaryVerseMap = new Map();
    verses.forEach((sv, i) => {
      const primaryKey = allVerses[i] ? allVerses[i].key : sv.key;
      secondaryVerseMap.set(primaryKey, sv);
    });
    if (enable) {
      dualTranslationEnabled = true;
      await ipcRenderer.invoke('update-settings', { secondaryBibleFile: bibleFileName, dualTranslationEnabled: true });
    }
    if (window.dualButton) {
      window.dualButton.style.display = '';
      window.dualButton.textContent = getSecondaryDisplayName();
      window.dualButton.classList.toggle('active', dualTranslationEnabled);
    }
    if (enable) {
      // Always refresh the display when dual is active so verses show dual content on startup.
      updateVerseDisplay();
      if (selectedIndices.length > 0 && currentTab === 'verses') await updatePreview(selectedIndices);
      if (!quiet) safeStatus(`Dual translation: ${getSecondaryDisplayName()} enabled`);
    }
  } catch (err) {
    console.error('Failed to load secondary bible:', err);
    if (!quiet && enable) safeStatus('Failed to load secondary translation.');
  }
}

async function handleToggleDual() {
  if (dualTranslationEnabled) {
    dualTranslationEnabled = false;
    await ipcRenderer.invoke('update-settings', { dualTranslationEnabled: false });
    if (window.dualButton) {
      window.dualButton.classList.remove('active');
    }
    updateVerseDisplay();
    if (selectedIndices.length > 0 && currentTab === 'verses') await updatePreview(selectedIndices);
    safeStatus('Dual translation disabled');
  } else if (secondaryBibleFile && secondaryVerseMap.size > 0) {
    await loadSecondaryBible(secondaryBibleFile, { enable: true, quiet: false });
  } else {
    await openDualBiblePicker();
  }
}

async function openDualBiblePicker() {
  const userData = await ipcRenderer.invoke('get-user-data-path');
  const biblesBase = path.join(userData, 'bibles');
  let availableBibles = [];
  try {
    const primaryBase = currentBibleFile ? currentBibleFile.replace(/\.json$/, '') : null;
    const entries = fs.readdirSync(biblesBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === primaryBase) continue;
      if (fs.existsSync(path.join(biblesBase, entry.name, 'bible.json'))) {
        availableBibles.push(entry.name);
      }
    }
  } catch (err) {
    console.error('Failed to list bibles:', err);
  }
  if (availableBibles.length === 0) {
    safeStatus('No other translations available. Download one in Settings > Bibles.');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'dual-bible-picker-overlay';
  const modal = document.createElement('div');
  modal.className = 'dual-bible-picker-modal';
  const title = document.createElement('h3');
  title.className = 'dual-bible-picker-title';
  title.textContent = 'Select Secondary Translation';
  const list = document.createElement('ul');
  list.className = 'dual-bible-picker-list';
  availableBibles.forEach(bibleId => {
    const item = document.createElement('li');
    item.className = 'dual-bible-picker-item';
    const parts = bibleId.split('_');
    item.textContent = (parts.length >= 2 ? parts.slice(1) : parts).join(' ').toUpperCase() + `  (${bibleId})`;
    item.addEventListener('click', async () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      await loadSecondaryBible(bibleId);
    });
    list.appendChild(item);
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'dual-bible-picker-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
  overlay.addEventListener('click', e => { if (e.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); });
  modal.appendChild(title);
  modal.appendChild(list);
  modal.appendChild(cancelBtn);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
// ─────────────────────────────────────────────────────────────────────────────

function updateVerseDisplay() {
  const disp = document.getElementById('verse-display');
  if (!disp) return;

  const sorted = selectedIndices.slice().sort((a, b) => a - b);
  if (sorted.length === 0) { disp.innerHTML = ''; return; }
  {
    const combined = sorted.map(i => allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '')).join(' ');
    const ref = sorted.length === 1
      ? allVerses[sorted[0]].key
      : `${allVerses[sorted[0]].key} - ${allVerses[sorted[sorted.length - 1]].key}`;
    let html = `<p><strong>${ref}</strong><br>${combined}</p>`;
    if (dualTranslationEnabled && secondaryVerseMap.size > 0) {
      const secName = getSecondaryDisplayName();
      const secParts = [];
      const missing = [];
      sorted.forEach(i => {
        const sv = secondaryVerseMap.get(allVerses[i].key);
        if (sv) secParts.push(sv.text.replace(/(\.(\d+)[\s\S]*)$/, ''));
        else missing.push(allVerses[i].key);
      });
      const missingNote = missing.length
        ? ` <em class="dual-missing">(${missing.join(', ')} not in ${secName})</em>` : '';
      html += `<hr class="dual-translation-divider">`;
      if (secParts.length > 0) {
        html += `<p class="secondary-verse-text"><strong>${ref} \u2014 ${secName}</strong><br>${secParts.join(' ')}${missingNote}</p>`;
      } else {
        html += `<p class="secondary-verse-text secondary-verse-missing">Not available in ${secName}</p>`;
      }
    }
    disp.innerHTML = html;
  }
}

/**
 * Apply fade-in animation to canvas content
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Number} duration - Duration in seconds
 * @param {Function} callback - Called when animation completes
 */
function applyFadeInAnimation(canvas, duration = 1.0, callback = null) {
  const startTime = Date.now();
  const ctx = canvas.getContext('2d');
  
  // Save original canvas content
  const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  const animate = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Create a copy of the image data with adjusted alpha
    const imageData = ctx.createImageData(originalImageData);
    const data = imageData.data;
    const originalData = originalImageData.data;
    
    // Adjust alpha channel for all pixels
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.round(originalData[i] * progress);
    }
    
    // Clear canvas and redraw with faded image
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      ctx.putImageData(originalImageData, 0, 0);
      if (callback) callback();
    }
  };
  
  animate();
}

/**
 * Apply fade-out animation to canvas content
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Number} duration - Duration in seconds
 * @param {Function} callback - Called when animation completes
 */
function applyFadeOutAnimation(canvas, duration = 1.0, callback = null) {
  const startTime = Date.now();
  const ctx = canvas.getContext('2d');
  
  // Save original canvas content
  const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  const animate = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Create a copy of the image data with adjusted alpha (reverse of fade-in)
    const imageData = ctx.createImageData(originalImageData);
    const data = imageData.data;
    const originalData = originalImageData.data;
    
    // Adjust alpha channel for all pixels (1 - progress for fade-out)
    const alpha = 1 - progress;
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.round(originalData[i] * alpha);
    }
    
    // Clear canvas and redraw with faded image
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      // Clear to black
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (callback) callback();
    }
  };
  
  animate();
}

/**
 * Render verse content to a canvas at external display resolution
 * @param {HTMLCanvasElement} canvas - The canvas to render to
 * @param {Object} content - { number, text, reference, showHint }
 * @param {Number} displayWidth - External display width
 * @param {Number} displayHeight - External display height
 * @param {Function} onRenderComplete - Callback when rendering is complete
 */
function renderToCanvas(canvas, content, displayWidth = 1920, displayHeight = 1080, onRenderComplete = null) {
  // Stop any running video draw-loop that was previously assigned to this canvas.
  // Without this, a video loop started by displayMediaOnLive keeps overwriting the canvas
  // even after renderToCanvas draws new verse/song content on top.
  canvas._currentPreviewVideo = null;

  // Bump the background-animation token so any previous GIF/video background
  // loop for this canvas self-terminates on its next tick.
  canvas._bgToken = (canvas._bgToken || 0) + 1;
  const _myBgToken = canvas._bgToken;

  canvas.width = displayWidth;
  canvas.height = displayHeight;
  
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, displayWidth, displayHeight);
  
  // Styles passed via content.styles (optional)
  const styles = content && content.styles ? content.styles : null;
  const textStyle = styles && styles.text ? styles.text : null;
  const numberStyle = styles && (styles.number || styles.title) ? (styles.number || styles.title) : null;
  const referenceStyle = styles && styles.reference ? styles.reference : null;
  const subscriptStyle = styles && styles.subscript ? styles.subscript : null;
  const globalStyle = styles && styles.global ? styles.global : {};
  const _overlayOpacity = globalStyle.overlayOpacity !== undefined ? globalStyle.overlayOpacity : 0.4;
  const _bgBlur    = parseFloat(globalStyle.bgBlur) || 0;
  const _normScale = displayHeight / 1080; // normalise to 1080p for spatial values

  // Cache for <img> elements used as animated GIF backgrounds.
  // Reusing the same element lets the browser keep the animation running
  // across successive renderToCanvas calls rather than restarting at frame 0.
  if (!renderToCanvas._gifCache) renderToCanvas._gifCache = new Map();

  // Handle background media (object with type, path, color, and settings)
  if (content.backgroundMedia) {
    const media = content.backgroundMedia;
    
    if (media.type === 'COLOR') {
      if (_bgBlur > 0) ctx.filter = `blur(${_bgBlur * _normScale}px)`;
      applyColorToCanvas(ctx, media.color, displayWidth, displayHeight);
      ctx.filter = 'none';
      ctx.fillStyle = `rgba(0,0,0,${_overlayOpacity})`;
      ctx.fillRect(0, 0, displayWidth, displayHeight);
      renderTextContent();
      if (onRenderComplete) onRenderComplete();
    } else if (media.type === 'GIF') {
      // Animated GIF: reuse cached <img> so animation continues from current frame.
      // We then re-draw it every animation frame so the canvas shows each new frame.
      let bgImg = renderToCanvas._gifCache.get(media.path);
      if (!bgImg) {
        bgImg = new Image();
        bgImg.src = pathToFileURL(media.path);
        renderToCanvas._gifCache.set(media.path, bgImg);
      }
      canvas._bgSource = bgImg;
      const drawGifFrame = () => {
        if (canvas._bgToken !== _myBgToken) return; // newer content replaced us
        if (bgImg.complete && bgImg.naturalWidth > 0) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, displayWidth, displayHeight);
          if (_bgBlur > 0) ctx.filter = `blur(${_bgBlur * _normScale}px)`;
          drawImageWithSettings(ctx, bgImg, displayWidth, displayHeight, {
            bgSize: media.bgSize || 'cover',
            bgRepeat: media.bgRepeat || 'no-repeat',
            bgPosition: media.bgPosition || 'center'
          });
          ctx.filter = 'none';
          ctx.fillStyle = `rgba(0,0,0,${_overlayOpacity})`;
          ctx.fillRect(0, 0, displayWidth, displayHeight);
          renderTextContent();
        }
        requestAnimationFrame(drawGifFrame);
      };
      drawGifFrame();
    } else if (['JPG','JPEG','PNG','WEBP','BMP'].includes(media.type)) {
      // Static image background – draw once
      const bgImg = new Image();
      bgImg.onload = () => {
        if (canvas._bgToken !== _myBgToken) return; // superseded before load finished
        if (_bgBlur > 0) ctx.filter = `blur(${_bgBlur * _normScale}px)`;
        drawImageWithSettings(ctx, bgImg, displayWidth, displayHeight, {
          bgSize: media.bgSize || 'cover',
          bgRepeat: media.bgRepeat || 'no-repeat',
          bgPosition: media.bgPosition || 'center'
        });
        ctx.filter = 'none';
        ctx.fillStyle = `rgba(0,0,0,${_overlayOpacity})`;
        ctx.fillRect(0, 0, displayWidth, displayHeight);
        renderTextContent();
      };
      bgImg.onerror = () => {
        console.error('Failed to load background:', media.path);
        renderTextContent();
      };
      bgImg.src = pathToFileURL(media.path);
    } else if (['MP4','WEBM','OGG','MOV','AVI'].includes(media.type)) {
      // Video background: create a video element and run an rAF loop that
      // renders each frame with the text overlay on top.
      const bgVideo = document.createElement('video');
      bgVideo.src = pathToFileURL(media.path);
      bgVideo.muted = true;
      bgVideo.loop = true;
      canvas._bgSource = bgVideo;
      safePlay(bgVideo);

      const _useRVFC = typeof bgVideo.requestVideoFrameCallback === 'function';
      const drawVideoFrame = () => {
        if (canvas._bgToken !== _myBgToken) {
          bgVideo.pause();
          if (bgVideo.parentNode) bgVideo.parentNode.removeChild(bgVideo);
          return;
        }
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, displayWidth, displayHeight);
        if (bgVideo.readyState >= 2) {
          const scale = Math.min(displayWidth / bgVideo.videoWidth, displayHeight / bgVideo.videoHeight);
          const w = bgVideo.videoWidth * scale;
          const h = bgVideo.videoHeight * scale;
          const x = (displayWidth - w) / 2;
          const y = (displayHeight - h) / 2;
          if (_bgBlur > 0) ctx.filter = `blur(${_bgBlur * _normScale}px)`;
          ctx.drawImage(bgVideo, x, y, w, h);
          ctx.filter = 'none';
          ctx.fillStyle = `rgba(0,0,0,${_overlayOpacity})`;
          ctx.fillRect(0, 0, displayWidth, displayHeight);
          renderTextContent();
        }
        if (_useRVFC) {
          bgVideo.requestVideoFrameCallback(drawVideoFrame);
        } else {
          requestAnimationFrame(drawVideoFrame);
        }
      };
      if (_useRVFC) {
        bgVideo.requestVideoFrameCallback(drawVideoFrame);
      } else {
        drawVideoFrame();
      }
    } else {
      // Unknown background type — just render text
      renderTextContent();
    }
  } else if (content.backgroundPath) {
    // Legacy path string support
    const bgImg = new Image();
    bgImg.onload = () => {
      const scale = Math.min(displayWidth / bgImg.width, displayHeight / bgImg.height);
      const w = bgImg.width * scale;
      const h = bgImg.height * scale;
      const x = (displayWidth - w) / 2;
      const y = (displayHeight - h) / 2;
      ctx.drawImage(bgImg, x, y, w, h);
      ctx.fillStyle = `rgba(0,0,0,${_overlayOpacity})`;
      ctx.fillRect(0, 0, displayWidth, displayHeight);
      renderTextContent();
    };
    bgImg.onerror = () => {
      console.error('Failed to load background:', content.backgroundPath);
      renderTextContent();
    };
    bgImg.src = pathToFileURL(content.backgroundPath);
  } else {
    renderTextContent();
  }

  function renderTextContent() {
    ctx.textBaseline = 'middle';

    const isDual = !!(content.secondaryText);
    const primaryRegionH = isDual ? displayHeight * 0.52 : displayHeight;
    const _sa = globalStyle.safeArea || {};
    const _saX = _sa.x !== undefined ? _sa.x : 0.04;
    const _saY = _sa.y !== undefined ? _sa.y : 0.04;
    const _saW = _sa.w !== undefined ? _sa.w : 0.92;
    const _saH = _sa.h !== undefined ? _sa.h : 0.92;
    const areaLeft   = displayWidth  * _saX;
    const areaTop    = displayHeight * _saY;
    const areaRight  = areaLeft + displayWidth  * _saW;
    const areaBottom = areaTop  + displayHeight * _saH;
    const areaWidth  = displayWidth  * _saW;
    const areaHeight = displayHeight * _saH;
    const padding = areaLeft; // legacy alias for secondary section
    const availableWidth  = areaWidth;
    const availableHeight = isDual ? primaryRegionH - areaTop * 2 : areaHeight;
    let baseFontSize = displayHeight * 0.08;

    const lhMult  = globalStyle.lineHeight        || 1.2;
    const vpos    = globalStyle.verticalPosition  || 'center';

    // ── font helper ────────────────────────────────────────────────────
    function fontStr(size, st) {
      const w = st && st.fontWeight === 'bold'  ? 'bold '   : '';
      const i = st && st.fontStyle  === 'italic' ? 'italic ' : '';
      const f = (st && st.fontFamily) || 'Arial';
      return `${i}${w}${size}px "${f}"`;
    }

    // ── shadow / stroke helpers ────────────────────────────────────────
    function applyEffects(ctx, st) {
      const bl = ((st && st.shadowBlur)  || 0) * _normScale;
      const sx = ((st && st.shadowX)     || 0) * _normScale;
      const sy = ((st && st.shadowY)     || 0) * _normScale;
      if (bl > 0 || sx !== 0 || sy !== 0) {
        ctx.shadowColor   = (st && st.shadowColor) || '#000';
        ctx.shadowBlur    = bl;
        ctx.shadowOffsetX = sx;
        ctx.shadowOffsetY = sy;
      }
    }
    function clearEffects(ctx) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    }
    function drawTextEx(text, x, y, st) {
      applyEffects(ctx, st);
      const sw = ((st && st.strokeWidth) || 0) * _normScale;
      if (sw > 0) {
        ctx.strokeStyle = (st && st.strokeColor) || '#000';
        ctx.lineWidth = sw; ctx.lineJoin = 'round';
        ctx.strokeText(text, x, y);
      }
      ctx.fillText(text, x, y);
      clearEffects(ctx);
    }

    // ── Verse number (top-left) ────────────────────────────────────────
    if (content.number) {
      const mult = (numberStyle && numberStyle.sizeMultiplier) ? numberStyle.sizeMultiplier : 0.6;
      ctx.font       = fontStr(baseFontSize * mult, numberStyle);
      ctx.fillStyle  = (numberStyle && numberStyle.color) || '#fff';
      ctx.textAlign  = 'left';
      ctx.textBaseline = 'top';
      drawTextEx(content.number, areaLeft, areaTop, numberStyle);
    }

    // ── Main text ──────────────────────────────────────────────────────
    if (content.text) {
      const normalTextColor    = (textStyle && textStyle.color) || '#fff';
      const subscriptColor     = (subscriptStyle && subscriptStyle.color) || '#ddd';
      const subscriptMultiplier = (subscriptStyle && subscriptStyle.sizeMultiplier) || 0.6;
      const textAlign          = (textStyle && textStyle.textAlign) || 'center';

      if ('letterSpacing' in ctx)
        ctx.letterSpacing = (textStyle && textStyle.letterSpacing) ? `${textStyle.letterSpacing * _normScale}px` : '0px';

      const _rawText = (content.type === 'song' && globalStyle.songInline)
        ? (content.text || '').split('\n').map(l => l.trim()).filter(l => l.length > 0).map(l => /[.!?,;:]$/.test(l) ? l : l + '.').join(' ')
        : content.text;
      const textLines = _rawText.split('\n');

      function buildLines(size) {
        ctx.font = fontStr(size, textStyle);
        const all = [];
        textLines.forEach(tl => {
          const segs = parseVerseSegments(tl);
          segs.forEach(s => { if (!s.isNumber) s.words = parseInlineMarkdownWords(s.text); });
          all.push(...wrapTextWithSubscripts(ctx, segs, availableWidth, size, subscriptMultiplier, (textStyle && textStyle.fontFamily) || 'Arial'));
        });
        return all;
      }

      let lines = buildLines(baseFontSize);

      while (true) {
        const ts = baseFontSize + 4;
        const tl = buildLines(ts);
        if (tl.length * ts * lhMult < availableHeight * 0.85 && ts < displayHeight * 0.15) { baseFontSize = ts; lines = tl; } else break;
      }
      while (lines.length * baseFontSize * lhMult > availableHeight && baseFontSize > 20) {
        baseFontSize -= 2; lines = buildLines(baseFontSize);
      }

      const lineHeight  = baseFontSize * lhMult;
      const totalHeight = lines.length * lineHeight;
      let startY = vpos === 'top' ? areaTop : vpos === 'bottom' ? areaBottom - totalHeight : (isDual ? primaryRegionH / 2 - totalHeight / 2 : areaTop + areaHeight / 2 - totalHeight / 2);

      lines.forEach((line, i) => {
        const lineY = startY + i * lineHeight + baseFontSize / 2;
        // measure total line width
        let totalW = 0;
        line.forEach(seg => {
          if (seg.isNumber) {
            ctx.font = fontStr(baseFontSize * subscriptMultiplier, subscriptStyle);
            totalW += ctx.measureText(seg.text + ' ').width;
          } else {
            const merged = { ...(textStyle||{}), fontWeight: seg.bold ? 'bold' : (textStyle && textStyle.fontWeight), fontStyle: seg.italic ? 'italic' : (textStyle && textStyle.fontStyle) };
            ctx.font = fontStr(baseFontSize, merged);
            totalW += ctx.measureText(seg.text).width;
          }
        });
        let x = textAlign === 'left' ? areaLeft : textAlign === 'right' ? areaRight - totalW : areaLeft + areaWidth / 2 - totalW / 2;

        ctx.textBaseline = 'alphabetic';
        line.forEach(seg => {
          if (seg.isNumber) {
            const ssz = baseFontSize * subscriptMultiplier;
            ctx.font = fontStr(ssz, subscriptStyle);
            ctx.fillStyle = subscriptColor;
            ctx.textAlign = 'left';
            drawTextEx(seg.text + ' ', x, lineY + ssz * 0.35, subscriptStyle);
            ctx.font = fontStr(ssz, subscriptStyle);
            x += ctx.measureText(seg.text + ' ').width;
          } else {
            const merged = { ...(textStyle||{}), fontWeight: seg.bold ? 'bold' : (textStyle && textStyle.fontWeight), fontStyle: seg.italic ? 'italic' : (textStyle && textStyle.fontStyle) };
            ctx.font = fontStr(baseFontSize, merged);
            ctx.fillStyle = normalTextColor;
            ctx.textAlign = 'left';
            drawTextEx(seg.text, x, lineY, merged);
            ctx.font = fontStr(baseFontSize, merged);
            x += ctx.measureText(seg.text).width;
          }
        });
        ctx.textBaseline = 'middle';
      });

      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    // ── Reference (bottom-right) ───────────────────────────────────────
    if (content.reference) {
      const mult = (referenceStyle && referenceStyle.sizeMultiplier) ? referenceStyle.sizeMultiplier : 0.7;
      const referenceFontSize = Math.min(baseFontSize * mult, displayHeight * 0.045);
      ctx.font      = fontStr(referenceFontSize, referenceStyle);
      ctx.fillStyle = (referenceStyle && referenceStyle.color) || '#fff';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      const _refY = isDual ? (primaryRegionH - areaTop * 0.5) : areaBottom;
      drawTextEx(content.reference, areaRight, _refY, referenceStyle);
    }

    // ── Hint ──────────────────────────────────────────────────────────
    if (content.showHint) {
      const hintFontSize = Math.min(baseFontSize * 0.6, displayHeight * 0.04);
      ctx.font = fontStr(hintFontSize, null);
      ctx.fillStyle = '#ddd'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      const _hintY = isDual ? (primaryRegionH - areaTop * 0.5) : areaBottom;
      ctx.fillText(content.showHint, areaRight, _hintY - hintFontSize * 1.8);
    }

    // ── Secondary translation ──────────────────────────────────────────
    if (isDual) {
      const dividerY = displayHeight * 0.56;
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = (referenceStyle && referenceStyle.color) || '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(areaLeft, dividerY);
      ctx.lineTo(areaRight, dividerY);
      ctx.stroke();
      ctx.restore();

      const secAreaTop = dividerY + padding * 0.5;
      const secAreaH = displayHeight - secAreaTop - padding * 0.5;

      if (content.secondaryRef) {
        const secRefMult = (referenceStyle && referenceStyle.sizeMultiplier) ? referenceStyle.sizeMultiplier * 0.8 : 0.55;
        const secondaryRefFontSize = Math.min(baseFontSize * secRefMult, displayHeight * 0.036);
        ctx.font = fontStr(secondaryRefFontSize, referenceStyle);
        ctx.fillStyle = (referenceStyle && referenceStyle.color) || '#fff';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.globalAlpha = 0.7;
        drawTextEx(content.secondaryRef, areaRight, areaBottom, referenceStyle);
        ctx.globalAlpha = 1.0;
      }

      if (content.secondaryText) {
        const secTextColor = (textStyle && textStyle.color) || '#fff';
        const subscriptMultiplier = (subscriptStyle && subscriptStyle.sizeMultiplier) || 0.6;
        const secTextFF = (textStyle && textStyle.fontFamily) || 'Arial';
        const secTextAlign = (textStyle && textStyle.textAlign) || 'center';
        if ('letterSpacing' in ctx) ctx.letterSpacing = (textStyle && textStyle.letterSpacing) ? `${textStyle.letterSpacing * _normScale}px` : '0px';
        let secFontSize = displayHeight * 0.065;
        const secTextLines = content.secondaryText.split('\n');
        function buildSecLines(size) {
          ctx.font = fontStr(size, textStyle);
          const all = [];
          secTextLines.forEach(tl => {
            const segs = parseVerseSegments(tl);
            segs.forEach(s => { if (!s.isNumber) s.words = parseInlineMarkdownWords(s.text); });
            all.push(...wrapTextWithSubscripts(ctx, segs, availableWidth, size, subscriptMultiplier, secTextFF));
          });
          return all;
        }
        let secLines = buildSecLines(secFontSize);
        while (true) {
          const ts = secFontSize + 4, tl = buildSecLines(ts);
          if (tl.length * ts * lhMult < secAreaH * 0.8 && ts < displayHeight * 0.12) { secFontSize = ts; secLines = tl; } else break;
        }
        while (secLines.length * secFontSize * lhMult > secAreaH && secFontSize > 14) {
          secFontSize -= 2; secLines = buildSecLines(secFontSize);
        }
        const secLH = secFontSize * lhMult;
        const secTotalH = secLines.length * secLH;
        let secStartY = secAreaTop + secAreaH / 2 - secTotalH / 2;
        ctx.globalAlpha = 0.85;
        secLines.forEach((line, i) => {
          const lineY = secStartY + i * secLH + secFontSize / 2;
          let totalW = 0;
          line.forEach(seg => {
            if (seg.isNumber) {
              ctx.font = fontStr(secFontSize * subscriptMultiplier, subscriptStyle);
              totalW += ctx.measureText(seg.text + ' ').width;
            } else {
              const merged = { ...(textStyle||{}), fontWeight: seg.bold ? 'bold' : (textStyle && textStyle.fontWeight), fontStyle: seg.italic ? 'italic' : (textStyle && textStyle.fontStyle) };
              ctx.font = fontStr(secFontSize, merged);
              totalW += ctx.measureText(seg.text).width;
            }
          });
          let x = secTextAlign === 'left' ? areaLeft : secTextAlign === 'right' ? areaRight - totalW : areaLeft + areaWidth / 2 - totalW / 2;
          ctx.textBaseline = 'alphabetic';
          line.forEach(seg => {
            if (seg.isNumber) {
              const ssz = secFontSize * subscriptMultiplier;
              ctx.font = fontStr(ssz, subscriptStyle);
              ctx.fillStyle = (subscriptStyle && subscriptStyle.color) || '#ddd';
              ctx.textAlign = 'left';
              drawTextEx(seg.text + ' ', x, lineY + ssz * 0.35, subscriptStyle);
              ctx.font = fontStr(ssz, subscriptStyle);
              x += ctx.measureText(seg.text + ' ').width;
            } else {
              const merged = { ...(textStyle||{}), fontWeight: seg.bold ? 'bold' : (textStyle && textStyle.fontWeight), fontStyle: seg.italic ? 'italic' : (textStyle && textStyle.fontStyle) };
              ctx.font = fontStr(secFontSize, merged);
              ctx.fillStyle = secTextColor;
              ctx.textAlign = 'left';
              drawTextEx(seg.text, x, lineY, merged);
              ctx.font = fontStr(secFontSize, merged);
              x += ctx.measureText(seg.text).width;
            }
          });
          ctx.textBaseline = 'middle';
        });
        ctx.globalAlpha = 1.0;
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      }
    }

    ctx.textBaseline = 'middle';
    if (onRenderComplete) onRenderComplete();
  } // end renderTextContent
}

/**
 * Parse text into segments of verse numbers and text
 * Format: "2  In the beginning... 3  And God said..."
 */
function parseVerseSegments(text) {
  const segments = [];
  const regex = /(\d+)\s{2}/g;
  let lastIndex = 0;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    // Add text before this verse number
    if (match.index > lastIndex) {
      const textBefore = text.substring(lastIndex, match.index).trim();
      if (textBefore) segments.push({ isNumber: false, text: textBefore });
    }
    // Add verse number
    segments.push({ isNumber: true, text: match[1] });
    lastIndex = regex.lastIndex;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex).trim();
    if (remaining) segments.push({ isNumber: false, text: remaining });
  }
  
  return segments;
}

/**
 * Wrap text with subscript segments
 */
function wrapTextWithSubscripts(ctx, segments, maxWidth, baseFontSize, subscriptMultiplier, textFontFamily) {
  const lines = [];
  let currentLine = [];
  let currentWidth = 0;
  
  const subscriptSize = baseFontSize * (subscriptMultiplier || 0.6);
  const tf = textFontFamily || 'Arial';
  
  segments.forEach(seg => {
    if (seg.isNumber) {
      // Measure subscript number
      ctx.font = `${subscriptSize}px "${tf}"`;
      const width = ctx.measureText(seg.text + ' ').width;
      
      if (currentWidth + width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = [];
        currentWidth = 0;
      }
      
      currentLine.push(seg);
      currentWidth += width;
      ctx.font = `${baseFontSize}px "${tf}"`;
    } else {
      // If seg.words exists (parsed with inline markdown), use those styled words
      const words = seg.words ? seg.words : seg.text.split(' ');
      words.forEach((wordObj, idx) => {
        const wordText = typeof wordObj === 'string' ? wordObj : wordObj.text;
        const testWord = wordText + (idx < words.length - 1 ? ' ' : '');
        // Set font according to inline style for accurate measurement
        if (typeof wordObj !== 'string') {
          const styleFont = `${wordObj.italic ? 'italic ' : ''}${wordObj.bold ? 'bold ' : ''}${baseFontSize}px "${tf}"`;
          ctx.font = styleFont;
        } else {
          ctx.font = `${baseFontSize}px "${tf}"`;
        }
        const width = ctx.measureText(testWord).width;
        
        if (currentWidth + width > maxWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [];
          currentWidth = 0;
        }
        
        // Preserve style info in pushed segment
        if (typeof wordObj === 'string') {
          currentLine.push({ isNumber: false, text: testWord });
        } else {
          currentLine.push({ isNumber: false, text: testWord, bold: !!wordObj.bold, italic: !!wordObj.italic });
        }
        currentWidth += width;
      });
    }
  });
  
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  
  return lines;
}

/**
 * Render a line with subscript verse numbers
 */
function renderLineWithSubscripts(ctx, segments, centerX, y, baseFontSize, colors = {}) {
  // Calculate total width
  const subscriptSize = baseFontSize * (colors.subscriptMultiplier || 0.6);
  let totalWidth = 0;
  
  segments.forEach(seg => {
    if (seg.isNumber) {
      ctx.font = `${subscriptSize}px Arial`;
      totalWidth += ctx.measureText(seg.text + ' ').width;
    } else {
      // Determine font for measurement if style flags exist
      const fontStr = `${seg && seg.italic ? 'italic ' : ''}${seg && seg.bold ? 'bold ' : ''}${baseFontSize}px Arial`;
      ctx.font = fontStr;
      totalWidth += ctx.measureText(seg.text).width;
    }
  });
  
  // Start from left of center
  let x = centerX - (totalWidth / 2);
  
  ctx.textBaseline = 'alphabetic';  // Use alphabetic baseline for consistent rendering
  
  segments.forEach(seg => {
    if (seg.isNumber) {
      // Render subscript (smaller, slightly lower)
      ctx.font = `${subscriptSize}px Arial`;
      ctx.fillStyle = (colors && colors.subscriptColor) ? colors.subscriptColor : '#ddd';
      ctx.textAlign = 'left';
      ctx.fillText(seg.text + ' ', x, y + (subscriptSize * 0.35));
      x += ctx.measureText(seg.text + ' ').width;
      ctx.fillStyle = (colors && colors.textColor) ? colors.textColor : '#fff';
    } else {
      // Render normal text, honoring bold/italic flags if present
      const fontStr = `${seg && seg.italic ? 'italic ' : ''}${seg && seg.bold ? 'bold ' : ''}${baseFontSize}px Arial`;
      ctx.font = fontStr;
      ctx.textAlign = 'left';
      ctx.fillStyle = (colors && colors.textColor) ? colors.textColor : '#fff';
      ctx.fillText(seg.text, x, y);
      x += ctx.measureText(seg.text).width;
    }
  });
  
  ctx.textBaseline = 'middle';  // Reset to middle
}

/**
 * Wrap text to fit within a given width
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (let word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Parse inline Markdown in a string into an array of word objects with style flags
 * Supports: **bold**, __bold__, *italic*, _italic_
 */
function parseInlineMarkdownWords(s) {
  const out = [];
  if (!s) return out;

  const tokenRegex = /(\*\*|__)([\s\S]+?)\1|(\*|_)([\s\S]+?)\3/g;
  let lastIndex = 0;
  let m;

  while ((m = tokenRegex.exec(s)) !== null) {
    if (m.index > lastIndex) {
      // Plain text before this token
      const plain = s.substring(lastIndex, m.index);
      plain.split(' ').forEach((w, i, arr) => {
        if (w === '') return;
        const add = i < arr.length - 1 ? w + ' ' : w;
        out.push({ text: add, bold: false, italic: false });
      });
    }

    if (m[1] && m[2]) {
      // Bold using ** or __
      m[2].split(' ').forEach((w, i, arr) => {
        if (w === '') return;
        const add = i < arr.length - 1 ? w + ' ' : w;
        out.push({ text: add, bold: true, italic: false });
      });
    } else if (m[3] && m[4]) {
      // Italic using * or _
      m[4].split(' ').forEach((w, i, arr) => {
        if (w === '') return;
        const add = i < arr.length - 1 ? w + ' ' : w;
        out.push({ text: add, bold: false, italic: true });
      });
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < s.length) {
    const rest = s.substring(lastIndex);
    rest.split(' ').forEach((w, i, arr) => {
      if (w === '') return;
      const add = i < arr.length - 1 ? w + ' ' : w;
      out.push({ text: add, bold: false, italic: false });
    });
  }

  // If nothing matched, but s has no spaces, ensure we return it
  if (out.length === 0 && s.trim() !== '') out.push({ text: s, bold: false, italic: false });

  return out;
}

async function updatePreview(verseOrIndices) {
  // verseOrIndices: either a single verse object, an index, or an array of indices into allVerses
  if (typeof verseOrIndices === 'number') verseOrIndices = [verseOrIndices];

  let numberText = '';
  let textContent = '';
  let refText = '';
  let showHint = null;
  let _fittedIndices = null;
  
  if (Array.isArray(verseOrIndices)) {
    const originalCount = verseOrIndices.length;
    const indices = getFittableIndices(verseOrIndices, 800); // 800 char limit
    
    // Build concatenated passage
    const parts = indices.map(i => {
      const verseNum = allVerses[i].key.split(':')[1];
      const cleanText = allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '');
      return `${verseNum}  ${cleanText}`;
    });
    textContent = parts.join(' ');
    
    _fittedIndices = indices;
    if (indices.length === 1) {
      refText = `${allVerses[indices[0]].key} (${getPrimaryDisplayLabel()})`;
    } else if (indices.length > 1) {
      refText = `${allVerses[indices[0]].key} - ${allVerses[indices[indices.length - 1]].key} (${getPrimaryDisplayLabel()})`;
      if (indices.length < originalCount) {
        showHint = `Showing ${indices.length} of ${originalCount} selected`;
      }
    }
  } else {
    const v = verseOrIndices;
    const clean = v.text.replace(/(\.\d+[\s\S]*)$/, '');
    textContent = clean;
    numberText = v.key.split(':')[1];
    refText = `${v.key} (${getPrimaryDisplayLabel()})`;
  }
  
  // Secondary translation content for canvas
  const _secContent = _fittedIndices
    ? buildSecondaryForCanvas(_fittedIndices)
    : (() => {
        if (!dualTranslationEnabled || secondaryVerseMap.size === 0 || !verseOrIndices || !verseOrIndices.key) return {};
        const sv = secondaryVerseMap.get(verseOrIndices.key);
        if (!sv) return {};
        const vn = verseOrIndices.key.split(':')[1];
        return {
          secondaryText: `${vn}  ${sv.text.replace(/(\.(\d+)[\s\S]*)$/, '')}`,
          secondaryRef: `${verseOrIndices.key} (${getSecondaryDisplayName()})`
        };
      })();

  // Get external display dimensions
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  // Render to preview canvas
  const previewCanvas = document.getElementById('preview-canvas');
  if (previewCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.verses);
    const previewContent = {
      number: numberText,
      text: textContent,
      reference: refText,
      showHint: showHint,
      backgroundMedia: backgroundMedia,
      styles: getCanvasStylesFor('verse'),
      width: width,
      height: height,
      ..._secContent
    };
    window.previewContent = previewContent;
    renderToCanvas(previewCanvas, previewContent, width, height);
  }

  // Persist selection preview as last selection (single or range)
  saveLastSelectionToSettings().catch(err => console.error('Failed to persist preview selection', err));
}

async function updateLive(verseOrIndices) {
  // Stop website mirror if it was active before pushing verse content
  hideWebsiteLivePanel(true);
  hideVideoLiveBar();

  // Accept a single index, array of indices, or a verse object
  let indices = [];
  if (Array.isArray(verseOrIndices)) indices = verseOrIndices.slice();
  else if (typeof verseOrIndices === 'number') indices = [verseOrIndices];
  else if (verseOrIndices && verseOrIndices.key) {
    const idx = allVerses.findIndex(v => v.key === verseOrIndices.key);
    if (idx !== -1) indices = [idx];
  }
  if (indices.length === 0) return;

  // Fit verses to character limit
  const indicesToShow = getFittableIndices(indices, 800);
  const parts = indicesToShow.map(i => {
    const verseNum = allVerses[i].key.split(':')[1];
    const cleanText = allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '');
    return `${verseNum}  ${cleanText}`;
  });
  const textContent = parts.join(' ');
  
  const numberText = '';
  const refText = indicesToShow.length === 1 ? `${allVerses[indicesToShow[0]].key} (${getPrimaryDisplayLabel()})` : `${allVerses[indicesToShow[0]].key} - ${allVerses[indicesToShow[indicesToShow.length-1]].key} (${getPrimaryDisplayLabel()})`;
  const showHint = indicesToShow.length < indices.length ? `Showing ${indicesToShow.length} of ${indices.length} selected` : null;
  const _liveSec = buildSecondaryForCanvas(indicesToShow);
  
  // Get external display dimensions
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  // Render to live canvas (right preview - shows current live state)
  const liveCanvas = document.getElementById('live-canvas');
  if (liveCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.verses);
    const styles = getCanvasStylesFor('verse');
    window.currentContent = {
      type: 'verse',
      number: numberText,
      text: textContent,
      reference: refText,
      showHint: showHint,
      width: width,
      height: height,
      backgroundMedia: backgroundMedia,
      styles,
      ..._liveSec
    };
    // If preview is in black or clear mode, reflect that in the preview canvas
    if (blackMode) {
      // Render solid black preview
      const ctx = liveCanvas.getContext('2d');
      liveCanvas.width = width;
      liveCanvas.height = height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    } else if (clearMode) {
      // Render background without text in preview
      const contentWithoutText = {
        ...window.currentContent,
        number: '',
        text: '',
        reference: '',
        secondaryText: '',
        secondaryRef: ''
      };
      renderToCanvas(liveCanvas, contentWithoutText, width, height);
    } else {
      renderToCanvas(liveCanvas, window.currentContent, width, height);
    }
    
    // Text fade-in animation is applied only on external display (live.html)
    // Preview canvas shows instantly at full opacity
  }

  // Send update to the external live window with plain text (canvas needs plain text, not HTML)
  const backgroundMedia = getBackgroundMedia(defaultBackgrounds.verses);
  console.log('[DEBUG] Sending backgroundMedia to live window:', backgroundMedia);
  ipcRenderer.send('update-live-window', {
    number: numberText,
    text: textContent,  // Send plain text with double-space format for canvas rendering
    reference: refText,
    showingCount: indicesToShow.length,
    totalSelected: indices.length,
    backgroundMedia: backgroundMedia,
    styles: getCanvasStylesFor('verse'),
    _displayStyleOverrides: getPerDisplayStyleOverrides('verse') || undefined,
    transitionIn: transitionSettings['fade-in'],
    transitionOut: transitionSettings['fade-out'],
    ..._liveSec
  });
  
  // Push state to relay for mobile to display
  try {
    // Convert verse indices to relay state format
    const verseReferences = indicesToShow.map(i => allVerses[i].key);
    const bibleState = parseVerseReferenceWithRange(verseReferences);
    
    // Add verse text to the state for mobile display
    if (bibleState.length > 0 && indicesToShow.length > 0) {
      // Combine text from all displayed verses
      const displayText = indicesToShow.map(i => {
        const verseNum = allVerses[i].key.split(':')[1];
        const cleanText = allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '');
        return `${verseNum}  ${cleanText}`;
      }).join('\n\n');
      
      // Add text to first (or only) bible state entry
      bibleState[0].text = displayText;
    }
    
    // Find and include schedule information if verses are from schedule
    let scheduleInfo = [];
    if (scheduleItems.length > 0) {
      // Find which schedule item(s) contain these indices
      const matchingScheduleIndices = [];
      scheduleItems.forEach((item, idx) => {
        const itemIndices = new Set(item.indices);
        const isMatch = indicesToShow.every(i => itemIndices.has(i));
        if (isMatch) {
          matchingScheduleIndices.push(idx);
        }
      });
      
      // If we found matching schedule items, add them to the state
      if (matchingScheduleIndices.length > 0) {
        currentLiveScheduleIndex = matchingScheduleIndices[0];
        scheduleInfo = matchingScheduleIndices.map(idx => ({
          index: idx,
          label: getScheduleItemLabel(scheduleItems[idx].indices),
          type: scheduleItems[idx].type,
          indices: scheduleItems[idx].indices
        }));
      }
    }
    
    const state = {
      bible: bibleState,
      songs: [],
      schedule: scheduleInfo,
      scheduling: {
        totalItems: scheduleItems.length,
        currentItem: currentLiveScheduleIndex,
        hasSchedule: scheduleItems.length > 0
      },
      allScheduleItems: buildRelayAllScheduleItems(),
      allSongs: allSongs.map((song, idx) => ({
        index: idx,
        title: song.title,
        author: song.author || '',
        lyrics: song.lyrics || []
      })),
      lastUpdated: Date.now()
    };
    console.log('[relay] Pushing state:', JSON.stringify(state));
    state.remoteCanvases = getRemoteCanvasSnapshots();
    lastRelayState = state;
    await ipcRenderer.invoke('relay-push-state', state);
  } catch (err) {
    console.error('[relay] Failed to push state:', err);
  }
}

// Helper: Parse verse references and handle ranges (e.g., Genesis 1:1-5, or multiple ranges)
function parseVerseReferenceWithRange(verseKeys) {
  if (!verseKeys || verseKeys.length === 0) return [];
  
  // Group consecutive verses together
  const groups = [];
  let currentGroup = {
    key: verseKeys[0],
    verses: [verseKeys[0]]
  };
  
  for (let i = 1; i < verseKeys.length; i++) {
    const prevKey = verseKeys[i - 1];
    const currKey = verseKeys[i];
    
    // Check if consecutive (same book and chapter, verse number incremented by 1)
    const prevMatch = prevKey.match(/^(.+)\s(\d+):(\d+)$/);
    const currMatch = currKey.match(/^(.+)\s(\d+):(\d+)$/);
    
    if (prevMatch && currMatch) {
      const [, prevBook, prevChap, prevVerse] = prevMatch;
      const [, currBook, currChap, currVerse] = currMatch;
      
      // Check if same book, same chapter, and verse is consecutive
      if (prevBook === currBook && prevChap === currChap && 
          parseInt(currVerse) === parseInt(prevVerse) + 1) {
        currentGroup.verses.push(currKey);
      } else {
        // Not consecutive - start new group
        groups.push(currentGroup);
        currentGroup = {
          key: currKey,
          verses: [currKey]
        };
      }
    } else {
      groups.push(currentGroup);
      currentGroup = {
        key: currKey,
        verses: [currKey]
      };
    }
  }
  groups.push(currentGroup);
  
  // Convert groups to state format
  return groups.map(group => {
    const firstKey = group.verses[0];
    const lastKey = group.verses[group.verses.length - 1];
    
    const firstMatch = firstKey.match(/^(.+)\s(\d+):(\d+)$/);
    const lastMatch = lastKey.match(/^(.+)\s(\d+):(\d+)$/);
    
    if (!firstMatch || !lastMatch) return null;
    
    const [, bookFirst, chapterFirst, verseFirst] = firstMatch;
    const [, bookLast, , verseLast] = lastMatch;
    
    return {
      book: bookFirst.trim(),
      chapter: parseInt(chapterFirst, 10),
      startVerse: parseInt(verseFirst, 10),
      endVerse: parseInt(verseLast, 10),
      length: group.verses.length  // Help mobile display ranges properly
    };
  }).filter(v => v !== null);
}

// Scaling is handled in scaleTextSize for both

function scaleTextSize(textLength) {
  const verseTextEl = document.getElementById('verse-text');
  const baseSize = 2; // em

  // Fit text to container height
  let fontSize = 2.5; // max
  verseTextEl.style.fontSize = `${fontSize}em`;

  // Return a promise that resolves when sizing has settled
  return new Promise((resolve) => {
    setTimeout(() => {
      while (verseTextEl.scrollHeight > verseTextEl.clientHeight && fontSize > 0.5) {
        fontSize -= 0.1;
        verseTextEl.style.fontSize = `${fontSize}em`;
      }
      // Scale other preview elements proportionally
      const ratio = fontSize / baseSize;
      document.getElementById('verse-number').style.fontSize = `${1.5 * ratio}em`;
      // document.getElementById('verse-reference').style.fontSize = `${0.8 * ratio}em`; // Keep fixed size

      // Note: Do NOT update live display from preview scaling
      // Live display sizing is handled independently when updateLive() is called
      
      resolve();
    }, 0);
  });
}

/**
 * Return the subset of selectedIndices that fit into the verse display area.
 * This function measures the rendered height in a hidden clone and returns
 * the largest prefix of the selection that fits.
 */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Return the subset of selectedIndices that fit within a character limit.
 * Verses are included in order until adding the next one would exceed the limit.
 * This ensures the preview/live display doesn't try to render excessively long passages.
 */
function getFittableIndices(indices, maxChars = 800) {
  if (!indices || indices.length === 0) return [];
  
  const sorted = indices.slice().sort((a,b) => a-b);
  const fittable = [];
  let totalChars = 0;

  for (let idx of sorted) {
    const verseNum = allVerses[idx].key.split(':')[1];
    const cleanText = allVerses[idx].text.replace(/(\.\d+[\s\S]*)$/, '');
    // Rough estimate: subscript markup + verse text
    const charCount = (`<sub>${verseNum}</sub> ${cleanText} `).length;
    
    if (totalChars + charCount > maxChars && fittable.length > 0) {
      // Adding this verse would exceed limit, stop here
      break;
    }
    
    fittable.push(idx);
    totalChars += charCount;
  }

  // If nothing fits, at least show the first selected verse
  if (fittable.length === 0 && sorted.length > 0) return [sorted[0]];
  return fittable;
}

// Update only the .selected class on currently-rendered verse items.
// This avoids destroying+recreating DOM nodes (which breaks browser dblclick detection).
function updateSelectionClasses(selectedIndices) {
  const wrapper = document.getElementById('virtual-list');
  if (!wrapper) return;
  wrapper.querySelectorAll('.verse-item').forEach(el => {
    const idx = parseInt(el.getAttribute('data-index'), 10);
    el.classList.toggle('selected', selectedIndices.includes(idx));
  });
}

async function handleVerseClick(i, e) {
  // Support shift-range selection
  if (e && e.shiftKey) {
    // If no anchor set, fall back to current selection or the clicked index
    if (anchorIndex === null) {
      if (selectedIndices && selectedIndices.length > 0) anchorIndex = selectedIndices[0];
      else anchorIndex = i;
    }
    const start = Math.min(anchorIndex, i);
    const end = Math.max(anchorIndex, i);
    selectedIndices = [];
    for (let k = start; k <= end; k++) selectedIndices.push(k);
  } else {
    selectedIndices = [i];
    anchorIndex = i;
  }

  console.debug('handleVerseClick selectedIndices', selectedIndices, 'anchor', anchorIndex, 'event.shiftKey', !!(e && e.shiftKey));

  updateVerseDisplay();
  // Only update preview if on verses tab
  if (currentTab === 'verses') {
    await updatePreview(selectedIndices);
  }
  // Update selection highlight in-place without rebuilding DOM nodes.
  // A full renderWindow call here destroys every <div> and creates new ones,
  // which prevents the browser from firing dblclick (the element instance changes).
  updateSelectionClasses(selectedIndices);

  // Focus the clicked item after re-render so Enter will work
  const el = document.querySelector(`.verse-item[data-index="${i}"]`);
  if (el) setTimeout(() => el.focus(), 0);

  // Persist the selection
  try {
    await saveLastSelectionToSettings();
  } catch (err) {
    console.error('Failed to persist selection:', err);
  }
}

async function handleVerseDoubleClick(i) {
  // Media tab: go live with the selected media item
  if (currentTab === 'media') {
    if (selectedMediaIndex !== null && allMedia[selectedMediaIndex]) {
      await displayMediaOnLive(allMedia[selectedMediaIndex]);
    }
    return;
  }

  // Check if we're in songs tab
  if (currentTab === 'songs') {
    if (selectedSongIndices.length > 0 && selectedSongVerseIndex !== null) {
      if (!liveMode) {
        // Create the window first, then push content
        await toggleLive(true);
        await updateLiveFromSongVerse(selectedSongVerseIndex);
      } else {
        await updateLiveFromSongVerse(selectedSongVerseIndex);
      }
      return;
    } else {
      return; // nothing to do in songs tab without selection
    }
  }
  
  // Verses tab logic
  // If an index is explicitly provided, treat as a single-verse go-live action.
  // If an array of indices is provided, use those.
  // Otherwise, use the current selection (useful for the Live toggle behavior).
  let indicesToGo = [];
  if (Array.isArray(i)) {
    indicesToGo = i.slice();
  } else if (typeof i === 'number') {
    indicesToGo = [i];
  } else if (selectedIndices && selectedIndices.length > 0) {
    indicesToGo = selectedIndices.slice();
  } else {
    return; // nothing to do
  }

  // Do not change clear/black mode here - respect user's current display mode

  if (!liveMode) {
    // Create the window first, then push the content
    await toggleLive(true);
    // Explicitly update with the double-clicked verse(s)
    await updateLive(indicesToGo);
  } else {
    // Window already open — push content directly
    await updateLive(indicesToGo);
  }

  // Persist live selection as the last selected verse (single or array)
  if (Array.isArray(i)) {
    // Don't change selectedIndices when coming from schedule
  } else if (typeof i === 'number') {
    selectedIndices = [i];
  }
  saveLastSelectionToSettings().catch(err => console.error('Failed to persist live selection', err));
}

// Update search box when navigating verses with arrow keys
function updateSearchBoxForVerse(verseIndex) {
  const verse = allVerses[verseIndex];
  if (!verse || !verse.key) return;
  
  const searchInput = document.getElementById('search-autocomplete-input');
  if (searchInput) {
    searchInput.value = verse.key;
    // Trigger the search box update event so it highlights the match
    searchInput.dispatchEvent(new Event('input'));
  }
}

function selectNextVerse(extendSelection = false) {
  if (!selectedIndices.length) {
    selectedIndices = [0];
    anchorIndex = 0;
  } else {
    const lastIndex = selectedIndices[selectedIndices.length - 1];
    if (lastIndex < allVerses.length - 1) {
      if (extendSelection) {
        // Extend selection from anchor
        if (anchorIndex === null) anchorIndex = selectedIndices[0];
        const newIndex = lastIndex + 1;
        
        // Build range from anchor to new index
        selectedIndices = [];
        const start = Math.min(anchorIndex, newIndex);
        const end = Math.max(anchorIndex, newIndex);
        for (let i = start; i <= end; i++) {
          selectedIndices.push(i);
        }
      } else {
        // Move selection to next verse
        selectedIndices = [lastIndex + 1];
        anchorIndex = selectedIndices[0];
      }
    }
  }
  
  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;
  
  // Scroll to make the last selected verse visible
  const targetIndex = selectedIndices[selectedIndices.length - 1];
  listContainer.scrollTop = targetIndex * ITEM_HEIGHT;
  
  updateVerseDisplay();
  updatePreview(selectedIndices);
  
  // Re-render after scroll to ensure the item is visible
  renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  
  // Blur any focused element to ensure global keyboard handler works properly
  if (document.activeElement) {
    document.activeElement.blur();
  }
  
  // Update search box with new verse reference
  updateSearchBoxForVerse(targetIndex);
}

function selectPrevVerse(extendSelection = false) {
  if (!selectedIndices.length) {
    selectedIndices = [0];
    anchorIndex = 0;
  } else {
    const firstIndex = selectedIndices[0];
    if (firstIndex > 0) {
      if (extendSelection) {
        // Extend selection from anchor
        if (anchorIndex === null) anchorIndex = selectedIndices[0];
        const newIndex = firstIndex - 1;
        
        // Build range from anchor to new index
        selectedIndices = [];
        const start = Math.min(anchorIndex, newIndex);
        const end = Math.max(anchorIndex, newIndex);
        for (let i = start; i <= end; i++) {
          selectedIndices.push(i);
        }
      } else {
        // Move selection to previous verse
        selectedIndices = [firstIndex - 1];
        anchorIndex = selectedIndices[0];
      }
    }
  }
  
  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;
  
  // Scroll to make the first selected verse visible
  const targetIndex = selectedIndices[0];
  listContainer.scrollTop = targetIndex * ITEM_HEIGHT;
  
  updateVerseDisplay();
  updatePreview(selectedIndices);
  
  // Re-render after scroll to ensure the item is visible
  renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  
  // Blur any focused element to ensure global keyboard handler works properly
  setTimeout(() => {
    const el = document.querySelector(`.verse-item[data-index="${targetIndex}"]`);
    if (el) el.focus();
  }, 5);
  
  // Update search box with new verse reference
  updateSearchBoxForVerse(targetIndex);
}

// Schedule navigation functions
function selectNextScheduleItem() {
  if (scheduleItems.length === 0) return;
  
  // Find current schedule item index
  let currentIndex = currentLiveScheduleIndex !== null ? currentLiveScheduleIndex : 0;
  const nextIndex = (currentIndex + 1) % scheduleItems.length;
  
  // Get the verses from the next schedule item and display them
  const nextItem = scheduleItems[nextIndex];
  handleVerseDoubleClick(nextItem.indices);
}

function selectPrevScheduleItem() {
  if (scheduleItems.length === 0) return;
  
  // Find current schedule item index
  let currentIndex = currentLiveScheduleIndex !== null ? currentLiveScheduleIndex : 0;
  const prevIndex = (currentIndex - 1 + scheduleItems.length) % scheduleItems.length;
  
  // Get the verses from the previous schedule item and display them
  const prevItem = scheduleItems[prevIndex];
  handleVerseDoubleClick(prevItem.indices);
}

async function toggleLive(isActive) {
  liveMode = !!isActive;
  if (isActive) {
    // Await window creation so IPC messages sent immediately after are received
    await ipcRenderer.invoke('create-live-window');
    
    // Display based on current tab and selection
    if (currentTab === 'media' && selectedMediaIndex !== null) {
      const media = allMedia[selectedMediaIndex];
      if (media) {
        displayMediaOnLive(media);
      }
    } else if (currentTab === 'songs' && selectedSongIndices.length > 0 && selectedSongVerseIndex !== null) {
      updateLiveFromSongVerse(selectedSongVerseIndex);
    } else if (currentTab === 'verses' && selectedIndices.length > 0) {
      updateLive(selectedIndices);
    }
  } else {
    ipcRenderer.invoke('close-live-window');
    pushScheduleUpdate();
  }
  // Update the Live button state in the UI
  updateLiveButtonState(isActive);
}

function updateLiveButtonState(isActive) {
  if (window.liveButton) {
    if (isActive) {
      window.liveButton.classList.add('active');
    } else {
      window.liveButton.classList.remove('active');
    }
  }
}

// ------------------ License / Auth Integration ------------------

async function getSavedToken() {
  try {
    const t = await secure.getToken();
    if (t) return t;
    // Fallback to settings (legacy)
    try {
      const s = await ipcRenderer.invoke('load-settings');
      if (s && s.auth && s.auth.token) return s.auth.token;
    } catch (e) {}
    return null;
  } catch (e) {
    console.error('secure get error', e);
    return null;
  }
}

async function saveToken(token) {
  try {
    let ok = false;
    try { ok = await secure.setToken(token); } catch (e) { console.error('secure.setToken exception', e); ok = false; }

    // Always mirror token in settings as a backup so restarts can recover reliably
    try { await ipcRenderer.invoke('update-settings', { auth: { token } }); } catch (e) { console.error('mirror settings save failed', e); }

    if (ok) {
      try { await ipcRenderer.invoke('update-settings', { lastAuthSavedAt: Date.now(), authStorage: 'keytar' }); } catch (e) {}
      return true;
    } else {
      // Keytar not available or failed — settings now contain token as fallback
      try { await ipcRenderer.invoke('update-settings', { lastAuthSavedAt: Date.now(), authStorage: 'settings' }); } catch (e) {}
      return true;
    }
  } catch (e) { console.error('secure set error', e); return false; }
}

async function clearToken() {
  try {
    await secure.deleteToken();
  } catch (e) { console.error('secure delete error', e); }
  try { await ipcRenderer.invoke('update-settings', { auth: null, lastAuthSavedAt: null, authStorage: null }); } catch (e) {}
}

async function createSetupModal() {
  // Create a full-screen overlay modal for initial setup
  if (document.getElementById('setup-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'setup-modal';
  modal.className = 'setup-overlay';
  // Inline fixed positioning as a fallback (ensures overlay centers correctly even if stylesheet is overridden)
  modal.style.position = 'fixed';
  modal.style.left = '0'; modal.style.top = '0'; modal.style.right = '0'; modal.style.bottom = '0';
  modal.style.display = 'flex'; modal.style.alignItems = 'center'; modal.style.justifyContent = 'center';
  modal.style.zIndex = '20000'; modal.style.background = 'rgba(0,0,0,0.6)';
  modal.innerHTML = `
    <div class="setup-card">
      <h2>Welcome to Liturgia</h2>
      <p id="setup-message">Sign in to validate ownership or subscribe.</p>
      <div class="form-row" style="margin-top:12px;">
        <input id="setup-email" class="input" type="email" placeholder="you@example.com" />
        <button id="btn-magic" class="btn">Send Magic Link</button>
      </div>
      <div class="form-row" style="margin-top:12px;">
        <button id="btn-enter-token" class="btn">Enter Token</button>
        <button id="btn-subscribe" class="btn primary">Subscribe / Purchase</button>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;">
        <button id="btn-continue-offline" class="btn">Continue Offline (grace)</button>
        <div id="setup-status" style="opacity:0.9;font-size:12px;color:var(--muted)"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Focus email input to let user start typing immediately
  const emailEl = document.getElementById('setup-email'); if (emailEl) setTimeout(()=>emailEl.focus(),50);

  // Resolve configured server (managed) up-front
  const _settings = await ipcRenderer.invoke('load-settings');
  const server = (_settings && _settings.licenseServer) ? _settings.licenseServer.replace(/\/$/, '') : 'https://jacqueb.me/liturgia';

  document.getElementById('btn-magic').onclick = async () => {
    const emailInput = document.getElementById('setup-email');
    const email = emailInput.value.trim();
    if (!email) { document.getElementById('setup-status').textContent = 'Enter an email'; emailInput.focus(); return; }    const btn = document.getElementById('btn-magic');
    btn.disabled = true;
    document.getElementById('setup-status').textContent = 'Sending magic link...';
    try {
      const res = await fetch(server.replace(/\/$/, '') + '/auth/magic-link.php', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(email)}&source=app`
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
      if (!res.ok) {
        const errMsg = (json && (json.error || json.message)) ? (json.error || json.message) : (res.status + ' ' + res.statusText);
        throw new Error('Network error: ' + errMsg);
      }
      if (json && json.ok) {
        // Persist chosen server so the app remembers it across restarts
        try { await ipcRenderer.invoke('update-settings', { licenseServer: server }); } catch (e) {}
        document.getElementById('setup-status').textContent = 'Magic link sent — check your email (and spam/junk folder) and paste the token via "Enter Token".';
      } else {
        document.getElementById('setup-status').textContent = 'Failed to send: ' + (json && (json.error || json.message) ? (json.error || json.message) : 'Unknown error');
      }
    } catch (e) {
      console.error('Magic link request failed', e);
      document.getElementById('setup-status').textContent = 'Error sending magic link: ' + (e && e.message ? e.message : 'Network/blocked by policy');
    } finally { btn.disabled = false; }
  };

  document.getElementById('btn-enter-token').onclick = async () => {
    // Server is resolved when the modal was created (hidden from user)
    if (!server) { document.getElementById('setup-status').textContent = 'Server not configured'; return; }
    // Show inline token modal instead of prompt
    if (document.getElementById('token-entry-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'token-entry-modal';
    modal.className = 'setup-overlay';
    // Inline fixed positioning fallback to ensure proper overlay behavior
    modal.style.position = 'fixed';
    modal.style.left = '0'; modal.style.top = '0'; modal.style.right = '0'; modal.style.bottom = '0';
    modal.style.display = 'flex'; modal.style.alignItems = 'center'; modal.style.justifyContent = 'center';
    modal.style.zIndex = '20000'; modal.style.background = 'rgba(0,0,0,0.6)';
    modal.innerHTML = `
      <div class="setup-card" style="width:420px;">
        <h3>Enter Sign-in Token</h3>
        <p>Paste the token from the magic link page or generated token below.</p>
        <textarea id="token-input" class="input" style="height:80px;font-size:12px;margin-top:8px;width:100%;"></textarea>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          <button id="token-cancel" class="btn">Cancel</button>
          <button id="token-save" class="btn primary">Validate & Save</button>
        </div>
        <div id="token-status" style="margin-top:8px;color:var(--muted);font-size:12px;"></div>
      </div>
    `;
    document.body.appendChild(modal);
    // Focus the token input so users can paste immediately
    const tokenInput = document.getElementById('token-input'); if (tokenInput) setTimeout(()=>tokenInput.focus(),50);
    document.getElementById('token-cancel').onclick = () => { modal.remove(); };
    document.getElementById('token-save').onclick = async () => {
      const token = document.getElementById('token-input').value.trim();
      if (!token) { document.getElementById('token-status').textContent = 'Enter a token.'; return; }
      document.getElementById('token-status').textContent = 'Validating...';
      const result = await validateTokenAndActivate(token, server);
      if (result && result.ok) {
        const saved = await saveToken(token);
        // The first validation happens before a newly entered token is saved.
        // Cache its confirmed subscription only after persistence succeeds.
        if (saved && result.status) await cacheVerifiedLicenseStatus(token, result.status);
        // Persist the server we used so restarts keep it
        try { await ipcRenderer.invoke('update-settings', { licenseServer: server }); } catch (e) {}
        if (!saved) {
          document.getElementById('token-status').textContent = 'Signed in but failed to persist token to secure storage. It will be stored in settings as fallback.';
        } else if (result.active) {
          document.getElementById('token-status').textContent = 'Token validated and saved.';
        } else {
          document.getElementById('token-status').textContent = 'Signed in (license inactive). A watermark will be shown; activate to remove it.';
        }
        setTimeout(() => { modal.remove(); closeSetupModal(); }, 1200);
      } else {
        document.getElementById('token-status').textContent = 'Validation failed. Use admin/generate_token.php or the magic link.';
      }
    };
  };

  document.getElementById('btn-subscribe').onclick = async () => {
    // Ask for email to create checkout and open in external browser
    // 'server' variable is resolved when the modal was created (hidden from user)
    const emailInput = document.getElementById('setup-email');
    const email = emailInput.value.trim();
    if (!email) { document.getElementById('setup-status').textContent = 'Enter an email'; emailInput.focus(); return; }

    // Basic sanity check for email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { document.getElementById('setup-status').textContent = 'Enter a valid email address'; emailInput.focus(); return; }

    const btn = document.getElementById('btn-subscribe');
    btn.disabled = true;
    document.getElementById('setup-status').textContent = 'Creating checkout...';
    try {
      // Use application/x-www-form-urlencoded as Stripe expects
      const url = server.replace(/\/$/, '') + '/create-checkout-session.php';
      let res = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: `email=${encodeURIComponent(email)}&plan=monthly` });
      let j = null;
      let textBody = null;
      try { j = await res.json(); } catch (err) { textBody = await res.text().catch(()=>null); console.warn('create-checkout-session returned non-JSON'); }

      // If the server complains about content type, retry with JSON (works with newer servers)
      const errorMsg = (j && j.error) ? j.error : (textBody || '');
      if (errorMsg && /content type/i.test(errorMsg)) {
        console.warn('Server rejected urlencoded body, retrying with JSON');
        res = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:email, plan:'monthly'}) });
        try { j = await res.json(); } catch (err) { textBody = await res.text().catch(()=>null); }
      }

      if (j && j.url) { shell.openExternal(j.url); document.getElementById('setup-status').textContent = 'Checkout opened in browser.'; }
      else if (j && j.error) document.getElementById('setup-status').textContent = 'Failed to create checkout: ' + (j.error||'');
      else document.getElementById('setup-status').textContent = `Failed to create checkout: HTTP ${res.status} ${textBody||''}`;
    } catch (e) { console.error(e); document.getElementById('setup-status').textContent = 'Error creating checkout'; }
    finally { btn.disabled = false; }
  };

  document.getElementById('btn-continue-offline').onclick = async () => { closeSetupModal(); };
}

function closeSetupModal() { const m = document.getElementById('setup-modal'); if (m) m.remove(); }

// Helper: decode JWT payload without verification (UI-only)
function decodeJwtPayload(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = atob(b64);
    return JSON.parse(json);
  } catch (e) { return null; }
}

async function cacheVerifiedLicenseStatus(token, status) {
  // Cache only an active status returned by the license server. The main
  // process binds it to a token fingerprint rather than storing the token.
  try {
    if (status && status.source === 'server' && status.active) {
      await ipcRenderer.invoke('offline-license-cache:save', token, status);
    }
  } catch (e) { console.warn('offline license cache save failed', e); }
}

async function restoreOfflineLicenseStatus(token, failedReason) {
  try {
    const status = await ipcRenderer.invoke('offline-license-cache:get', token);
    if (!status) return null;
    status.reason = failedReason;
    ipcRenderer.send('license-status-update', status);
    try { setFounderFixed(!!status.founder); } catch (e) {}
    console.warn('Using saved offline license through ' + new Date(status.offlineUntil).toISOString() + ' after ' + failedReason);
    return { ok: true, active: true, offline: true, status };
  } catch (e) {
    console.warn('offline license cache restore failed', e);
    return null;
  }
}

async function validateTokenAndActivate(token, serverUrl) {
  try {
    const settings = await ipcRenderer.invoke('load-settings') || {};
    const server = (serverUrl || settings.licenseServer || '').replace(/\/$/, '');
    if (!server) {
      const offline = await restoreOfflineLicenseStatus(token, 'no-server');
      if (offline) return offline;
      ipcRenderer.send('license-status-update', { active: false, reason: 'no-server' });
      return { ok: false, reason: 'no-server' };
    }
    // Prefer query param first to avoid noisy 401s when Authorization header is stripped by proxies
    let res = null;
    try {
      res = await fetch(server + '/license-status.php?token=' + encodeURIComponent(token));
      if (res && res.status === 401) {
        try {
          console.warn('runCheck: license-status query-param rejected (401), trying Authorization header');
          res = await fetch(server + '/license-status.php', { headers: { 'Authorization': 'Bearer ' + token } });
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // network or URL error, try Authorization header as fallback
      try { res = await fetch(server + '/license-status.php', { headers: { 'Authorization': 'Bearer ' + token } }); } catch (e2) { /* ignore */ }
    }
    if (res && res.status && res.status !== 200) {
      try { console.warn('runCheck: license-status final response code', res.status); } catch(e) {}
    }

    if (res.status === 200) {
      const j = await res.json();
      try { console.info('runCheck: license-status response', j); } catch(e) {}
      // Mark as authoritative server response
      try { j.source = j.source || 'server'; } catch(e) {}
      // If server didn't return email, decode it from JWT locally
      if (!j.email) {
        try {
          const payload = decodeJwtPayload(token);
          if (payload && (payload.email || payload.sub)) j.email = payload.email || payload.sub;
        } catch(e) { /* ignore */ }
      }
      // Broadcast license status to main->live window
      ipcRenderer.send('license-status-update', j);
      // Update fixed founder immediately in this renderer (avoid timing race)
      try { setFounderFixed(!!j.founder); } catch(e) { /* ignore */ }
      await cacheVerifiedLicenseStatus(token, j);
      // Accept token if the server accepted it (200), even if not currently active.
      return { ok: true, active: !!j.active, status: j };
    }

    // If server rejects (401), allow device tokens validated via the sessions listing
    if (res.status === 401) {
      try {
        const li = await fetch(server + '/auth/list-tokens.php?token=' + encodeURIComponent(token));
        if (li && li.ok) {
          const lj = await li.json().catch(()=>null);
          if (lj && Array.isArray(lj.tokens) && lj.tokens.length > 0) {
              const email = lj.tokens[0].email || '';
            // Try to fetch richer account summary (plan & expiry) for this email
            try {
              const as = await fetch(server + '/license-status.php?token=' + encodeURIComponent(token));
              if (as && as.ok) {
                const aj = await as.json().catch(()=>null);
                if (aj && aj.ok && aj.status) {
                  const status = Object.assign({}, aj.status, { sessions: lj.tokens });
                  try { status.source = status.source || 'server'; } catch(e) {}
                  ipcRenderer.send('license-status-update', status);
                  try { setFounderFixed(!!status.founder); } catch(e) {}
                  await cacheVerifiedLicenseStatus(token, status);
                  return { ok: true, active: !!aj.status.active, status };
                }
              }
            } catch(e) { /* ignore */ }

            // If account-summary failed (500) or didn't return usable status, try to decode JWT payload locally as a fallback
            try {
              const payload = decodeJwtPayload(token);
              if (payload) {
                const pEmail = payload.email || payload.sub || '';
                const pExp = payload.exp ? payload.exp : null;
                const status = { email: pEmail || email, active: true, plan: 'token', sessions: lj.tokens };
                if (pExp) status.expires_at = pExp;
                try { status.source = 'jwt-fallback'; } catch(e) {}
                ipcRenderer.send('license-status-update', status);
                return { ok: true, active: true, status };
              }
            } catch (e) { /* ignore */ }

            const status = { email, active: true, plan: 'token', sessions: lj.tokens };
            try { status.source = 'session-fallback'; } catch(e) {}
            ipcRenderer.send('license-status-update', status);
            return { ok: true, active: true, status };
          }
        }
      } catch(e) { /* ignore */ }
    }

    const failedReason = 'http-' + (res && res.status ? res.status : 'unavailable');
    const offline = await restoreOfflineLicenseStatus(token, failedReason);
    if (offline) return offline;
    ipcRenderer.send('license-status-update', { active: false, reason: failedReason });
    return { ok: false, reason: failedReason };
  } catch (e) {
    console.error('validate error', e);
    const offline = await restoreOfflineLicenseStatus(token, 'error');
    if (offline) return offline;
    ipcRenderer.send('license-status-update', { active: false, reason: 'error', error: e.message });
    return { ok: false, reason: 'error', error: e.message };
  }
}

async function ensureAuthSetup() {
  // Called on startup. If no token, show setup modal.
  const token = await getSavedToken();
  const settings = await ipcRenderer.invoke('load-settings') || {};
  const server = settings.licenseServer || '';
  if (token) {
    const result = await validateTokenAndActivate(token, server);
    if (result && result.ok) {
      scheduleLicensePolling();
      _tutorialSignedIn = true;
      setTimeout(() => promptTutorialAfterSignIn(), 800);
      return; // proceed
    }
    
    // Don't clear token on server errors (5xx) or network errors (offline) - keep it for retry
    const reason = result && result.reason ? result.reason : '';
    const isServerError = reason && reason.match(/^http-5/);  // 500-599 errors
    const isNetworkError = reason === 'error' || reason === 'no-server';  // fetch threw (offline, DNS failure, etc.)
    
    if (isServerError || isNetworkError) {
      // Server unreachable or network error - don't clear the valid token, proceed with app
      console.warn('License check failed (' + reason + '), proceeding offline without active license verification');
      scheduleLicensePolling();
      return;
    }
    
    // Token is actually invalid - clear it and show setup
    await clearToken();
    ipcRenderer.send('license-status-update', { active: false, reason: 'invalid-token' });
  } else {
    ipcRenderer.send('license-status-update', { active: false, reason: 'no-token' });
  }
  // Show setup modal
  createSetupModal();
  scheduleLicensePolling();

  // Ensure setup modal is shown after splash closes (splash might overlay it)
  ipcRenderer.on('splash-closed', async () => {
    try {
      const token = await getSavedToken();
      if (!token) {
        if (!document.getElementById('setup-modal')) createSetupModal();
        else {
          // Ensure it's visible and focused
          const m = document.getElementById('setup-modal'); if (m) { m.style.display='flex'; const el = document.getElementById('setup-email'); if (el) setTimeout(()=>el.focus(),50); }
        }
      } else {
        const settings = await ipcRenderer.invoke('load-settings') || {};
        const server = settings.licenseServer || '';
        const res = await validateTokenAndActivate(token, server);
        if (!res || !res.ok) {
          if (!document.getElementById('setup-modal')) createSetupModal();
          else { const m = document.getElementById('setup-modal'); if (m) { m.style.display='flex'; const el = document.getElementById('setup-email'); if (el) setTimeout(()=>el.focus(),50); }}
        } else {
          _tutorialSignedIn = true;
          setTimeout(() => promptTutorialAfterSignIn(), 800);
        }
      }
      try { window.focus(); } catch(e){}
      try { ipcRenderer.invoke('focus-main-window'); } catch(e){}
    } catch (e) { console.warn('splash-closed handler error', e); }
  });

  // If the splash already closed before this handler attached, show the setup modal now
  (async function(){
    try {
      const closed = await ipcRenderer.invoke('is-splash-closed');
      if (closed) {
        const token = await getSavedToken();
        if (!token) { if (!document.getElementById('setup-modal')) createSetupModal(); }
        else { _tutorialSignedIn = true; setTimeout(() => promptTutorialAfterSignIn(), 800); }
      }
    } catch(e) { /* ignore */ }

    // Create and manage a fixed founder subtext in the bottom-right for founder users
    try {


      // Apply initial state if there is already a license status cached in main
      try {
        const s = await ipcRenderer.invoke('get-current-license-status');
        if (s && (s.founder || (s.token_payload && s.token_payload.founder))) {
          try { setFounderFixed(true); console.info && console.info('founder-fixed initial visible via cached status', s); } catch(e) {}
        }
      } catch(e) { /* ignore */ }

      // Toggle on live updates
      ipcRenderer.on('license-status', (event, status) => {
        try {
          const isFounder = !!(status && (status.founder || status.is_founder || (status.token_payload && status.token_payload.founder)));
          try { console.info('founder-fixed toggle; isFounder=', isFounder, 'status=', status); } catch(e) {}
          try { setFounderFixed(isFounder); } catch(e) { console.warn('setFounderFixed failed in license-status handler', e); }
        } catch (e) { console.warn('founder fixed toggle failed', e); }
      });
    } catch(e) { console.warn('founder fixed init failed', e); }
  })();
}

// Poll license status periodically (runs immediately and every 15 minutes)
let _licensePollIntervalId = null;

// Helper to show/hide the fixed founder subtext immediately from renderer responses
function setFounderFixed(isFounder) {
  try {
    let el = document.getElementById('founder-fixed-msg');
    if (!el) {
      el = document.createElement('div');
      el.id = 'founder-fixed-msg';
      el.className = 'founder-subtext-fixed';
      el.textContent = 'You are a founding church — thank you for your support.';
      document.body.appendChild(el);
    }
    if (isFounder) { el.classList.add('visible'); el.style.display = ''; } else { el.classList.remove('visible'); el.style.display = ''; }
  } catch (e) { console.warn('setFounderFixed failed', e); }
}

function scheduleLicensePolling() {
  if (_licensePollIntervalId) clearInterval(_licensePollIntervalId);
  const runCheck = async () => {
    const token = await getSavedToken();
    if (token) await validateTokenAndActivate(token);
    else ipcRenderer.send('license-status-update', { active: false, reason: 'no-token' });
  };
  // Run immediately
  runCheck().catch(e => { console.error('license poll error', e); ipcRenderer.send('license-status-update', { active: false, reason: 'poll-error' }); });
  _licensePollIntervalId = setInterval(() => runCheck().catch(e => { console.error('license poll error', e); ipcRenderer.send('license-status-update', { active: false, reason: 'poll-error' }); }), 15 * 60 * 1000);
} 

async function loadCoreUI() {
  // This is where previous initiation code that expects license to be checked goes
  // For now, do nothing special; the rest of DOMContentLoaded will continue.
}


async function saveLastSelectionToSettings() {
  try {
    if (!selectedIndices || selectedIndices.length === 0) {
      // remove lastSelected by setting null (server will delete key)
      await ipcRenderer.invoke('update-settings', { lastSelected: null });
    } else {
      const start = selectedIndices[0];
      const end = selectedIndices[selectedIndices.length - 1];
      await ipcRenderer.invoke('update-settings', {
        lastSelected: {
          startKey: allVerses[start].key,
          endKey: (start === end) ? null : allVerses[end].key,
          bible: currentBibleFile
        }
      });
    }
  } catch (err) {
    console.error('Failed to save last selection to settings:', err);
  }
}

function toggleBlack() {
  if (_websiteIsLive) {
    if (blackMode) {
      // Un-black while website is source: restore mirror
      blackMode = false;
      if (window.blackButton) window.blackButton.classList.remove('active');
      ipcRenderer.send('update-live-window', { isWebsite: true });
      startWebsiteMirror();
      return;
    }
    if (clearMode) {
      // Clear → Black: live window already has BG content, just switch mode
      clearMode = false; blackMode = true;
      if (window.clearButton) window.clearButton.classList.remove('active');
      if (window.blackButton) window.blackButton.classList.add('active');
      ipcRenderer.send('set-live-mode', 'black');
      return;
    }
    // Entering black from website: stop mirror polling (keeps audio), fall through to normal
    _mirrorActive = false;
    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
  }
  // If clear mode is active, switch directly to black on the live window (avoid flashing normal)
  if (clearMode) {
    clearMode = false;
    blackMode = true;

    // Update button states
    if (window.clearButton) window.clearButton.classList.remove('active');
    if (window.blackButton) window.blackButton.classList.add('active');

    // Update preview to solid black
    const liveCanvas = document.getElementById('live-canvas');
    if (liveCanvas) {
      const width = window.currentContent ? window.currentContent.width : liveCanvas.width;
      const height = window.currentContent ? window.currentContent.height : liveCanvas.height;
      liveCanvas.width = width;
      liveCanvas.height = height;
      const ctx = liveCanvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }

    // Directly instruct live window to enter black mode
    ipcRenderer.send('set-live-mode', 'black');
    return;
  }

  blackMode = !blackMode;

  // Update button state
  if (window.blackButton) {
    if (blackMode) {
      window.blackButton.classList.add('active');
    } else {
      window.blackButton.classList.remove('active');
    }
  }

  if (blackMode) {
    // Update preview to solid black
    const liveCanvas = document.getElementById('live-canvas');
    if (liveCanvas) {
      const width = window.currentContent ? window.currentContent.width : liveCanvas.width;
      const height = window.currentContent ? window.currentContent.height : liveCanvas.height;
      liveCanvas.width = width;
      liveCanvas.height = height;
      const ctx = liveCanvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }
    // Tell live window to enter black mode
    ipcRenderer.send('set-live-mode', 'black');
  } else {
    // Exit black: restore preview and tell live window to return to normal
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        renderToCanvas(liveCanvas, window.currentContent, window.currentContent.width, window.currentContent.height);
      }
    }
    ipcRenderer.send('set-live-mode', 'normal');
  }
}

// ========== SCHEDULE MANAGEMENT ==========

function initSchedule() {
  const scheduleList = document.getElementById('schedule-list');
  const verseList = document.getElementById('verse-list');
  
  // Load schedule from settings
  loadScheduleFromSettings();

  // Clear All button
  const clearBtn = document.getElementById('schedule-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (scheduleItems.length === 0) return;
      if (!confirm('Remove all items from the schedule?')) return;
      scheduleItems = [];
      renderSchedule();
      saveScheduleToSettings();
    });
  }

  // File menu: Save / Load schedule
  ipcRenderer.on('schedule:save', async () => {
    const filePath = await ipcRenderer.invoke('schedule:save-to-file');
    if (!filePath) return;
    try {
      fs.writeFileSync(filePath, JSON.stringify(scheduleItems, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save schedule file:', err);
    }
  });

  ipcRenderer.on('schedule:load', async () => {
    const loaded = await ipcRenderer.invoke('schedule:load-from-file');
    if (!Array.isArray(loaded)) return;
    scheduleItems = loaded;
    renderSchedule();
    saveScheduleToSettings();
  });

  // Opened via file association (double-click .litsch file or passed at launch)
  ipcRenderer.on('schedule:open-file', (_e, data) => {
    if (!Array.isArray(data)) return;
    if (!confirm('Load this schedule file? Your current schedule will be cleared.')) return;
    scheduleItems = data;
    renderSchedule();
    saveScheduleToSettings();
  });

  // Opened via file association (double-click .litsong file or passed at launch)
  ipcRenderer.on('songs:open-file', async (_e, data) => {
    if (!Array.isArray(data)) return;
    const songs = data.filter(s => s.title && s.lyrics && Array.isArray(s.lyrics));
    if (songs.length === 0) return;
    if (!confirm(`Import ${songs.length} song${songs.length !== 1 ? 's' : ''} from this file? Duplicates will be skipped.`)) return;
    let addedCount = 0;
    songs.forEach(song => {
      const exists = allSongs.some(s => s.title === song.title && s.author === song.author);
      if (!exists) { allSongs.push(song); addedCount++; }
    });
    if (addedCount > 0) {
      try {
        const userData  = await ipcRenderer.invoke('get-user-data-path');
        const songsPath = path.join(userData, 'songs.json');
        fs.writeFileSync(songsPath, JSON.stringify(allSongs, null, 2), 'utf8');
        renderSongList(allSongs);
        populateHymnalFilter();
        alert(`Imported ${addedCount} song${addedCount !== 1 ? 's' : ''}`);
      } catch (err) {
        console.error('Failed to save imported songs:', err);
        alert('Failed to save imported songs');
      }
    } else {
      alert('No new songs to import (all duplicates)');
    }
  });
  
  // Make verse items draggable
  verseList.addEventListener('dragstart', handleVerseDragStart);
  
  // Setup drop zone
  scheduleList.addEventListener('dragover', handleScheduleDragOver);
  scheduleList.addEventListener('dragleave', handleScheduleDragLeave);
  scheduleList.addEventListener('drop', handleScheduleDrop);
}

function handleVerseDragStart(e) {
  if (!e.target.classList.contains('verse-item')) return;

  const draggedIndex = parseInt(e.target.getAttribute('data-index'));
  // If the dragged item is part of the current multi-selection, drag all selected indices.
  // Otherwise drag only the item that was actually grabbed.
  const indices = selectedIndices.includes(draggedIndex) ? selectedIndices : [draggedIndex];

  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', JSON.stringify(indices));
}

function handleScheduleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.getElementById('schedule-list').classList.add('drag-over');
}

function handleScheduleDragLeave(e) {
  if (e.target.id === 'schedule-list') {
    document.getElementById('schedule-list').classList.remove('drag-over');
  }
}

function handleScheduleDrop(e) {
  e.preventDefault();
  document.getElementById('schedule-list').classList.remove('drag-over');
  
  const data = e.dataTransfer.getData('text/plain');
  if (!data) return;
  
  try {
    const dragData = JSON.parse(data);
    
    if (dragData.type === 'song') {
      // Song drop
      addSongToSchedule(dragData.songIndex);
    } else if (dragData.type === 'media') {
      // Media drop
      addMediaToSchedule(dragData.mediaIndex);
    } else if (Array.isArray(dragData)) {
      // Verse indices (legacy format)
      addScheduleItem(dragData);
    }
  } catch (err) {
    console.error('Failed to parse dropped data:', err);
  }
}

function addMediaToSchedule(mediaIndex) {
  const media = allMedia[mediaIndex];
  if (!media) return;
  
  const newItem = {
    type: 'media',
    mediaIndex: mediaIndex,
    expanded: false
  };
  
  scheduleItems.push(newItem);
  renderSchedule();
  saveScheduleToSettings();
}

function addSongToSchedule(songIndex) {
  const song = allSongs[songIndex];
  if (!song) return;
  
  const newItem = {
    type: 'song',
    songIndex: songIndex,
    expanded: false,
    selectedVerses: []
  };
  
  scheduleItems.push(newItem);
  renderSchedule();
  saveScheduleToSettings();
}

function addScheduleItem(indices) {
  const newItem = {
    type: 'verses',
    indices: [...indices],
    expanded: false,
    selectedVerses: [] // For shift-click selection within expanded group
  };
  
  scheduleItems.push(newItem);
  renderSchedule();
  saveScheduleToSettings();
}

function renderSchedule() {
  const scheduleList = document.getElementById('schedule-list');
  scheduleList.innerHTML = '';
  
  if (scheduleItems.length === 0) {
    scheduleList.innerHTML = '<div class="schedule-empty-hint">Drag verses, songs, or media here.<br><span class="schedule-empty-sub">You can also open a .litsch file.</span></div>';
    return;
  }
  
  scheduleItems.forEach((item, itemIndex) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'schedule-item';
    itemDiv.setAttribute('draggable', 'true');
    itemDiv.setAttribute('data-schedule-index', itemIndex);
    
    // Drag handlers for reordering
    itemDiv.addEventListener('dragstart', handleScheduleItemDragStart);
    itemDiv.addEventListener('dragover', handleScheduleItemDragOver);
    itemDiv.addEventListener('drop', handleScheduleItemDrop);
    itemDiv.addEventListener('dragend', handleScheduleItemDragEnd);
    
    // Create header
    const header = document.createElement('div');
    header.className = 'schedule-item-header';
    
    const itemType = item.type || 'verses'; // Default to verses for backwards compatibility
    const itemLength = itemType === 'song' ? getSongVerseCount(item.songIndex) : 
                       itemType === 'media' ? 1 : 
                       item.indices.length;
    
    // Arrow icon (only show if more than 1 verse)
    if (itemLength > 1) {
      const arrow = document.createElement('div');
      arrow.className = 'expand-arrow' + (item.expanded ? ' expanded' : '');
      arrow.innerHTML = '▶';
      arrow.style.cssText = 'padding: 4px; margin: -4px; cursor: pointer;'; // Increase hitbox
      arrow.onclick = (e) => {
        e.stopPropagation();
        toggleScheduleItem(itemIndex);
      };
      header.appendChild(arrow);
    } else {
      // Spacer for single verses
      const spacer = document.createElement('div');
      spacer.style.width = '16px';
      spacer.style.marginRight = '6px';
      header.appendChild(spacer);
    }
    
    // Icon on header (song / verse / media)
    const iconDiv = document.createElement('div');
    iconDiv.className = 'schedule-item-icon';
    if (itemType === 'song') {
      iconDiv.innerHTML = '<i class="fa-solid fa-music" aria-hidden="true"></i>';
    } else if (itemType === 'media') {
      iconDiv.innerHTML = '<i class="fa-solid fa-image" aria-hidden="true"></i>';
    } else {
      iconDiv.innerHTML = '<i class="fa-solid fa-book" aria-hidden="true"></i>';
    }
    header.appendChild(iconDiv);

    // Text
    const text = document.createElement('div');
    text.className = 'schedule-item-text';
    
    let displayText = '';
    if (itemType === 'song') {
      const song = allSongs[item.songIndex];
      displayText = song ? song.title : 'Unknown Song';
      text.textContent = displayText;
      text.title = displayText;
    } else if (itemType === 'media') {
      const media = allMedia[item.mediaIndex];
      const mediaName = media ? media.name : 'Unknown Media';
      displayText = mediaName;
      text.textContent = displayText;
      text.title = displayText;
    } else {
      displayText = getScheduleItemLabel(item.indices);
      text.textContent = displayText;
      text.title = displayText;
    }
    
    header.appendChild(text);
    
    // Make header focusable and add selection state
    header.tabIndex = 0;
    if (selectedScheduleItems.includes(itemIndex)) {
      header.classList.add('selected');
    }
    
    // Delete button
    const deleteBtn = document.createElement('div');
    deleteBtn.innerHTML = '×';
    deleteBtn.style.cssText = 'width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 20px; color: #999; margin-left: 4px;';
    deleteBtn.onmouseover = () => deleteBtn.style.color = '#fff';
    deleteBtn.onmouseout = () => deleteBtn.style.color = '#999';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteScheduleItem(itemIndex);
    };
    header.appendChild(deleteBtn);
    
    // Click handlers for header
    header.onclick = (e) => {
      if (e.target.closest('.delete-btn')) return; // Ignore clicks on delete button
      focusedScheduleItem = { type: 'header', itemIndex: itemIndex };
      handleScheduleItemClick(itemIndex, e);
    };
    header.ondblclick = (e) => {
      // Don't trigger double-click if user clicked delete button
      if (e.target === deleteBtn) return;
      handleScheduleItemDoubleClick(itemIndex);
    };
    header.addEventListener('keydown', (e) => {
      console.log('Schedule header key pressed:', e.key, 'itemIndex:', itemIndex);
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        console.log('Enter pressed on schedule header, calling handleScheduleItemDoubleClick');
        handleScheduleItemDoubleClick(itemIndex);
      }
    });
    
    itemDiv.appendChild(header);
    
    // Create expanded verse list (if multi-verse and expanded)
    if (itemLength > 1) {
      const versesDiv = document.createElement('div');
      versesDiv.className = 'schedule-item-verses' + (item.expanded ? ' expanded' : '');
      
      if (itemType === 'song') {
        // Render song verses
        const song = allSongs[item.songIndex];
        if (song) {
          let verseIndex = 0;
          song.lyrics.forEach(section => {
            const verses = section.text.split(/\\n\\n+/);
            verses.forEach((verse, i) => {
              const verseItem = document.createElement('div');
              verseItem.className = 'schedule-verse-item';
              verseItem.tabIndex = 0;
              // icon + text elements for song verse
              const verseIcon = document.createElement('span');
              verseIcon.className = 'schedule-verse-icon';
              verseIcon.innerHTML = '<i class="fa-solid fa-music" aria-hidden="true"></i>';
              const verseText = document.createElement('span');
              verseText.className = 'schedule-verse-text';
              
              // First line of verse as label
              const firstLine = verse.split('\\n')[0];
              const label = firstLine.length > 40 ? firstLine.substring(0, 40) + '...' : firstLine;
              verseText.textContent = `${section.section} (${i + 1}): ${label}`;
              verseItem.appendChild(verseIcon);
              verseItem.appendChild(verseText);
              
              if (item.selectedVerses && item.selectedVerses.includes(verseIndex)) {
                verseItem.classList.add('selected');
              }
              
              const currentVerseIndex = verseIndex;
              verseItem.onclick = (e) => {
                focusedScheduleItem = { type: 'song-verse', itemIndex: itemIndex, verseIndex: currentVerseIndex };
                handleScheduleSongVerseClick(itemIndex, currentVerseIndex, e);
              };
              verseItem.ondblclick = () => handleScheduleSongVerseDoubleClick(itemIndex, currentVerseIndex);
              verseItem.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  handleScheduleSongVerseDoubleClick(itemIndex, currentVerseIndex);
                }
              });
              
              versesDiv.appendChild(verseItem);
              verseIndex++;
            });
          });
        }
      } else {
        // Render bible verses
        item.indices.forEach((verseIndex, i) => {
        const verseItem = document.createElement('div');
        verseItem.className = 'schedule-verse-item';
        verseItem.tabIndex = 0; // Make focusable for keyboard navigation
        verseItem.setAttribute('draggable', 'false'); // Prevent nested items from being draggable
        if (item.selectedVerses.includes(i)) {
          verseItem.classList.add('selected');
        }
        
        const verse = allVerses[verseIndex];
        if (verse) {
          const match = verse.key.match(/^(.+?)\s+(\d+):(\d+)$/);
          const verseLabel = match ? `${match[1]} ${match[2]}:${match[3]}` : verse.key;
          const verseIcon = document.createElement('span');
          verseIcon.className = 'schedule-verse-icon';
          verseIcon.innerHTML = '<i class="fa-solid fa-book" aria-hidden="true"></i>';
          const verseText = document.createElement('span');
          verseText.className = 'schedule-verse-text';
          verseText.textContent = verseLabel;
          verseItem.appendChild(verseIcon);
          verseItem.appendChild(verseText);
        } else {
          const verseIcon = document.createElement('span');
          verseIcon.className = 'schedule-verse-icon';
          verseIcon.innerHTML = '<i class="fa-solid fa-book" aria-hidden="true"></i>';
          const verseText = document.createElement('span');
          verseText.className = 'schedule-verse-text';
          verseText.textContent = 'Unknown';
          verseItem.appendChild(verseIcon);
          verseItem.appendChild(verseText);
        }
        
        verseItem.onclick = (e) => {
          e.stopPropagation(); // Prevent triggering parent drag
          focusedScheduleItem = { type: 'verse', itemIndex: itemIndex, verseIndex: i };
          handleScheduleVerseClick(itemIndex, i, e);
        };
        verseItem.ondblclick = () => handleScheduleVerseDoubleClick(itemIndex, i);
        verseItem.addEventListener('keydown', (e) => {
          console.log('Schedule verse key pressed:', e.key, 'itemIndex:', itemIndex, 'verseIndex:', i);
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            console.log('Enter pressed on schedule verse, calling handleScheduleVerseDoubleClick');
            handleScheduleVerseDoubleClick(itemIndex, i);
          }
        });
        
        versesDiv.appendChild(verseItem);
        });
      }
      
      itemDiv.appendChild(versesDiv);
    }
    
    scheduleList.appendChild(itemDiv);
  });
  
  // Re-focus the previously focused item after render
  if (focusedScheduleItem) {
    setTimeout(() => {
      if (focusedScheduleItem.type === 'header') {
        const headers = document.querySelectorAll('.schedule-item-header');
        if (headers[focusedScheduleItem.itemIndex]) {
          headers[focusedScheduleItem.itemIndex].focus();
        }
      } else if (focusedScheduleItem.type === 'verse') {
        const item = scheduleItems[focusedScheduleItem.itemIndex];
        if (item && item.expanded) {
          const allVerseItems = document.querySelectorAll('.schedule-verse-item');
          // Find the correct verse item by counting
          let count = 0;
          for (let i = 0; i < focusedScheduleItem.itemIndex; i++) {
            if (scheduleItems[i].indices.length > 1 && scheduleItems[i].expanded) {
              count += scheduleItems[i].indices.length;
            }
          }
          count += focusedScheduleItem.verseIndex;
          if (allVerseItems[count]) {
            allVerseItems[count].focus();
          }
        }
      }
    }, 10);
  }
}

function deleteScheduleItem(itemIndex) {
  scheduleItems.splice(itemIndex, 1);
  renderSchedule();
  saveScheduleToSettings();
}

function getSongVerseCount(songIndex) {
  const song = allSongs[songIndex];
  if (!song) return 0;
  
  let count = 0;
  song.lyrics.forEach(section => {
    count += section.text.split(/\n\n+/).length;
  });
  return count;
}

function getScheduleItemLabel(indices) {
  if (!indices) return 'Unknown';
  if (!allVerses || allVerses.length === 0) {
    return 'Loading...';
  }
  
  if (indices.length === 0) return 'Empty';
  
  // Helper to parse "Genesis 2:25" -> { book: "Genesis", chapter: 2, verse: 25 }
  const parseKey = (key) => {
    const match = key.match(/^(.+?)\s+(\d+):(\d+)$/);
    if (!match) return null;
    return { book: match[1], chapter: parseInt(match[2]), verse: parseInt(match[3]) };
  };
  
  if (indices.length === 1) {
    const verse = allVerses[indices[0]];
    if (!verse) return 'Unknown';
    const parsed = parseKey(verse.key);
    return parsed ? `${parsed.book} ${parsed.chapter}:${parsed.verse}` : verse.key;
  }
  
  const first = allVerses[indices[0]];
  const last = allVerses[indices[indices.length - 1]];
  
  if (!first || !last) return 'Unknown';
  
  const firstParsed = parseKey(first.key);
  const lastParsed = parseKey(last.key);
  
  if (!firstParsed || !lastParsed) return `${first.key} - ${last.key}`;
  
  if (firstParsed.book === lastParsed.book && firstParsed.chapter === lastParsed.chapter) {
    return `${firstParsed.book} ${firstParsed.chapter}:${firstParsed.verse}-${lastParsed.verse}`;
  } else if (firstParsed.book === lastParsed.book) {
    return `${firstParsed.book} ${firstParsed.chapter}:${firstParsed.verse} - ${lastParsed.chapter}:${lastParsed.verse}`;
  } else {
    return `${firstParsed.book} ${firstParsed.chapter}:${firstParsed.verse} - ${lastParsed.book} ${lastParsed.chapter}:${lastParsed.verse}`;
  }
}

function toggleScheduleItem(itemIndex) {
  scheduleItems[itemIndex].expanded = !scheduleItems[itemIndex].expanded;
  scheduleItems[itemIndex].selectedVerses = []; // Clear selection when toggling
  renderSchedule();
}

function handleScheduleItemClick(itemIndex, event) {
  const item = scheduleItems[itemIndex];
  const itemType = item.type || 'verses';
  
  // Handle multi-selection
  if (event.shiftKey && anchorScheduleIndex !== null) {
    // Shift-click: select range
    const start = Math.min(anchorScheduleIndex, itemIndex);
    const end = Math.max(anchorScheduleIndex, itemIndex);
    selectedScheduleItems = [];
    for (let i = start; i <= end; i++) {
      selectedScheduleItems.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Ctrl-click: toggle selection
    const idx = selectedScheduleItems.indexOf(itemIndex);
    if (idx >= 0) {
      selectedScheduleItems.splice(idx, 1);
      if (anchorScheduleIndex === itemIndex) {
        anchorScheduleIndex = selectedScheduleItems.length > 0 ? selectedScheduleItems[0] : null;
      }
    } else {
      selectedScheduleItems.push(itemIndex);
      anchorScheduleIndex = itemIndex;
    }
  } else {
    // Normal click: select only this item
    selectedScheduleItems = [itemIndex];
    anchorScheduleIndex = itemIndex;
    
    // If it's a song, switch to songs tab and select it
    if (itemType === 'song') {
      switchTab('songs');
      selectedSongIndices = [item.songIndex];
      const songsForList = filteredSongs.length > 0 ? filteredSongs : allSongs;
      renderSongList(songsForList);
      displaySelectedSong();
      // Scroll the song list to show the selected song
      const songListContainer = document.getElementById('song-list');
      if (songListContainer) {
        const sortedSongs = songsForList.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
        const song = allSongs[item.songIndex];
        const posInList = song ? sortedSongs.findIndex(s => s.title === song.title && s.author === song.author) : -1;
        if (posInList >= 0) {
          songListContainer.scrollTop = Math.max(0, posInList * 32 - 80);
          renderSongList(songsForList);
        }
      }
      // Preview first verse (use first selected verse if expanded, otherwise verse 0)
      const firstVerseIndex = (item.expanded && item.selectedVerses.length > 0) ? item.selectedVerses[0] : 0;
      const verseData = getScheduleSongVerseText(item.songIndex, firstVerseIndex);
      if (verseData) {
        updatePreviewFromSongVerse(firstVerseIndex, verseData);
      }
    } else if (itemType === 'media') {
      // If it's media, display on preview canvas
      const media = allMedia[item.mediaIndex];
      console.log('Schedule media item clicked:', media);
      if (media) {
        displayMediaOnPreview(media);
      }
    } else if (itemType === 'verses') {
      // Switch to Bible tab and focus the verse(s) in the list
      switchTab('verses');
      selectedIndices = item.indices.slice();
      // Scroll the verse list so the first verse is visible
      const verseListContainer = document.getElementById('verse-list');
      if (verseListContainer && item.indices.length > 0) {
        verseListContainer.scrollTop = Math.max(0, item.indices[0] * ITEM_HEIGHT - 80);
        // Re-render the virtual list at the new scroll position
        renderWindow(allVerses, verseListContainer.scrollTop, selectedIndices, handleVerseClick);
      }
      updateVerseDisplay();
    }
  }
  
  renderSchedule();
  
  // Preview all verses from selected schedule items (only for bible verses)
  if (itemType === 'verses') {
    const allIndices = selectedScheduleItems.flatMap(i => scheduleItems[i].indices);
    if (allIndices.length > 0) {
      updatePreview(allIndices);
    }
  }
}

function handleScheduleItemDoubleClick(itemIndex) {
  const item = scheduleItems[itemIndex];
  const itemType = item.type || 'verses';
  
  // Do not change clear/black mode here - respect user's current display mode
  
  if (itemType === 'song') {
    // For songs, switch to songs tab and select the song
    switchTab('songs');
    selectedSongIndices = [item.songIndex];
    renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
    displaySelectedSong();
    
    // Go live with first verse (use first selected verse if expanded, otherwise verse 0)
    const firstVerseIndex = (item.expanded && item.selectedVerses.length > 0) ? item.selectedVerses[0] : 0;
    const verseData = getScheduleSongVerseText(item.songIndex, firstVerseIndex);
    if (verseData) {
      updateLiveFromSongVerse(firstVerseIndex, verseData);
    }
  } else if (itemType === 'media') {
    // For media, display the media file
    const media = allMedia[item.mediaIndex];
    if (media) {
      displayMediaOnLive(media);
    }
  } else {
    // For bible verses, go live with all selected schedule items (or just this one if not selected)
    let indicesToShow;
    if (selectedScheduleItems.includes(itemIndex)) {
      // Use all selected items
      indicesToShow = selectedScheduleItems.flatMap(i => scheduleItems[i].indices);
    } else {
      // Just this item
      indicesToShow = item.indices;
    }
    
    handleVerseDoubleClick(indicesToShow);
  }
}

function handleScheduleVerseClick(itemIndex, verseIndexInGroup, event) {
  const item = scheduleItems[itemIndex];
  
  if (event.shiftKey && item.selectedVerses.length > 0) {
    // Shift-click: select range
    const lastSelected = item.selectedVerses[item.selectedVerses.length - 1];
    const start = Math.min(lastSelected, verseIndexInGroup);
    const end = Math.max(lastSelected, verseIndexInGroup);
    
    item.selectedVerses = [];
    for (let i = start; i <= end; i++) {
      item.selectedVerses.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Ctrl-click: toggle selection
    const idx = item.selectedVerses.indexOf(verseIndexInGroup);
    if (idx >= 0) {
      item.selectedVerses.splice(idx, 1);
    } else {
      item.selectedVerses.push(verseIndexInGroup);
    }
  } else {
    // Normal click: select only this verse
    item.selectedVerses = [verseIndexInGroup];
  }
  
  renderSchedule();
  
  // Switch to Bible tab and sync selection with the tab
  switchTab('verses');
  const selectedVerseIndices = item.selectedVerses.map(i => item.indices[i]);
  selectedIndices = selectedVerseIndices;
  
  // Display the selected verses in the Bible tab
  if (selectedVerseIndices.length > 0) {
    updateVerseDisplay();
    updatePreview(selectedVerseIndices);
  }
}

function handleScheduleVerseDoubleClick(itemIndex, verseIndexInGroup) {
  const item = scheduleItems[itemIndex];
  
  // Go live with selected verses (or just this one if none selected)
  let indicesToShow;
  if (item.selectedVerses.length > 0) {
    indicesToShow = item.selectedVerses.map(i => item.indices[i]);
  } else {
    indicesToShow = [item.indices[verseIndexInGroup]];
  }
  
  handleVerseDoubleClick(indicesToShow);
}

function handleScheduleSongVerseClick(itemIndex, verseIndex, event) {
  const item = scheduleItems[itemIndex];
  
  // Handle multi-selection
  if (event.shiftKey && item.selectedVerses.length > 0) {
    const lastSelected = item.selectedVerses[item.selectedVerses.length - 1];
    const start = Math.min(lastSelected, verseIndex);
    const end = Math.max(lastSelected, verseIndex);
    
    item.selectedVerses = [];
    for (let i = start; i <= end; i++) {
      item.selectedVerses.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    const idx = item.selectedVerses.indexOf(verseIndex);
    if (idx >= 0) {
      item.selectedVerses.splice(idx, 1);
    } else {
      item.selectedVerses.push(verseIndex);
    }
  } else {
    item.selectedVerses = [verseIndex];
  }
  
  // Switch to songs tab and sync selection with the tab
  switchTab('songs');
  selectedSongIndices = [item.songIndex];
  selectedSongVerseIndex = verseIndex; // Use the first selected verse for display
  renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
  displaySelectedSong();
  
  renderSchedule();
  
  // Preview the verse
  const song = allSongs[item.songIndex];
  if (song) {
    const verseData = getScheduleSongVerseText(item.songIndex, verseIndex);
    if (verseData) {
      updatePreviewFromSongVerse(verseIndex, verseData);
    }
  }
}

function handleScheduleSongVerseDoubleClick(itemIndex, verseIndex) {
  const item = scheduleItems[itemIndex];
  const song = allSongs[item.songIndex];
  if (!song) return;
  
  const verseData = getScheduleSongVerseText(item.songIndex, verseIndex);
  if (verseData) {
    updateLiveFromSongVerse(verseIndex, verseData);
  }
}

function getScheduleSongVerseText(songIndex, verseIndex) {
  const song = allSongs[songIndex];
  if (!song) return null;
  
  let currentIndex = 0;
  for (const section of song.lyrics) {
    const verses = section.text.split(/\\n\\n+/);
    for (const verse of verses) {
      if (currentIndex === verseIndex) {
        return {
          title: song.title,
          section: section.section,
          text: verse
        };
      }
      currentIndex++;
    }
  }
  return null;
}

function navigateScheduleSongVerse(direction) {
  if (!focusedScheduleItem || focusedScheduleItem.type !== 'song-verse') return;
  
  const { itemIndex, verseIndex } = focusedScheduleItem;
  const item = scheduleItems[itemIndex];
  if (!item || item.type !== 'song') return;
  
  const song = allSongs[item.songIndex];
  if (!song) return;
  
  // Count total verses
  let totalVerses = 0;
  song.lyrics.forEach(section => {
    totalVerses += section.text.split(/\\n\\n+/).length;
  });
  
  const newVerseIndex = verseIndex + direction;
  if (newVerseIndex < 0 || newVerseIndex >= totalVerses) return;
  
  // Update focused item
  focusedScheduleItem.verseIndex = newVerseIndex;
  
  // Simulate click on new verse
  handleScheduleSongVerseClick(itemIndex, newVerseIndex, { ctrlKey: false, shiftKey: false });
  
  // Focus the new verse element
  setTimeout(() => {
    const scheduleList = document.getElementById('schedule-list');
    const itemElements = scheduleList.children;
    if (itemElements[itemIndex]) {
      const versesDiv = itemElements[itemIndex].querySelector('.schedule-verses');
      if (versesDiv) {
        const verseElements = versesDiv.querySelectorAll('.schedule-verse-item');
        if (verseElements[newVerseIndex]) {
          verseElements[newVerseIndex].focus();
        }
      }
    }
  }, 50);
}

async function saveScheduleToSettings() {
  try {
    await ipcRenderer.invoke('update-settings', { schedule: scheduleItems });
    pushScheduleUpdate();
  } catch (err) {
    console.error('Failed to save schedule to settings:', err);
  }
}

async function loadScheduleFromSettings() {
  try {
    const settings = await ipcRenderer.invoke('load-settings') || {};
    if (settings.schedule && Array.isArray(settings.schedule)) {
      scheduleItems = settings.schedule;
      // Only render if allVerses is populated, otherwise renderSchedule will be called after verses load
      if (allVerses && allVerses.length > 0) {
        renderSchedule();
      }
    }
  } catch (err) {
    console.error('Failed to load schedule from settings:', err);
  }
}

async function saveSongViewMode() {
  try {
    await ipcRenderer.invoke('update-settings', { songVerseViewMode });
  } catch (err) {
    console.error('Failed to save song view mode:', err);
  }
}

async function loadSongViewMode() {
  try {
    const settings = await ipcRenderer.invoke('load-settings') || {};
    if (settings.songVerseViewMode) {
      songVerseViewMode = settings.songVerseViewMode;
      const viewToggle = document.getElementById('song-view-toggle');
      if (viewToggle) {
        viewToggle.textContent = songVerseViewMode === 'full' ? 'Verse Blocks' : 'Full Song';
      }
    }
  } catch (err) {
    console.error('Failed to load song view mode:', err);
  }
}

let draggedScheduleIndex = null;

function handleScheduleItemDragStart(e) {
  draggedScheduleIndex = parseInt(e.currentTarget.getAttribute('data-schedule-index'));
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'schedule-reorder');
  e.currentTarget.style.opacity = '0.5';
}

function handleScheduleItemDragOver(e) {
  if (draggedScheduleIndex === null) return;
  e.preventDefault();
  e.stopPropagation(); // Prevent outer list handler from overwriting dropEffect to 'copy'
  e.dataTransfer.dropEffect = 'move';
  
  const targetIndex = parseInt(e.currentTarget.getAttribute('data-schedule-index'));
  if (targetIndex !== draggedScheduleIndex) {
    e.currentTarget.style.borderTop = '2px solid #0078d4';
  }
}

function handleScheduleItemDrop(e) {
  e.preventDefault();
  e.stopPropagation();

  // External drag (song / verse / media being added) — delegate to the list drop handler
  if (draggedScheduleIndex === null) {
    const data = e.dataTransfer.getData('text/plain');
    if (!data) return;
    try {
      const dragData = JSON.parse(data);
      if (dragData.type === 'song') {
        addSongToSchedule(dragData.songIndex);
      } else if (dragData.type === 'media') {
        addMediaToSchedule(dragData.mediaIndex);
      } else if (Array.isArray(dragData)) {
        addScheduleItem(dragData);
      }
    } catch (err) {
      console.error('Failed to parse dropped data on schedule item:', err);
    }
    return;
  }

  const targetIndex = parseInt(e.currentTarget.getAttribute('data-schedule-index'));
  
  if (targetIndex !== draggedScheduleIndex) {
    // Reorder the items
    const item = scheduleItems.splice(draggedScheduleIndex, 1)[0];
    scheduleItems.splice(targetIndex, 0, item);
    saveScheduleToSettings();
    renderSchedule();
  }
  
  e.currentTarget.style.borderTop = '';
}

function handleScheduleItemDragEnd(e) {
  e.currentTarget.style.opacity = '';
  draggedScheduleIndex = null;
  
  // Clear all border highlights
  document.querySelectorAll('.schedule-item').forEach(item => {
    item.style.borderTop = '';
  });
}

// ========== RESIZABLE PANELS ==========

function initResizers() {
  // Schedule sidebar resizer
  const scheduleResizer = document.getElementById('schedule-resizer');
  const scheduleSidebar = document.getElementById('schedule-sidebar');
  const slideContainer = document.getElementById('slide-container');
  
  let isResizing = false;
  
  scheduleResizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  // Preview divider resizer
  const previewResizer = document.getElementById('preview-resizer');
  const slidePreview = document.getElementById('slide-preview');
  const livePanelWrapper = document.getElementById('live-panel-wrapper');
  
  let isResizingPreview = false;
  
  previewResizer.addEventListener('mousedown', (e) => {
    isResizingPreview = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  // Verse panel resizer
  const verseResizer = document.getElementById('verse-resizer');
  const versePanel = document.getElementById('verse-panel');
  const topSection = document.getElementById('top-section');
  
  let isResizingVerse = false;
  
  verseResizer.addEventListener('mousedown', (e) => {
    isResizingVerse = true;
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });
  
  // Global mouse move and up handlers
  document.addEventListener('mousemove', (e) => {
    if (isResizing) {
      const newWidth = e.clientX;
      if (newWidth > 100 && newWidth < window.innerWidth - 400) {
        scheduleSidebar.style.width = newWidth + 'px';
      }
    } else if (isResizingPreview) {
      const containerRect = slideContainer.getBoundingClientRect();
      const offsetX = e.clientX - containerRect.left;
      const percentage = (offsetX / containerRect.width) * 100;
      
      if (percentage > 10 && percentage < 90) {
        slidePreview.style.flex = `${percentage} 1 0%`;
        livePanelWrapper.style.flex = `${100 - percentage} 1 0%`;
      }
    } else if (isResizingVerse) {
      const newHeight = window.innerHeight - e.clientY;
      const resizerHeight = 16; // height of the resizer
      const newTopHeight = e.clientY - resizerHeight / 2;
      
      if (newHeight > 30 && newTopHeight > 50) {
        topSection.style.flex = `0 0 ${newTopHeight}px`;
        versePanel.style.flex = `0 0 ${newHeight}px`;
      }
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isResizing || isResizingPreview || isResizingVerse) {
      document.body.style.cursor = '';
      isResizing = false;
      isResizingPreview = false;
      isResizingVerse = false;
      // Save divider positions
      saveDividerPositions();
    }
  });
}

async function saveDividerPositions() {
  const scheduleSidebar = document.getElementById('schedule-sidebar');
  const slidePreview = document.getElementById('slide-preview');
  const slideContainer = document.getElementById('slide-container');
  const versePanel = document.getElementById('verse-panel');
  
  const settings = await ipcRenderer.invoke('load-settings') || {};

  // Compute normalized numeric values
  const scheduleWidthPx = Math.round(scheduleSidebar.getBoundingClientRect().width || parseInt(scheduleSidebar.style.width) || 250);
  const containerRect = slideContainer.getBoundingClientRect();
  const previewWidth = slidePreview.getBoundingClientRect().width || 0;
  let previewPercent = containerRect.width > 0 ? Math.round((previewWidth / containerRect.width) * 100) : 50;
  const verseHeightPx = Math.round(versePanel.getBoundingClientRect().height || parseInt(versePanel.style.flex) || 200);

  // Clamp to sensible ranges
  const clampedSchedule = Math.max(100, Math.min(scheduleWidthPx, window.innerWidth - 400));
  previewPercent = Math.max(10, Math.min(90, previewPercent));
  const clampedVerse = Math.max(50, Math.min(verseHeightPx, Math.max(100, window.innerHeight - 100)));

  settings.dividerPositions = {
    // new numeric representation (preferred)
    scheduleWidthPx: clampedSchedule,
    previewPercent: previewPercent,
    verseHeightPx: clampedVerse,
    // keep legacy strings for backward-compatibility
    scheduleWidth: clampedSchedule + 'px',
    previewFlex: `0 0 ${previewPercent}%`,
    verseHeight: `0 0 ${clampedVerse}px`
  };

  // Use update-settings to avoid races
  await ipcRenderer.invoke('update-settings', { dividerPositions: settings.dividerPositions });
}

async function restoreDividerPositions() {
  const settings = await ipcRenderer.invoke('load-settings') || {};
  // Ensure defaults exist on fresh installs and persist them so restore sees explicit values
  if (!settings.dividerPositions) {
    settings.dividerPositions = {
      scheduleWidthPx: 250,
      previewPercent: 50,
      verseHeightPx: 350,
      scheduleWidth: '250px',
      previewFlex: '0 0 50%',
      verseHeight: '0 0 350px'
    };
    try { await ipcRenderer.invoke('update-settings', { dividerPositions: settings.dividerPositions }); } catch (e) { console.warn('Failed to persist default divider positions:', e); }
  }
  
  const scheduleSidebar = document.getElementById('schedule-sidebar');
  const slidePreview = document.getElementById('slide-preview');
  const livePanelWrapper = document.getElementById('live-panel-wrapper');
  const versePanel = document.getElementById('verse-panel');
  const topSection = document.getElementById('top-section');

  // Read numeric values first (new format), fall back to legacy strings
  let scheduleWidthPx = settings.dividerPositions.scheduleWidthPx;
  if (!scheduleWidthPx && settings.dividerPositions.scheduleWidth) {
    scheduleWidthPx = parseInt(settings.dividerPositions.scheduleWidth, 10);
  }
  if (!scheduleWidthPx) scheduleWidthPx = 250;

  let previewPercent = settings.dividerPositions.previewPercent;
  if (!previewPercent && settings.dividerPositions.previewFlex) {
    const match = settings.dividerPositions.previewFlex.match(/(\d+\.?\d*)%/);
    if (match) previewPercent = parseFloat(match[1]);
  }
  if (!previewPercent) previewPercent = 50;

  let verseHeightPx = settings.dividerPositions.verseHeightPx;
  if (!verseHeightPx && settings.dividerPositions.verseHeight) {
    const m = settings.dividerPositions.verseHeight.match(/(\d+)px/);
    if (m) verseHeightPx = parseInt(m[1], 10);
  }
  if (!verseHeightPx) verseHeightPx = 350; // default moved up to give more top area on clean installs

  // Validate and clamp to safe ranges based on current window size
  scheduleWidthPx = Math.max(100, Math.min(scheduleWidthPx, Math.max(150, window.innerWidth - 400)));
  previewPercent = Math.max(10, Math.min(previewPercent, 90));
  verseHeightPx = Math.max(50, Math.min(verseHeightPx, Math.max(100, window.innerHeight - 100)));

  // Apply computed layout
  scheduleSidebar.style.width = scheduleWidthPx + 'px';
  slidePreview.style.flex = `${previewPercent} 1 0%`;
  livePanelWrapper.style.flex = `${100 - previewPercent} 1 0%`;

  versePanel.style.flex = `0 0 ${verseHeightPx}px`;
  const topHeight = Math.max(50, window.innerHeight - verseHeightPx - 16);
  topSection.style.flex = `0 0 ${topHeight}px`;

  // If any incoming values were out of bounds, warn and overwrite persisted values with clamped ones
  const { scheduleWidth, previewFlex, verseHeight } = settings.dividerPositions;
  if (parseInt(scheduleWidth, 10) !== scheduleWidthPx || (previewFlex && !previewFlex.includes(`${previewPercent}%`)) || (verseHeight && !verseHeight.includes(`${verseHeightPx}px`))) {
    console.warn('[restoreDividerPositions] Clamped persisted divider positions to safe ranges. Overwriting saved values.');
    await saveDividerPositions();
  }
}

// ========== TABS MANAGEMENT ==========

function initTabs() {
  const tabs = document.querySelectorAll('.bottom-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab');
      switchTab(tabName);
    });
  });
  
  // Song view toggle button
  const viewToggle = document.getElementById('song-view-toggle');
  if (viewToggle) {
    viewToggle.addEventListener('click', () => {
      songVerseViewMode = songVerseViewMode === 'full' ? 'blocks' : 'full';
      viewToggle.textContent = songVerseViewMode === 'full' ? 'Verse Blocks' : 'Full Song';
      displaySelectedSong();
      saveSongViewMode();
    });
  }
  
  // Song add button
  const addBtn = document.getElementById('song-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openSongEditor();
    });
  }
  
  // Song editor event listeners
  initSongEditor();
  initSongContextMenu();
  initSongListDragDrop();

  // Load saved view mode
  loadSongViewMode();
}

function switchTab(tabName) {
  currentTab = tabName;
  
  // Update tab buttons
  document.querySelectorAll('.bottom-tab').forEach(tab => {
    if (tab.getAttribute('data-tab') === tabName) {
      tab.classList.add('active');
      tab.style.borderBottom = '2px solid #0078d4';
    } else {
      tab.classList.remove('active');
      tab.style.borderBottom = 'none';
    }
  });
  
  // Show/hide tab content
  document.getElementById('verses-tab-content').style.display = tabName === 'verses' ? 'flex' : 'none';
  document.getElementById('songs-tab-content').style.display = tabName === 'songs' ? 'flex' : 'none';
  document.getElementById('media-tab-content').style.display = tabName === 'media' ? 'flex' : 'none';
}

// ========== SONGS MANAGEMENT ==========

async function loadSongs() {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const songsPath = path.join(userData, 'songs.json');
    
    // Create songs.json with empty array if it doesn't exist
    if (!fs.existsSync(songsPath)) {
      fs.writeFileSync(songsPath, JSON.stringify([], null, 2), 'utf8');
      allSongs = [];
    } else {
      const data = fs.readFileSync(songsPath, 'utf8');
      allSongs = JSON.parse(data);
    }
    
    renderSongList(allSongs);
    populateHymnalFilter();
    
    // Add scroll handler for virtual scrolling — guard against duplicate
    // registrations since loadSongs() is called after every import.
    const songListContainer = document.getElementById('song-list');
    if (songListContainer && !songListContainer._scrollHandlerAdded) {
      songListContainer._scrollHandlerAdded = true;
      songListContainer.addEventListener('scroll', () => {
        // Re-render with current filtered state (preserve search results)
        renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
      });
    }
  } catch (err) {
    console.error('Failed to load songs:', err);
    allSongs = [];
  }
}

function renderSongList(songs) {
  // When no search query is active, display A-Z by title.
  // When a search query is active, preserve the caller's order (title matches first, then lyric matches).
  if (!currentSearchQuery) {
    songs = songs.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
  } else {
    songs = songs.slice();
  }
  const songListContainer = document.getElementById('song-list');
  const wrapper = document.getElementById('song-virtual-list');
  if (!wrapper || !songListContainer) return;
  
  const SONG_ITEM_HEIGHT = 32; // Height of each song item
  const SONG_WINDOW_SIZE = 200; // Number of visible items
  const SONG_BUFFER = 20; // Buffer items above/below visible area
  
  // Set the total height for the spacer
  wrapper.style.height = `${songs.length * SONG_ITEM_HEIGHT}px`;
  
  // Remove any previous rendered items
  while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  
  // Calculate which songs to render
  const scrollTop = songListContainer.scrollTop;
  const total = songs.length;
  const firstIndex = Math.max(0, Math.floor(scrollTop / SONG_ITEM_HEIGHT) - SONG_BUFFER);
  const lastIndex = Math.min(
    total,
    Math.ceil((scrollTop + SONG_WINDOW_SIZE * SONG_ITEM_HEIGHT) / SONG_ITEM_HEIGHT) + SONG_BUFFER
  );
  
  // Render only the visible songs
  for (let i = firstIndex; i < lastIndex; i++) {
    const song = songs[i];
    // Find the actual index in allSongs
    const actualIndex = allSongs.findIndex(s => s.title === song.title && s.author === song.author);
    
    const songItem = document.createElement('div');
    songItem.className = 'song-item';
    
    // Build badge for hymnal/page
    const badgeText = song.page
      ? (song.hymnal ? `${song.hymnal} p.${song.page}` : `p.${song.page}`)
      : (song.hymnal ? song.hymnal : '');
    const badgeHtml = badgeText ? `<span class="song-hymnal-badge">${escapeHtml(badgeText)}</span>` : '';
    const titleHtml = currentSearchQuery
      ? highlightText(escapeHtml(song.title), currentSearchQuery)
      : escapeHtml(song.title);
    songItem.innerHTML = `<span class="song-item-title-text">${titleHtml}</span>${badgeHtml}`;
    songItem.title = song.title
      + (song.hymnal ? ` — ${song.hymnal}` : '')
      + (song.page ? ` p.${song.page}` : '');
    
    songItem.setAttribute('data-index', actualIndex);
    songItem.style.cssText = `
      position: absolute;
      top: ${i * SONG_ITEM_HEIGHT}px;
      left: 0;
      right: 0;
      height: ${SONG_ITEM_HEIGHT}px;
      padding: 4px 8px;
      cursor: pointer;
      border-bottom: 1px solid #eee;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      overflow: hidden;
    `;
    
    if (selectedSongIndices.includes(actualIndex)) {
      songItem.style.background = '#0078d4';
      songItem.style.color = '#fff';
    }
    
    songItem.addEventListener('click', (e) => {
      handleSongClick(actualIndex, e);
    });
    
    songItem.addEventListener('dblclick', async (e) => {
      // Double-click to go live with first verse
      selectedSongIndices = [actualIndex];
      selectedSongVerseIndex = 0;
      displaySelectedSong();
      await updateLiveFromSongVerse(0);
      if (!liveMode) {
        toggleLive(true);
      }
    });
    
    songItem.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Select this song if not already selected
      if (!selectedSongIndices.includes(actualIndex)) {
        selectedSongIndices = [actualIndex];
        renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
        displaySelectedSong();
      }
      showSongContextMenu(e.clientX, e.clientY);
    });
    
    songItem.draggable = true;
    songItem.addEventListener('dragstart', (e) => {
      const dragData = {
        type: 'song',
        songIndex: actualIndex
      };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragData));
    });
    
    wrapper.appendChild(songItem);
  }
}

function highlightText(text, query) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(regex, '<span class="search-highlight">$1</span>');
}

function handleSongClick(index, event) {
  if (event.shiftKey && selectedSongIndices.length > 0) {
    // Range selection
    const lastSelected = selectedSongIndices[selectedSongIndices.length - 1];
    const start = Math.min(lastSelected, index);
    const end = Math.max(lastSelected, index);
    selectedSongIndices = [];
    for (let i = start; i <= end; i++) {
      selectedSongIndices.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Toggle selection
    const idx = selectedSongIndices.indexOf(index);
    if (idx > -1) {
      selectedSongIndices.splice(idx, 1);
    } else {
      selectedSongIndices.push(index);
    }
  } else {
    // Single selection
    selectedSongIndices = [index];
  }
  
  renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
  displaySelectedSong();
  
  // Preview first verse
  if (selectedSongIndices.length > 0) {
    selectedSongVerseIndex = 0;
    updatePreviewFromSongVerse(0);
  }
}

function displaySelectedSong() {
  const songDisplay = document.getElementById('song-display');
  if (!songDisplay) return;
  
  if (selectedSongIndices.length === 0) {
    songDisplay.innerHTML = '';
    return;
  }
  
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  let html = `<h2>${currentSearchQuery ? highlightText(song.title, currentSearchQuery) : song.title}</h2>`;
  if (song.author) {
    html += `<p class="song-author">${song.author}</p>`;
  }
  
  if (songVerseViewMode === 'blocks') {
    // Verse blocks view - similar to schedule expanded view
    song.lyrics.forEach((section, sectionIndex) => {
      const verses = section.text.split(/\n\n+/);
      verses.forEach((verse, verseIndex) => {
        const globalVerseIndex = song.lyrics.slice(0, sectionIndex).reduce((sum, s) => sum + s.text.split(/\n\n+/).length, 0) + verseIndex;
        const isSelected = selectedSongVerseIndex === globalVerseIndex;
        const firstLine = verse.split('\n')[0];
        // Remove any highlight markers that might be in the raw text (shouldn't be there, but clean it up)
        const cleanFirstLine = firstLine.replace(/___HIGHLIGHT_(START|END)___/g, '');
        const label = cleanFirstLine.length > 40 ? cleanFirstLine.substring(0, 40) + '...' : cleanFirstLine;
        // Only show verse index if there are multiple verses in this section
        const verseLabel = verses.length > 1 ? ` (${verseIndex + 1})` : '';
        html += `<div class="song-verse-block${isSelected ? ' selected' : ''}" data-verse-index="${globalVerseIndex}">${section.section}${verseLabel}: ${label}</div>`;
      });
    });
  } else {
    // Full view - show complete song text with clickable verses
    song.lyrics.forEach((section, sectionIndex) => {
      html += `<h3>${section.section}</h3>`;
      const verses = section.text.split(/\n\n+/);
      verses.forEach((verse, verseIndex) => {
        const globalVerseIndex = song.lyrics.slice(0, sectionIndex).reduce((sum, s) => sum + s.text.split(/\n\n+/).length, 0) + verseIndex;
        const isSelected = selectedSongVerseIndex === globalVerseIndex;
        const verseHtml = (currentSearchQuery && currentSearchQuery.trim()) ? renderSongVerse(verse, currentSearchQuery) : parseMarkdown(verse);
        html += `<p class="song-verse${isSelected ? ' selected' : ''}" data-verse-index="${globalVerseIndex}" style="white-space: pre-wrap; padding: 4px; margin: 2px 0; cursor: pointer; border-radius: 4px; ${isSelected ? 'background: #0078d4; color: #fff;' : ''}">${verseHtml}</p>`;
      });
    });
  }
  
  songDisplay.innerHTML = html;
  
  // Add double-click handler to song title
  const titleElement = songDisplay.querySelector('h2');
  if (titleElement) {
    titleElement.style.cursor = 'pointer';
    titleElement.addEventListener('dblclick', () => {
      handleSongVerseDoubleClick(0);
    });
  }
  
  // Add click handlers to verses (both full view and block view)
  songDisplay.querySelectorAll('.song-verse, .song-verse-block').forEach(verseEl => {
    const verseIndex = parseInt(verseEl.getAttribute('data-verse-index'));
    verseEl.addEventListener('click', () => {
      handleSongVerseClick(verseIndex);
    });
    verseEl.addEventListener('dblclick', () => {
      handleSongVerseDoubleClick(verseIndex);
    });
  });
}

function handleSongVerseClick(verseIndex) {
  selectedSongVerseIndex = verseIndex;
  displaySelectedSong();
  updatePreviewFromSongVerse(verseIndex);
}

function handleSongVerseDoubleClick(verseIndex) {
  selectedSongVerseIndex = verseIndex;
  displaySelectedSong();
  updateLiveFromSongVerse(verseIndex);
}

function getSongVerseText(verseIndex) {
  if (selectedSongIndices.length === 0) return null;
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return null;
  
  let currentIndex = 0;
  for (const section of song.lyrics) {
    const verses = section.text.split(/\n\n+/);
    for (const verse of verses) {
      if (currentIndex === verseIndex) {
        return {
          title: song.title,
          section: section.section,
          text: verse
        };
      }
      currentIndex++;
    }
  }
  return null;
}

async function updatePreviewFromSongVerse(verseIndex) {
  const verseData = getSongVerseText(verseIndex);
  if (!verseData) return;
  
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  const previewCanvas = document.getElementById('preview-canvas');
  if (previewCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
    const styles = getCanvasStylesFor('song');
    const songPreviewContent = {
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null,
      backgroundMedia: backgroundMedia,
      styles,
      width: width,
      height: height
    };
    window.previewContent = songPreviewContent;
    renderToCanvas(previewCanvas, songPreviewContent, width, height);
  }
}

async function updateLiveFromSongVerse(verseIndex) {
  hideVideoLiveBar();
  // Stop website mirror if it was active before pushing song content
  hideWebsiteLivePanel(true);

  const verseData = getSongVerseText(verseIndex);
  if (!verseData) return;
  
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  const liveCanvas = document.getElementById('live-canvas');
  if (liveCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
    const styles = getCanvasStylesFor('song');
    window.currentContent = {
      type: 'song',
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null,
      width: width,
      height: height,
      backgroundMedia: backgroundMedia,
      styles
    };
    if (blackMode) {
      const ctx = liveCanvas.getContext('2d');
      liveCanvas.width = width;
      liveCanvas.height = height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    } else if (clearMode) {
      const contentWithoutText = { ...window.currentContent, number: '', text: '', reference: '', secondaryText: '', secondaryRef: '' };
      renderToCanvas(liveCanvas, contentWithoutText, width, height);
    } else {
      renderToCanvas(liveCanvas, window.currentContent, width, height);
    }
  }
  
  const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
  ipcRenderer.send('update-live-window', {
    number: '',
    text: verseData.text,
    reference: `${verseData.title} - ${verseData.section}`,
    showingCount: 1,
    totalSelected: 1,
    backgroundMedia: backgroundMedia,
    styles: getCanvasStylesFor('song'),
    _displayStyleOverrides: getPerDisplayStyleOverrides('song') || undefined,
    transitionIn: transitionSettings['fade-in'],
    transitionOut: transitionSettings['fade-out']
  });
  
  // Push song state to relay for mobile to display
  try {
    if (selectedSongIndices.length > 0) {
      const songIndex = selectedSongIndices[0];
      const song = allSongs[songIndex];
      if (song) {
        const state = {
          bible: [],
          songs: [{
            title: song.title,
            author: song.author || '',
            section: verseData.section || '',
            text: verseData.text || '',
            lyricIndex: verseIndex
          }],
          schedule: [],
          scheduling: {
            totalItems: scheduleItems.length,
            currentItem: currentLiveScheduleIndex,
            hasSchedule: scheduleItems.length > 0
          },
          allScheduleItems: buildRelayAllScheduleItems(),
          allSongs: allSongs.map((s, idx) => ({
            index: idx,
            title: s.title,
            author: s.author || '',
            lyrics: s.lyrics || []
          })),
          lastUpdated: Date.now()
        };
        console.log('[relay] Pushing song state:', JSON.stringify(state));
        state.remoteCanvases = getRemoteCanvasSnapshots();
        lastRelayState = state;
        await ipcRenderer.invoke('relay-push-state', state);
      }
    }
  } catch (err) {
    console.error('[relay] Failed to push song state:', err);
  }
}

function selectNextSongVerse() {
  if (selectedSongIndices.length === 0) return;
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  // Count total verses in song
  let totalVerses = 0;
  song.lyrics.forEach(section => {
    totalVerses += section.text.split(/\n\n+/).length;
  });
  
  if (selectedSongVerseIndex === null) {
    selectedSongVerseIndex = 0;
  } else if (selectedSongVerseIndex < totalVerses - 1) {
    selectedSongVerseIndex++;
  }
  
  displaySelectedSong();
  updatePreviewFromSongVerse(selectedSongVerseIndex);
  
  // Blur any focused element to ensure global keyboard handler works properly
  if (document.activeElement) {
    document.activeElement.blur();
  }
}

function selectPrevSongVerse() {
  if (selectedSongIndices.length === 0) return;
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  if (selectedSongVerseIndex === null || selectedSongVerseIndex <= 0) {
    selectedSongVerseIndex = 0;
  } else {
    selectedSongVerseIndex--;
  }
  
  displaySelectedSong();
  updatePreviewFromSongVerse(selectedSongVerseIndex);
  
  // Blur any focused element to ensure global keyboard handler works properly
  if (document.activeElement) {
    document.activeElement.blur();
  }
}

// Check if a keybind string matches the current key event
function matchesKeybind(keybindStr, e) {
  if (!keybindStr) return false;
  
  const parts = keybindStr.split('+');
  const hasCtrl = parts.includes('Ctrl');
  const hasShift = parts.includes('Shift');
  const hasAlt = parts.includes('Alt');
  
  // Check modifiers
  if ((e.ctrlKey || e.metaKey) !== hasCtrl) return false;
  if (e.shiftKey !== hasShift) return false;
  if (e.altKey !== hasAlt) return false;
  
  // Find the main key (not a modifier)
  const modifiers = ['Ctrl', 'Shift', 'Alt'];
  const mainKeys = parts.filter(p => !modifiers.includes(p));
  
  if (mainKeys.length === 0) return false;
  
  // Check if the key matches (case insensitive for all keys)
  return mainKeys.some(k => k.toLowerCase() === e.key.toLowerCase());
}

// Select a verse by index (1-based input, 0-based internal)
function selectSongVerseByNumber(verseNum) {
  if (currentTab !== 'songs') return;
  if (selectedSongIndices.length === 0) return;
  
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  // Find verse sections (sections labeled as "Verse")
  const verseSections = [];
  song.lyrics.forEach((section, idx) => {
    if (section.section.toLowerCase().includes('verse')) {
      verseSections.push(idx);
    }
  });
  
  if (verseNum >= 1 && verseNum <= verseSections.length) {
    const sectionIdx = verseSections[verseNum - 1];
    selectedSongVerseIndex = sectionIdx;
    displaySelectedSong();
    updatePreviewFromSongVerse(selectedSongVerseIndex);
  }
}

// Select a chorus by number (1-based input, 0-based internal)
function selectSongChorusByNumber(chorusNum) {
  if (currentTab !== 'songs') return;
  if (selectedSongIndices.length === 0) return;
  
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  // Find chorus sections
  const chorusSections = [];
  song.lyrics.forEach((section, idx) => {
    if (section.section.toLowerCase().includes('chorus')) {
      chorusSections.push(idx);
    }
  });
  
  if (chorusNum >= 1 && chorusNum <= chorusSections.length) {
    const sectionIdx = chorusSections[chorusNum - 1];
    selectedSongVerseIndex = sectionIdx;
    displaySelectedSong();
    updatePreviewFromSongVerse(selectedSongVerseIndex);
  }
}

// Song search + hymnal filter combined
function applyFiltersAndRender() {
  const searchInput = document.getElementById('song-search-input');
  const hymnalSelect = document.getElementById('song-hymnal-filter');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const hymnalFilter = hymnalSelect ? hymnalSelect.value : '';
  currentSearchQuery = query;

  let pool = allSongs;

  // Hymnal filter (dropdown)
  if (hymnalFilter) {
    pool = pool.filter(s => s.hymnal === hymnalFilter);
  }

  if (!query) {
    filteredSongs = pool;
    renderSongList(filteredSongs);
    displaySelectedSong();
    return;
  }

  // Pure-number query → page number search
  const pageQuery = /^\d+$/.test(query) ? parseInt(query, 10) : null;
  if (pageQuery !== null) {
    filteredSongs = pool.filter(s => s.page === pageQuery);
    renderSongList(filteredSongs);
    displaySelectedSong();
    return;
  }

  // Text search by title and lyrics — title matches first (A-Z), then lyric-only matches (A-Z)
  const titleMatches = [];
  const lyricMatches = [];
  pool.forEach(song => {
    const titleLower = song.title.toLowerCase();
    const inTitle = titleLower.includes(query);
    const inLyrics = !inTitle && song.lyrics.some(section => section.text.toLowerCase().includes(query));
    if (inTitle) titleMatches.push(song);
    else if (inLyrics) lyricMatches.push(song);
  });

  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
  titleMatches.sort(byTitle);
  lyricMatches.sort(byTitle);
  filteredSongs = [...titleMatches, ...lyricMatches];
  renderSongList(filteredSongs);
  displaySelectedSong();
}

function populateHymnalFilter() {
  const select = document.getElementById('song-hymnal-filter');
  if (!select) return;
  const hymnals = [...new Set(allSongs.filter(s => s.hymnal).map(s => s.hymnal))].sort();
  const currentVal = select.value;
  select.innerHTML = '<option value="">All hymnals</option>';
  hymnals.forEach(h => {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h;
    select.appendChild(opt);
  });
  if (hymnals.includes(currentVal)) select.value = currentVal;
}

// Song search
document.addEventListener('DOMContentLoaded', () => {
  const songSearchInput = document.getElementById('song-search-input');
  if (songSearchInput) {
    songSearchInput.addEventListener('input', applyFiltersAndRender);
  }
  const hymnalSelect = document.getElementById('song-hymnal-filter');
  if (hymnalSelect) {
    hymnalSelect.addEventListener('change', applyFiltersAndRender);
  }
});

// ========== SONG CONTEXT MENU ==========

function showSongContextMenu(x, y) {
  const menu = document.getElementById('song-context-menu');
  if (!menu) return;
  
  const editOption = document.getElementById('song-context-edit');
  const deleteOption = document.getElementById('song-context-delete');
  const exportOption = document.getElementById('song-context-export');
  const importOption = document.getElementById('song-context-import');

  // Configure options based on selection
  if (selectedSongIndices.length === 0) {
    if (editOption) editOption.style.display = 'none';
    if (deleteOption) deleteOption.style.display = 'none';
    if (exportOption) exportOption.style.display = 'none';
  } else if (selectedSongIndices.length === 1) {
    if (editOption) editOption.style.display = 'block';
    if (deleteOption) deleteOption.style.display = 'block';
    if (exportOption) exportOption.style.display = 'block';
  } else {
    if (editOption) editOption.style.display = 'none';
    if (deleteOption) deleteOption.style.display = 'block';
    if (exportOption) exportOption.style.display = 'block';
  }

  // Import should always be visible
  if (importOption) importOption.style.display = 'block';

  // Position menu initially to measure its size
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = 'block';
  
  // Adjust position if menu would go off screen
  const menuRect = menu.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  
  // Adjust horizontal position if needed
  if (menuRect.right > viewportWidth) {
    menu.style.left = `${viewportWidth - menuRect.width - 5}px`;
  }
  
  // Adjust vertical position if needed
  if (menuRect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(5, y - menuRect.height)}px`;
  }
  
  // Close menu when clicking outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.style.display = 'none';
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// Generic helper: close a context menu by id
function closeContextMenu(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = 'none';
}

async function startVpImport() {
  let result;
  try { result = await ipcRenderer.invoke('vp-collect-songbooks'); } catch { return; }
  if (!result || result.cancelled || !result.songbooks || result.songbooks.length === 0) return;
  showVpImportPreview(result.songbooks);
}

function showVpImportPreview(songbooks) {
  const overlay = document.getElementById('vp-import-modal-overlay');
  const subtitle = document.getElementById('vp-import-modal-subtitle');
  const list = document.getElementById('vp-import-modal-list');
  const confirmBtn = document.getElementById('vp-import-modal-confirm');
  const cancelBtn = document.getElementById('vp-import-modal-cancel');

  const totalSongs = songbooks.reduce((s, sb) => s + sb.songCount, 0);
  subtitle.textContent = `${songbooks.length} songbook${songbooks.length !== 1 ? 's' : ''} found, ${totalSongs.toLocaleString()} songs total. Select which to import:`;
  list.innerHTML = songbooks.map((sb, i) =>
    `<label class="vp-book-row">
       <input type="checkbox" class="vp-book-check" data-idx="${i}" checked />
       <span class="vp-book-row-name">${sb.name}</span>
       <span class="vp-book-row-stats">${sb.songCount.toLocaleString()} song${sb.songCount !== 1 ? 's' : ''}</span>
     </label>`
  ).join('');

  overlay.style.display = 'flex';

  function cleanup() {
    confirmBtn.removeEventListener('click', doConfirm);
    cancelBtn.removeEventListener('click', doCancel);
    overlay.removeEventListener('click', onOverlayClick);
    document.removeEventListener('keydown', onKeyDown);
    overlay.style.display = 'none';
  }

  async function doConfirm() {
    const selected = [...list.querySelectorAll('.vp-book-check:checked')]
      .map(cb => songbooks[parseInt(cb.dataset.idx, 10)].path);
    if (!selected.length) { cleanup(); return; }
    cleanup();
    let res;
    try { res = await ipcRenderer.invoke('vp-do-import', selected); } catch { return; }
    if (!res) return;
    const _t = document.createElement('div');
    _t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0078d4;color:#fff;padding:10px 20px;border-radius:6px;font-size:13px;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,0.35);pointer-events:none;white-space:nowrap;';
    _t.textContent = `VideoPsalm: found ${res.total} song(s), imported ${res.added} new song(s).`;
    document.body.appendChild(_t);
    setTimeout(() => { try { document.body.removeChild(_t); } catch {} }, 4000);
    loadSongs();
  }

  function doCancel() { cleanup(); }
  function onOverlayClick(e) { if (e.target === overlay) doCancel(); }
  function onKeyDown(e) { if (e.key === 'Escape') doCancel(); }

  confirmBtn.addEventListener('click', doConfirm);
  cancelBtn.addEventListener('click', doCancel);
  overlay.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onKeyDown);
}

ipcRenderer.on('vp-start-import', () => startVpImport());

function initSongContextMenu() {
  const editBtn = document.getElementById('song-context-edit');
  const deleteBtn = document.getElementById('song-context-delete');
  const exportBtn = document.getElementById('song-context-export');
  const importBtn = document.getElementById('song-context-import');
  
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      if (selectedSongIndices.length === 1) {
        editSong(selectedSongIndices[0]);
      }
    });
  }
  
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      deleteSongs(selectedSongIndices);
    });
  }
  
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      exportSongs(selectedSongIndices);
    });
  }
  
  if (importBtn) {
    // Parent "Import" item reveals submenu on hover (CSS); clicking is intentionally a no-op.
    importBtn.addEventListener('click', (e) => { e.stopPropagation(); });
  }

  const ewImportBtn   = document.getElementById('song-import-easyworship');
  const vpImportBtn   = document.getElementById('song-import-videopsalm');
  const fileImportBtn = document.getElementById('song-import-file');

  if (ewImportBtn) {
    ewImportBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      ipcRenderer.invoke('import-easyworship');
    });
  }

  if (vpImportBtn) {
    vpImportBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      startVpImport();
    });
  }

  if (fileImportBtn) {
    fileImportBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      importSongs();
    });
  }

  // Allow right-click anywhere in the song list to open the context menu (useful when there are no songs)
  const songListEl = document.getElementById('song-list');
  if (songListEl) {
    songListEl.addEventListener('contextmenu', (e) => {
      // If user right-clicked on a specific song item, let that handler run instead
      if (e.target.closest('[data-index]')) return;
      e.preventDefault();
      // Don't change selection; show menu with import enabled
      showSongContextMenu(e.clientX, e.clientY);
    });

    // Ctrl/Cmd + A when the song list is focused should select all displayed songs
    songListEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const dataset = (filteredSongs && filteredSongs.length > 0) ? filteredSongs : allSongs;
        if (!dataset || dataset.length === 0) return;
        // Map the displayed songs back to their indices in allSongs
        const indices = dataset.map(s => allSongs.findIndex(x => x.title === s.title && x.author === s.author)).filter(i => i >= 0);
        if (indices.length === 0) return;
        selectedSongIndices = indices;
        renderSongList(dataset);
        displaySelectedSong();
      }
    });
  }
}

// Helper: fix and parse a VideoPsalm-format JSON file that may have literal
// newlines inside string values or unquoted object keys.
function fixAndParseVideoPsalmJson(raw) {
  const result = [];
  let inString = false;
  let escaped  = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) { result.push(c); escaped = false; continue; }
    if (c === '\\') { result.push(c); escaped = true; continue; }
    if (c === '"') { inString = !inString; result.push(c); continue; }
    if (inString && (c === '\r' || c === '\n')) {
      if (c === '\r' && raw[i + 1] === '\n') i++;
      result.push('\\n');
      continue;
    }
    result.push(c);
  }
  let s = result.join('');
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  return JSON.parse(s);
}

function initSongListDragDrop() {
  const songListEl = document.getElementById('songs-tab-content');
  if (!songListEl) return;

  songListEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      songListEl.classList.add('drag-over');
    }
  });

  songListEl.addEventListener('dragleave', (e) => {
    if (!songListEl.contains(e.relatedTarget)) {
      songListEl.classList.remove('drag-over');
    }
  });

  songListEl.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    songListEl.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f =>
      /\.(json|txt|rtf|zip|db)$/i.test(f.name)
    );
    if (files.length > 0) await processSongImportFiles(files);
  });
}

function editSong(songIndex) {
  const song = allSongs[songIndex];
  if (!song) return;
  
  const modal = document.getElementById('song-editor-modal');
  const titleInput = document.getElementById('song-editor-title');
  const authorInput = document.getElementById('song-editor-author');
  const lyricsDiv = document.getElementById('song-editor-lyrics');
  
  if (modal && titleInput && authorInput && lyricsDiv) {
    // Store the index we're editing
    modal.setAttribute('data-editing-index', songIndex);
    
    modal.style.display = 'flex';
    titleInput.value = song.title;
    authorInput.value = song.author || '';
    const hymnalInput = document.getElementById('song-editor-hymnal');
    const pageInput = document.getElementById('song-editor-page');
    if (hymnalInput) hymnalInput.value = song.hymnal || '';
    if (pageInput) pageInput.value = song.page || '';
    
    // Convert song lyrics back to plain text with [Section] tags
    const lyricsText = song.lyrics.map(section => `[${section.section}]\n${section.text}`).join('\n\n');
    lyricsDiv.textContent = lyricsText;
    const previewEl = document.getElementById('song-editor-preview');
    if (previewEl) previewEl.style.display = 'none';
    
    titleInput.focus();
  }
}

async function deleteSongs(songIndices) {
  if (songIndices.length === 0) return;
  
  const count = songIndices.length;
  const message = count === 1 
    ? `Are you sure you want to delete "${allSongs[songIndices[0]].title}"?`
    : `Are you sure you want to delete ${count} songs?`;
  
  if (!confirm(message)) return;
  
  // Sort indices in descending order to avoid index shifting issues
  const sortedIndices = songIndices.slice().sort((a, b) => b - a);
  
  // Remove songs
  sortedIndices.forEach(index => {
    allSongs.splice(index, 1);
  });
  
  // Save to file
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const songsPath = path.join(userData, 'songs.json');
    fs.writeFileSync(songsPath, JSON.stringify(allSongs, null, 2), 'utf8');
    
    // Clear selection and refresh
    selectedSongIndices = [];
    selectedSongVerseIndex = null;
    filteredSongs = [];
    currentSearchQuery = '';
    const searchInput = document.getElementById('song-search-input');
    if (searchInput) searchInput.value = '';
    
    renderSongList(allSongs);
    populateHymnalFilter();
    displaySelectedSong();
  } catch (err) {
    console.error('Failed to delete songs:', err);
    alert('Failed to delete songs');
  }
}

function songToPlainText(song) {
  const lines = [];
  if (song.title)  lines.push(song.title);
  if (song.author) lines.push(song.author);
  if (lines.length) lines.push('');
  (song.lyrics || []).forEach((section, i) => {
    if (section.section) lines.push(`[${section.section}]`);
    if (section.text)    lines.push(section.text);
    if (i < (song.lyrics.length - 1)) lines.push('');
  });
  return lines.join('\n');
}

function exportSongs(songIndices) {
  if (songIndices.length === 0) return;
  const songsToExport = songIndices.map(i => allSongs[i]);

  // Show format picker modal
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;display:flex;align-items:center;justify-content:center;';

  const card = document.createElement('div');
  const isDark = document.body.classList.contains('dark-theme');
  card.style.cssText = `padding:24px 28px;width:320px;max-width:95vw;border-radius:8px;background:${isDark ? '#23272a' : '#fff'};color:${isDark ? '#eee' : '#000'};box-shadow:0 4px 20px rgba(0,0,0,0.3);`;
  card.innerHTML = `
    <div style="font-size:1.1em;font-weight:600;margin-bottom:16px;">Export ${songsToExport.length} song${songsToExport.length !== 1 ? 's' : ''}</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <button id="exp-litsong" class="btn primary" style="text-align:left;padding:10px 14px;"><strong>Liturgia Songs (.litsong)</strong><div style="font-size:0.8em;opacity:0.75;margin-top:2px;">Reimportable in Liturgia — preserves all data</div></button>
      <button id="exp-json" class="btn" style="text-align:left;padding:10px 14px;"><strong>JSON (.json)</strong><div style="font-size:0.8em;opacity:0.75;margin-top:2px;">Generic JSON — compatible with other tools</div></button>
      <button id="exp-txt" class="btn" style="text-align:left;padding:10px 14px;"><strong>Text file</strong><div style="font-size:0.8em;opacity:0.75;margin-top:2px;">All songs in one .txt file</div></button>
      <button id="exp-zip" class="btn" style="text-align:left;padding:10px 14px;"><strong>Text files (ZIP)</strong><div style="font-size:0.8em;opacity:0.75;margin-top:2px;">One .txt per song, zipped</div></button>
    </div>
    <div style="margin-top:16px;text-align:right;"><button id="exp-cancel" class="btn">Cancel</button></div>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const close = () => document.body.removeChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  card.querySelector('#exp-cancel').onclick = close;

  card.querySelector('#exp-litsong').onclick = () => {
    close();
    const jsonData = JSON.stringify(songsToExport, null, 2);
    const blob = new Blob([jsonData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `songs-export-${Date.now()}.litsong`; a.click();
    URL.revokeObjectURL(url);
  };

  card.querySelector('#exp-json').onclick = () => {
    close();
    const jsonData = JSON.stringify(songsToExport, null, 2);
    const blob = new Blob([jsonData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `songs-export-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  card.querySelector('#exp-txt').onclick = () => {
    close();
    const separator = '\n' + '='.repeat(60) + '\n\n';
    const combined = songsToExport.map(songToPlainText).join(separator);
    const blob = new Blob([combined], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = songsToExport.length === 1
      ? (songsToExport[0].title || 'song').replace(/[/\\:*?"<>|]/g, '_') + '.txt'
      : `songs-export-${Date.now()}.txt`;
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  card.querySelector('#exp-zip').onclick = () => {
    close();
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      // Track used filenames to avoid collisions
      const used = {};
      songsToExport.forEach(song => {
        const base = (song.title || 'song').replace(/[/\\:*?"<>|]/g, '_').trim() || 'song';
        let fname = base + '.txt';
        if (used[fname]) { let n = 2; while (used[`${base}-${n}.txt`]) n++; fname = `${base}-${n}.txt`; }
        used[fname] = true;
        zip.addFile(fname, Buffer.from(songToPlainText(song), 'utf8'));
      });
      const buf = zip.toBuffer();
      const blob = new Blob([buf], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `songs-export-${Date.now()}.zip`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('ZIP export failed:', e);
      alert('ZIP export failed: ' + e.message);
    }
  };
}

function saveTutorialState(patch = {}) {
  _tutorialState = { ...(_tutorialState || {}), ...patch };
  try { ipcRenderer.invoke('update-settings', { tutorialState: _tutorialState }).catch(() => {}); } catch (_) {}
}

function ensureTutorialOverlay() {
  return document.getElementById('tutorial-overlay');
}

function renderTutorialStep(step, index, total, mode) {
  const titleEl = document.getElementById('tutorial-title');
  const bodyEl = document.getElementById('tutorial-body');
  const stepEl = document.getElementById('tutorial-step');
  const topicsEl = document.getElementById('tutorial-topics');
  const backBtn = document.getElementById('tutorial-back');
  const nextBtn = document.getElementById('tutorial-next');
  const skipBtn = document.getElementById('tutorial-skip');
  if (!titleEl || !bodyEl || !stepEl || !topicsEl || !backBtn || !nextBtn || !skipBtn) return;

  topicsEl.style.display = 'none';
  topicsEl.innerHTML = '';
  titleEl.textContent = step.title || 'Tutorial';
  bodyEl.textContent = step.body || '';
  stepEl.textContent = mode === 'topics' ? 'Choose a topic' : `Step ${index + 1} of ${total}`;
  backBtn.style.display = index > 0 ? '' : 'none';
  nextBtn.style.display = mode === 'topics' ? 'none' : '';
  skipBtn.style.display = mode === 'topics' ? 'none' : '';
  backBtn.textContent = mode === 'topics' ? 'Close' : 'Back';
}

function openTutorialHub(startMode = 'auto') {
  const overlay = ensureTutorialOverlay();
  if (!overlay) return;

  const signedIn = !!_tutorialSignedIn;
  const firstRun = !(_tutorialState && _tutorialState.seenOnboarding);
  const mode = startMode === 'auto' ? (firstRun ? 'onboarding' : 'topics') : startMode;

  let stepIndex = 0;
  let activeTopic = null;

  const close = () => {
    overlay.style.display = 'none';
    saveTutorialState({ lastOpened: Date.now() });
  };

  const showTopics = () => {
    activeTopic = null;
    const titleEl = document.getElementById('tutorial-title');
    const bodyEl = document.getElementById('tutorial-body');
    const topicsEl = document.getElementById('tutorial-topics');
    const backBtn = document.getElementById('tutorial-back');
    const nextBtn = document.getElementById('tutorial-next');
    const skipBtn = document.getElementById('tutorial-skip');
    if (!titleEl || !bodyEl || !topicsEl || !backBtn || !nextBtn || !skipBtn) return;

    titleEl.textContent = 'Tutorial Topics';
    bodyEl.textContent = 'Pick a topic and we will guide you through that feature only.';
    topicsEl.style.display = 'grid';
    topicsEl.innerHTML = '';
    Object.entries(TUTORIAL_TOPICS).forEach(([key, topic]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'border:1px solid #29405f;background:#13233b;color:#e8eef9;border-radius:14px;padding:16px;text-align:left;cursor:pointer;';
      btn.innerHTML = `<div style="font-weight:700;font-size:16px;margin-bottom:6px;">${topic.title}</div><div style="font-size:13px;color:#b8c4d6;">${topic.intro}</div>`;
      btn.addEventListener('click', () => startTopicTour(key));
      topicsEl.appendChild(btn);
    });
    backBtn.style.display = 'none';
    nextBtn.style.display = 'none';
    skipBtn.style.display = 'none';
  };

  const startTopicTour = (topicKey) => {
    const topic = TUTORIAL_TOPICS[topicKey];
    if (!topic) return;
    activeTopic = topicKey;
    stepIndex = 0;

    const update = () => {
      const step = topic.steps[stepIndex];
      renderTutorialStep(
        { title: topic.title + ' - ' + step.title, body: step.body },
        stepIndex,
        topic.steps.length,
        'topic'
      );
      const nextBtn = document.getElementById('tutorial-next');
      const backBtn = document.getElementById('tutorial-back');
      const skipBtn = document.getElementById('tutorial-skip');
      if (nextBtn) nextBtn.textContent = stepIndex === topic.steps.length - 1 ? 'Done' : 'Next';
      if (backBtn) backBtn.style.display = 'none';
      if (skipBtn) skipBtn.style.display = 'none';
    };

    const next = () => {
      if (stepIndex < topic.steps.length - 1) {
        stepIndex += 1;
        update();
      } else {
        overlay.removeEventListener('click', onBackdrop);
        close();
      }
    };

    const onBackdrop = (e) => { if (e.target === overlay) close(); };
    overlay.addEventListener('click', onBackdrop, { once: true });
    update();
    const nextBtn = document.getElementById('tutorial-next');
    if (nextBtn) nextBtn.onclick = next;
    const backBtn = document.getElementById('tutorial-back');
    if (backBtn) backBtn.onclick = showTopics;
  };

  overlay.style.display = 'flex';

  const backBtn = document.getElementById('tutorial-back');
  const nextBtn = document.getElementById('tutorial-next');
  const skipBtn = document.getElementById('tutorial-skip');
  const closeBtn = document.getElementById('tutorial-close');

  const onBackdrop = (e) => { if (e.target === overlay) close(); };
  overlay.addEventListener('click', onBackdrop, { once: true });
  if (closeBtn) closeBtn.onclick = close;

  if (mode === 'onboarding') {
    const update = () => {
      const step = TUTORIAL_ONBOARDING[stepIndex];
      renderTutorialStep(step, stepIndex, TUTORIAL_ONBOARDING.length, 'onboarding');
      if (nextBtn) nextBtn.textContent = stepIndex === TUTORIAL_ONBOARDING.length - 1 ? 'Finish' : 'Next';
      if (backBtn) backBtn.style.display = stepIndex > 0 ? '' : 'none';
      if (skipBtn) skipBtn.textContent = 'Skip Tour';
    };
    const next = () => {
      if (stepIndex < TUTORIAL_ONBOARDING.length - 1) {
        stepIndex += 1;
        update();
      } else {
        saveTutorialState({ seenOnboarding: true, seenTopics: true });
        close();
      }
    };
    const back = () => { if (stepIndex > 0) { stepIndex -= 1; update(); } };
    if (nextBtn) nextBtn.onclick = next;
    if (backBtn) backBtn.onclick = back;
    if (skipBtn) skipBtn.onclick = () => { saveTutorialState({ seenOnboarding: true }); showTopics(); };
    update();
    return;
  }

  showTopics();
  if (backBtn) backBtn.onclick = close;
  if (nextBtn) nextBtn.onclick = () => {};
  if (skipBtn) skipBtn.onclick = () => {};
}

function promptTutorialAfterSignIn() {
  if (_tutorialPrompted) return;
  const state = _tutorialState || {};
  if (state.seenOnboarding) return;
  _tutorialPrompted = true;
  const overlay = ensureTutorialOverlay();
  if (!overlay) return;
  overlay.style.display = 'flex';
  const titleEl = document.getElementById('tutorial-title');
  const bodyEl = document.getElementById('tutorial-body');
  const topicsEl = document.getElementById('tutorial-topics');
  const stepEl = document.getElementById('tutorial-step');
  const backBtn = document.getElementById('tutorial-back');
  const nextBtn = document.getElementById('tutorial-next');
  const skipBtn = document.getElementById('tutorial-skip');
  const closeBtn = document.getElementById('tutorial-close');
  if (titleEl) titleEl.textContent = 'Take a quick tour?';
  if (bodyEl) bodyEl.textContent = 'We can walk you through the minimum steps to get ready for service, or you can skip and open Help → Tutorial later.';
  if (topicsEl) { topicsEl.style.display = 'none'; topicsEl.innerHTML = ''; }
  if (stepEl) stepEl.textContent = 'First sign-in only';
  if (backBtn) { backBtn.style.display = 'none'; }
  if (nextBtn) {
    nextBtn.style.display = '';
    nextBtn.textContent = 'Start Tour';
    nextBtn.onclick = () => {
      saveTutorialState({ seenOnboarding: false, promptedOnboarding: true });
      openTutorialHub('onboarding');
    };
  }
  if (skipBtn) {
    skipBtn.style.display = '';
    skipBtn.textContent = 'Not Now';
    skipBtn.onclick = () => {
      saveTutorialState({ seenOnboarding: true, promptedOnboarding: true });
      overlay.style.display = 'none';
    };
  }
  if (closeBtn) {
    closeBtn.onclick = () => {
      saveTutorialState({ seenOnboarding: true, promptedOnboarding: true });
      overlay.style.display = 'none';
    };
  }
}

function importSongs() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.litsong,.txt,.rtf,.zip,.db';
  input.multiple = true;
  input.onchange = (e) => processSongImportFiles(Array.from(e.target.files));
  input.click();
}

async function processSongImportFiles(files) {
  if (!files || files.length === 0) return;

  let addedCount = 0;

  // Process a plain-text string (possibly containing multiple songs separated by ====)
  // fallbackTitle is used only when the block has no title line of its own.
  const processTxtContent = (plainText, fallbackTitle) => {
    // Split on separator lines (3+ = signs on a line by themselves)
    const blocks = plainText.split(/^={3,}\s*$/m).map(b => b.trim()).filter(Boolean);
    const batch = blocks.length > 1 || !fallbackTitle;
    blocks.forEach(block => {
      // If multiple blocks (batch file) or no fallback, auto-detect title from first line
      const title = (batch || !fallbackTitle) ? null : fallbackTitle;
      const parsed = parseSongText(title, block);
      if (parsed) {
        const exists = allSongs.some(s => s.title === parsed.title && s.author === parsed.author);
        if (!exists) { allSongs.push(parsed); addedCount++; }
      }
    });
  };

  for (const file of files) {
    const fileName = file.name;
    const fileExt  = path.extname(fileName).toLowerCase();

    try {
      if (fileExt === '.zip') {
        // ZIP: extract entries and process each one
        const AdmZip = require('adm-zip');
        const buf = Buffer.from(await file.arrayBuffer());
        const zip = new AdmZip(buf);
        zip.getEntries().forEach(entry => {
          if (entry.isDirectory) return;
          const entryName = entry.entryName;
          const entryExt  = path.extname(entryName).toLowerCase();
          try {
            const content = entry.getData().toString('utf8');
            if (entryExt === '.json') {
              const imported = JSON.parse(content);
              (Array.isArray(imported) ? imported : [imported]).forEach(song => {
                if (song.title && song.lyrics && Array.isArray(song.lyrics)) {
                  const exists = allSongs.some(s => s.title === song.title && s.author === song.author);
                  if (!exists) { allSongs.push(song); addedCount++; }
                }
              });
            } else if (entryExt === '.txt') {
              processTxtContent(content, path.basename(entryName, entryExt));
            } else if (entryExt === '.rtf') {
              processTxtContent(stripRTF(content), path.basename(entryName, entryExt));
            }
          } catch (err) {
            console.error(`Failed to import zip entry ${entryName}:`, err);
          }
        });

      } else if (fileExt === '.db') {
        // EasyWorship Songs.db / SongWords.db — handled in main process via sql.js
        const result = await ipcRenderer.invoke('import-ew-db-file', file.path);
        if (result && result.added > 0) {
          // Main process already wrote to songs.json; sync allSongs from disk
          try {
            const userData  = await ipcRenderer.invoke('get-user-data-path');
            const songsPath = path.join(userData, 'songs.json');
            const loaded    = JSON.parse(fs.readFileSync(songsPath, 'utf8') || '[]');
            allSongs.length = 0;
            allSongs.push(...loaded);
            renderSongList(allSongs);
            populateHymnalFilter();
          } catch {}
          const _ti = document.createElement('div');
          _ti.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0078d4;color:#fff;padding:10px 20px;border-radius:6px;font-size:13px;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,0.35);pointer-events:none;white-space:nowrap;';
          _ti.textContent = `EasyWorship: found ${result.total} song(s), imported ${result.added} new song(s).`;
          document.body.appendChild(_ti);
          setTimeout(() => { try { document.body.removeChild(_ti); } catch (e) {} }, 4000);
        } else {
          if (result && result.error) console.warn('[import-ew-db-file]', result.error);
          const _ti2 = document.createElement('div');
          _ti2.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#555;color:#fff;padding:10px 20px;border-radius:6px;font-size:13px;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,0.35);pointer-events:none;white-space:nowrap;';
          _ti2.textContent = `No new songs found in ${fileName}${result ? ` (${result.total} found, all duplicates)` : ''}.`;
          document.body.appendChild(_ti2);
          setTimeout(() => { try { document.body.removeChild(_ti2); } catch (e) {} }, 4000);
        }
        continue; // already saved — skip the shared save below

      } else {
        const fileContent = await file.text();

        if (fileExt === '.json' || fileExt === '.litsong') {
          let parsed;
          try {
            parsed = JSON.parse(fileContent);
          } catch (_) {
            try { parsed = fixAndParseVideoPsalmJson(fileContent); }
            catch (e2) { console.warn(`Skipping ${fileName}: JSON parse failed`, e2); continue; }
          }

          if (parsed && (Array.isArray(parsed.Songs) || Array.isArray(parsed.songs))) {
            // VideoPsalm format
            const vpSongs = parsed.Songs || parsed.songs || [];
            vpSongs.forEach(vpSong => {
              const title  = vpSong.Text || 'Untitled';
              const author = [vpSong.Author, vpSong.Composer].filter(Boolean).join(', ') || '';
              const lyrics = (vpSong.Verses || []).map(v => ({
                section: '',
                text: (v.Text || '').replace(/\[[A-Ga-g][^\]]{0,10}\]/g, '').trim()
              })).filter(v => v.text);
              if (lyrics.length) {
                const exists = allSongs.some(s => (s.title || '').trim() === title.trim());
                if (!exists) { allSongs.push({ title, author, lyrics }); addedCount++; }
              }
            });
          } else if (Array.isArray(parsed)) {
            // Liturgia JSON format
            parsed.forEach(song => {
              if (song.title && song.lyrics && Array.isArray(song.lyrics)) {
                const exists = allSongs.some(s => s.title === song.title && s.author === song.author);
                if (!exists) { allSongs.push(song); addedCount++; }
              }
            });
          } else {
            console.warn(`Skipping ${fileName}: unrecognized JSON structure`);
          }

        } else if (fileExt === '.txt') {
          processTxtContent(fileContent, path.basename(fileName, fileExt));
        } else if (fileExt === '.rtf') {
          processTxtContent(stripRTF(fileContent), path.basename(fileName, fileExt));
        } else {
          console.warn(`Skipping ${fileName}: unsupported file type`);
        }
      }
    } catch (err) {
      console.error(`Failed to import ${fileName}:`, err);
    }
  }

  if (addedCount > 0) {
    try {
      const userData  = await ipcRenderer.invoke('get-user-data-path');
      const songsPath = path.join(userData, 'songs.json');
      fs.writeFileSync(songsPath, JSON.stringify(allSongs, null, 2), 'utf8');
      renderSongList(allSongs);
      populateHymnalFilter();
      alert(`Imported ${addedCount} song(s)`);
    } catch (err) {
      console.error('Failed to save imported songs:', err);
      alert('Failed to save imported songs');
    }
  } else {
    alert('No new songs to import (duplicates skipped or invalid files)');
  }
}

// Helper function to strip RTF formatting and extract plain text
function stripRTF(rtfContent) {
  // Basic RTF stripper - removes control words and groups
  let text = rtfContent;
  
  // Remove RTF header and control groups
  text = text.replace(/\{\\rtf1[^}]*\}/g, '');
  
  // Remove control words like \par, \pard, \tab, etc.
  text = text.replace(/\\[a-z]+\d*/g, ' ');
  
  // Remove control symbols
  text = text.replace(/\\[^a-z\s]/g, '');
  
  // Remove curly braces
  text = text.replace(/[{}]/g, '');
  
  // Replace multiple spaces with single space
  text = text.replace(/\s+/g, ' ');
  
  // Replace \par and similar with newlines
  text = text.replace(/\\par\s*/g, '\n');
  
  // Clean up extra whitespace
  text = text.trim();
  
  return text;
}

// Helper function to parse song text using same logic as song editor
// Pass title=null to auto-detect the title from the first line of the text block.
function parseSongText(title, lyricsText) {
  let text = lyricsText.trim();
  if (!text) return null;

  const allLines = text.split('\n');
  let author = '';

  // Auto-detect title: consume the first non-empty line as the song title
  if (!title) {
    const firstNonEmpty = allLines.findIndex(l => l.trim());
    if (firstNonEmpty === -1) return null;
    title = allLines[firstNonEmpty].trim();
    allLines.splice(0, firstNonEmpty + 1);
    text = allLines.join('\n').trim();
  }

  // Author detection: if the next non-empty, non-section-tag line is short and
  // looks like a name/attribution (no brackets, under 60 chars), treat it as author.
  const nextLineIdx = allLines.findIndex(l => l.trim());
  if (nextLineIdx !== -1) {
    const candidate = allLines[nextLineIdx].trim();
    const isSectionTag = /^[\[\{\(].+[\]\}\)]$/.test(candidate);
    const looksLikeName = !isSectionTag && candidate.length <= 60 && !candidate.includes('\n');
    if (looksLikeName) {
      // Only use as author when it isn't followed immediately by more text on the same
      // line and the next block starts after a blank line (i.e., it stands alone).
      const afterCandidate = allLines.slice(nextLineIdx + 1);
      const nextAfter = afterCandidate.findIndex(l => l.trim());
      const authorLineIsAlone = nextAfter === -1 || afterCandidate.slice(0, nextAfter).every(l => !l.trim());
      if (authorLineIsAlone && nextAfter !== 0) {
        author = candidate;
        allLines.splice(0, nextLineIdx + 1);
        text = allLines.join('\n').trim();
      }
    }
  }

  if (!text) return null;

  // Parse sections (blank-line delimited, optional [Tag] first line)
  const sectionTexts = text.split(/\n\n+/).filter(v => v.trim());
  const sections = [];
  sectionTexts.forEach((block) => {
    let sectionLabel = 'Verse';
    let sectionContent = block.trim();
    const lines = sectionContent.split('\n');
    const tagMatch = lines[0] ? lines[0].trim().match(/^[\[\{\(](.+?)[\]\}\)]$/) : null;
    if (tagMatch) {
      sectionLabel = tagMatch[1].trim();
      lines.shift();
      sectionContent = lines.join('\n').trim();
    }
    if (sectionContent) sections.push({ section: sectionLabel, text: sectionContent });
  });

  if (sections.length === 0) return null;
  return { title, author, lyrics: sections };
}

// ========== SONG EDITOR ==========

function initSongEditor() {
  const modal = document.getElementById('song-editor-modal');
  const closeBtn = document.getElementById('song-editor-close');
  const cancelBtn = document.getElementById('song-editor-cancel');
  const saveBtn = document.getElementById('song-editor-save');
  const lyricsInput = document.getElementById('song-editor-lyrics');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSongEditor);
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeSongEditor);
  }
  
  if (saveBtn) {
    saveBtn.addEventListener('click', saveSongFromEditor);
  }

  // Preview toggle button (added dynamically if not present)
  let previewToggle = document.getElementById('song-editor-preview-toggle');
  if (!previewToggle) {
    previewToggle = document.createElement('button');
    previewToggle.id = 'song-editor-preview-toggle';
    previewToggle.textContent = 'Show Preview';
    previewToggle.style.padding = '8px 12px';
    previewToggle.style.cursor = 'pointer';
    previewToggle.style.marginRight = '8px';
    const footer = document.querySelector('.song-editor-footer');
    if (footer) footer.insertBefore(previewToggle, footer.firstChild);
  }

  previewToggle.addEventListener('click', () => {
    const previewEl = document.getElementById('song-editor-preview');
    if (!previewEl) return;
    if (previewEl.style.display === 'none' || previewEl.style.display === '') {
      updateSongPreview();
      previewEl.style.display = 'block';
      previewToggle.textContent = 'Hide Preview';
    } else {
      previewEl.style.display = 'none';
      previewToggle.textContent = 'Show Preview';
    }
  });

  // Edit Styles button (opens popover for editing song styles)
  let editStylesBtn = document.getElementById('song-editor-edit-styles');
  if (!editStylesBtn) {
    editStylesBtn = document.createElement('button');
    editStylesBtn.id = 'song-editor-edit-styles';
    editStylesBtn.textContent = 'Edit Styles';
    editStylesBtn.style.padding = '8px 12px';
    editStylesBtn.style.cursor = 'pointer';
    editStylesBtn.style.marginRight = '8px';
    const footer = document.querySelector('.song-editor-footer');
    if (footer) footer.insertBefore(editStylesBtn, footer.firstChild);

  // Right-click context menu for all editable fields in the song editor
  const ctxMenu = document.getElementById('song-editor-ctx-menu');
  if (ctxMenu && modal) {
    let ctxTarget = null;

    function hideCtxMenu() {
      ctxMenu.style.display = 'none';
      ctxTarget = null;
    }

    const editorPanel = document.getElementById('song-editor-panel');
    if (editorPanel) {
      editorPanel.addEventListener('contextmenu', (e) => {
        const t = e.target;
        const isEditable = t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
        if (!isEditable) return;
        e.preventDefault();
        ctxTarget = t;
        const x = Math.min(e.clientX, window.innerWidth - 160);
        const y = Math.min(e.clientY, window.innerHeight - 160);
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
        ctxMenu.style.display = 'block';
      });
    }

    ctxMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.song-editor-ctx-item');
      if (!item || !ctxTarget) return;
      const action = item.dataset.action;
      ctxTarget.focus();
      if (action === 'cut') {
        document.execCommand('cut');
      } else if (action === 'copy') {
        document.execCommand('copy');
      } else if (action === 'paste') {
        try {
          const text = await navigator.clipboard.readText();
          if (ctxTarget.isContentEditable) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              range.insertNode(document.createTextNode(text));
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            } else {
              document.execCommand('insertText', false, text);
            }
          } else {
            const start = ctxTarget.selectionStart;
            const end = ctxTarget.selectionEnd;
            ctxTarget.value = ctxTarget.value.slice(0, start) + text + ctxTarget.value.slice(end);
            ctxTarget.selectionStart = ctxTarget.selectionEnd = start + text.length;
          }
        } catch {
          document.execCommand('paste');
        }
      } else if (action === 'selectall') {
        document.execCommand('selectAll');
      }
      hideCtxMenu();
    });

    document.addEventListener('mousedown', (e) => {
      if (!ctxMenu.contains(e.target)) hideCtxMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideCtxMenu();
    });
  }
  }

  editStylesBtn.addEventListener('click', () => {
    // Simple menu to choose which song style to edit
    const menu = document.createElement('div');
    menu.style.position = 'absolute';
    menu.style.bottom = '60px';
    menu.style.left = '20px';
    menu.style.background = 'white';
    menu.style.border = '1px solid #ccc';
    menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
    menu.style.zIndex = 3000;
    menu.style.padding = '8px';
    menu.innerHTML = `<div style="padding:6px; cursor:pointer;">Edit Song Title Style</div>
                      <div style="padding:6px; cursor:pointer;">Edit Song Text Style</div>
                      <div style="padding:6px; cursor:pointer;">Edit Song Reference Style</div>`;
    document.body.appendChild(menu);

    const removeMenu = () => { if (menu && menu.parentNode) menu.parentNode.removeChild(menu); };

    menu.children[0].addEventListener('click', () => { removeMenu(); showPopover('Song Title', 'songTitle'); });
    menu.children[1].addEventListener('click', () => { removeMenu(); showPopover('Song Text', 'songText'); });
    menu.children[2].addEventListener('click', () => { removeMenu(); showPopover('Song Reference', 'songReference'); });

    // Close the menu on any click outside
    setTimeout(() => document.addEventListener('click', removeMenu, { once: true }), 0);
  });

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeSongEditor();
      }
    });
  }
}

function openSongEditor() {
  const modal = document.getElementById('song-editor-modal');
  const titleInput = document.getElementById('song-editor-title');
  const authorInput = document.getElementById('song-editor-author');
  const lyricsInput = document.getElementById('song-editor-lyrics');
  
  if (modal) {
    // Clear editing flag for new song
    modal.removeAttribute('data-editing-index');
    
    modal.style.display = 'flex';
    if (titleInput) titleInput.value = '';
    if (authorInput) authorInput.value = '';
    const hymnalInput = document.getElementById('song-editor-hymnal');
    const pageInput = document.getElementById('song-editor-page');
    if (hymnalInput) hymnalInput.value = '';
    if (pageInput) pageInput.value = '';
    if (lyricsInput) {
      lyricsInput.textContent = '';
      const previewEl = document.getElementById('song-editor-preview');
      if (previewEl) previewEl.style.display = 'none';
      lyricsInput.focus();
    }
    if (titleInput) titleInput.focus();
  }
}

function closeSongEditor() {
  const modal = document.getElementById('song-editor-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}


function parseMarkdown(text) {
  // simple, safe Markdown for bold and italics
  let t = escapeHtml(text);
  // Bold: **text** or __text__
  t = t.replace(/(\*\*|__)([\s\S]+?)\1/g, '<strong>$2</strong>');
  // Italic: *text* or _text_
  t = t.replace(/(\*|_)([\s\S]+?)\1/g, '<em>$2</em>');
  // Preserve single line breaks as <br>
  t = t.replace(/\n/g, '<br>');
  return t;
}

// Render lyrics plain text into HTML for the contenteditable editor
function renderLyricsHtml(text) {
  const sections = text.split(/\n\n+/).filter(s => s.trim() !== '');
  const parts = sections.map(section => {
    const lines = section.split('\n');
    // detect tag only if the first line is exactly a tag on its own line
    const firstLine = lines[0] ? lines[0].trim() : '';
    const tagMatch = firstLine.match(/^[\[\{\(](.+?)[\]\}\)]$/);
    let html = '';
    if (tagMatch) {
      const label = escapeHtml(tagMatch[1].trim());
      html += `<div class="song-tag">[${label}]</div>`;
      lines.shift(); // remove tag line
    }
    const content = lines.join('\n').trim();
    if (content) {
      html += `<div class="song-section">${parseMarkdown(content)}</div>`;
    }
    return html;
  });
  return parts.join('<div class="song-section-sep"></div>');
}

function updateInlineSongFormatting() {
  // Deprecated: inline replacement caused editing issues. Use updateSongPreview() to render a preview instead.
}

function updateSongPreview() {
  const lyricsDiv = document.getElementById('song-editor-lyrics');
  const previewEl = document.getElementById('song-editor-preview');
  if (!lyricsDiv || !previewEl) return;
  const text = lyricsDiv.innerText || lyricsDiv.textContent || '';
  previewEl.innerHTML = renderLyricsHtml(text);
}
// Render a single verse with optional search highlighting
function renderSongVerse(verseText, query) {
  if (!query || !query.trim()) return parseMarkdown(verseText);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${q})`, 'gi');
  // Use markers that don't contain markdown special characters
  const START = '\u0001START\u0001';
  const END = '\u0001END\u0001';
  const marked = verseText.replace(regex, `${START}$1${END}`);
  // Parse markdown which will escape HTML and convert markdown
  let html = parseMarkdown(marked);
  // Now replace markers with actual span tags (escaped content inside is safe)
  html = html.replace(new RegExp(START, 'g'), '<span class="search-highlight">');
  html = html.replace(new RegExp(END, 'g'), '</span>');
  return html;
}

async function saveSongFromEditor() {
  const modal = document.getElementById('song-editor-modal');
  const editingIndex = modal ? modal.getAttribute('data-editing-index') : null;
  
  const title = document.getElementById('song-editor-title').value.trim();
  const author = document.getElementById('song-editor-author').value.trim();
  const hymnalEl = document.getElementById('song-editor-hymnal');
  const pageEl = document.getElementById('song-editor-page');
  const hymnalVal = hymnalEl ? hymnalEl.value.trim() : '';
  const pageVal = pageEl && pageEl.value ? parseInt(pageEl.value, 10) : null;
  const lyricsDiv = document.getElementById('song-editor-lyrics');
  
  // Use innerText instead of textContent to preserve newlines from contenteditable
  const lyricsText = lyricsDiv ? lyricsDiv.innerText.trim() : '';
  
  if (!title) {
    alert('Please enter a song title');
    return;
  }
  
  if (!lyricsText) {
    alert('Please enter song lyrics');
    return;
  }
  
  // Parse sections from plaintext
  const sectionTexts = lyricsText.split(/\n\n+/).filter(v => v.trim());
  const sections = [];
  let verseCount = 0;
  
  sectionTexts.forEach((text, index) => {
    let sectionLabel = '';
    let sectionContent = text.trim();
    
    // Only treat a top-line that is exactly a tag as a section label
    const lines = sectionContent.split('\n');
    const firstLine = lines[0] ? lines[0].trim() : '';
    const tagLineMatch = firstLine.match(/^[\[\{\(](.+?)[\]\}\)]$/);
    if (tagLineMatch) {
      sectionLabel = tagLineMatch[1].trim();
      lines.shift();
      sectionContent = lines.join('\n').trim();
    } else {
      sectionLabel = 'Verse';
    }

    sections.push({
      section: sectionLabel,
      text: sectionContent
    });
  });
  
  if (sections.length === 0) {
    alert('Please enter song lyrics with at least one section');
    return;
  }
  
  const songData = {
    title,
    author: author || '',
    lyrics: sections
  };
  if (hymnalVal) songData.hymnal = hymnalVal;
  if (pageVal && !isNaN(pageVal)) songData.page = pageVal;
  
  // Check if we're editing or creating new
  if (editingIndex !== null && editingIndex !== '') {
    // Update existing song
    allSongs[parseInt(editingIndex)] = songData;
  } else {
    // Add new song
    allSongs.push(songData);
  }
  
  // Save to file
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const songsPath = path.join(userData, 'songs.json');
    fs.writeFileSync(songsPath, JSON.stringify(allSongs, null, 2), 'utf8');
    
    // Clear editing flag
    if (modal) modal.removeAttribute('data-editing-index');
    
    // Refresh song list
    renderSongList(allSongs);
    populateHymnalFilter();
    closeSongEditor();
    
    // Select the song - use editingIndex if available (editing), otherwise new song (last index)
    const songIndexToSelect = editingIndex !== null && editingIndex !== '' ? parseInt(editingIndex) : allSongs.length - 1;
    selectedSongIndices = [songIndexToSelect];
    displaySelectedSong();
    renderSongList(allSongs);
  } catch (err) {
    console.error('Failed to save song:', err);
    alert('Failed to save song. Check console for details.');
  }
}

// ========== MEDIA MANAGEMENT ==========

async function loadMedia() {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const mediaPath = path.join(userData, 'media.json');
    
    if (fs.existsSync(mediaPath)) {
      const data = fs.readFileSync(mediaPath, 'utf8');
      const mediaData = JSON.parse(data);
      allMedia = mediaData.files || [];
      defaultBackgrounds = mediaData.defaultBackgrounds || { songs: null, verses: null };
    }
    
    renderMediaGrid();
    initMediaHandlers();
  } catch (err) {
    console.error('Failed to load media:', err);
    allMedia = [];
  }
}

async function saveMedia() {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const mediaPath = path.join(userData, 'media.json');
    const mediaData = {
      files: allMedia,
      defaultBackgrounds: defaultBackgrounds
    };
    fs.writeFileSync(mediaPath, JSON.stringify(mediaData, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save media:', err);
  }
}

function initMediaHandlers() {
  const addBtn = document.getElementById('media-add-btn');
  const addMenu = document.getElementById('media-add-context-menu');
  if (addBtn && addMenu) {
    const positionAddMenu = () => {
      const rect = addBtn.getBoundingClientRect();
      const menuWidth = addMenu.offsetWidth || 240;
      const menuHeight = addMenu.offsetHeight || 0;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      let left = rect.left;
      let top = rect.bottom + 4;

      if (left + menuWidth > viewportW - 4) {
        left = rect.right - menuWidth;
      }
      if (left < 4) left = 4;
      if (top + menuHeight > viewportH - 4 && menuHeight > 0) {
        top = Math.max(4, rect.top - menuHeight - 4);
      }

      addMenu.style.left = left + 'px';
      addMenu.style.top = top + 'px';
    };

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = addMenu.style.display !== 'block';
      addMenu.style.display = willOpen ? 'block' : 'none';
      if (willOpen) positionAddMenu();
    });

    window.addEventListener('resize', () => {
      if (addMenu.style.display === 'block') positionAddMenu();
    });

    document.getElementById('media-add-menu-files').addEventListener('click', () => {
      addMenu.style.display = 'none';
      importMediaFiles();
    });
    document.getElementById('media-add-menu-website').addEventListener('click', () => {
      addMenu.style.display = 'none';
      openWebsiteModal();
    });
    document.getElementById('media-add-menu-local-widget').addEventListener('click', () => {
      addMenu.style.display = 'none';
      openLocalWidgetModal();
    });
    document.getElementById('media-add-menu-color').addEventListener('click', () => {
      addMenu.style.display = 'none';
      openColorEditor();
    });
    document.getElementById('media-add-menu-announcement').addEventListener('click', () => {
      addMenu.style.display = 'none';
      openAnnouncementModal();
    });

    document.addEventListener('click', () => { addMenu.style.display = 'none'; });
  }
  
  const searchInput = document.getElementById('media-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', renderMediaGrid);
  }

  // OS drag-and-drop onto the media grid
  const mediaDisplay = document.getElementById('media-display');
  if (mediaDisplay) {
    mediaDisplay.addEventListener('dragenter', (e) => {
      // Only react to OS file drags, not internal item reorders
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        mediaDisplay.classList.add('drag-over');
      }
    });
    mediaDisplay.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    mediaDisplay.addEventListener('dragleave', (e) => {
      // Only remove highlight when leaving the container itself, not a child
      if (!mediaDisplay.contains(e.relatedTarget)) {
        mediaDisplay.classList.remove('drag-over');
      }
    });
    mediaDisplay.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      mediaDisplay.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f =>
        /\.(jpe?g|png|gif|webp|bmp|mp4|webm|ogg|mov|avi)$/i.test(f.name)
      );
      if (files.length > 0) await importFileObjects(files);
    });
  }
  
  // Context menu
  document.addEventListener('click', () => {
    const menu = document.getElementById('media-context-menu');
    if (menu) menu.style.display = 'none';
  });
}

// Shared pipeline: copy an array of File objects into the media library
async function importFileObjects(files) {
  if (!files || files.length === 0) return;
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const mediaDir = path.join(userData, 'media');

    if (!fs.existsSync(mediaDir)) {
      fs.mkdirSync(mediaDir, { recursive: true });
    }

    for (const file of files) {
      // Handle duplicate filenames by appending a counter
      let fileName = file.name;
      let destPath = path.join(mediaDir, fileName);
      if (fs.existsSync(destPath)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          destPath = path.join(mediaDir, `${base}_${counter}${ext}`);
          counter++;
        }
        fileName = path.basename(destPath);
      }

      const buffer = await file.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(buffer));

      const stats = fs.statSync(destPath);
      const fileType = path.extname(fileName).substring(1).toUpperCase();
      allMedia.push({
        name: fileName,
        path: destPath,
        type: fileType,
        size: formatFileSize(stats.size),
        addedDate: new Date().toISOString()
      });
    }

    await saveMedia();
    renderMediaGrid();
  } catch (err) {
    console.error('Failed to import media:', err);
    alert('Failed to import media files');
  }
}

async function importMediaFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*';
  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    await importFileObjects(files);
  };
  input.click();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  else return (bytes / 1048576).toFixed(1) + ' MB';
}

function pathToFileURL(filePath) {
  // delegate to preload-exposed helper (ensures consistent behavior cross-platform)
  if (window && window.paths && typeof window.paths.fileUrlFor === 'function') {
    return window.paths.fileUrlFor(filePath);
  }
  const normalized = filePath.replace(/\\/g, '/');
  return 'file:///' + normalized;
}

// ---------------------------------------------------------------------------
// safePlay(video) — plays a <video> element without triggering Chromium's
// "paused to save power" abort.  Chromium refuses to play detached video
// elements (not in the DOM) when they are "video-only" background media.
// We attach the element to an invisible off-screen container so Chromium
// considers it a real document element, then catch any remaining rejections.
// ---------------------------------------------------------------------------
let _hiddenVideoContainer = null;
function _getHiddenVideoContainer() {
  if (!_hiddenVideoContainer) {
    _hiddenVideoContainer = document.createElement('div');
    _hiddenVideoContainer.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;' +
      'overflow:hidden;pointer-events:none;visibility:hidden;';
    document.body.appendChild(_hiddenVideoContainer);
  }
  return _hiddenVideoContainer;
}
function safePlay(video) {
  // Attach to DOM if not already — prevents the "video-only background media
  // paused to save power" DOMException from Chromium's power-saving heuristic.
  if (!video.parentNode) _getHiddenVideoContainer().appendChild(video);
  return video.play().catch(err => {
    // AbortError from power-saving or rapid stop is expected; everything else log.
    if (err.name !== 'AbortError') console.warn('safePlay error:', err);
  });
}

function renderMediaGrid() {
  const display = document.getElementById('media-display');
  if (!display) return;
  
  const searchInput = document.getElementById('media-search-input');
  const query = searchInput ? searchInput.value.toLowerCase() : '';
  
  const filteredMedia = query ? 
    allMedia.filter(m => m.name.toLowerCase().includes(query)) : 
    allMedia;
  
  let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 12px; padding: 10px;">';
  
  // Always show "Create Color/Gradient" as first item (unless searching)
  if (!query) {
    html += `<div class="media-item media-create-color" data-index="-1" tabindex="0" style="cursor: pointer; border: 1px solid transparent; border-radius: 6px; padding: 6px; text-align: center;">`;
    html += `<div style="width: 100%; height: 60px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center; font-size: 30px; color: white;">
      <svg width="30" height="30" viewBox="0 0 16 16" fill="white"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
    </div>`;
    html += `<div style="font-size: 10px; font-weight: 500; margin-bottom: 3px;">New Color</div>`;
    html += `<div style="font-size: 8px; color: #666;">Create</div>`;
    html += `</div>`;
  }
  
  if (filteredMedia.length === 0 && query) {
    display.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">No media files match your search.</div>';
    return;
  }
  
  filteredMedia.forEach((media, index) => {
    const actualIndex = allMedia.indexOf(media);
    const isImage   = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
    const isVideo   = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
    const isColor   = media.type === 'COLOR';
    const isWebsite = media.type === 'WEBSITE';
    const isObsWidget = media.type === 'OBS_WIDGET';
    const isAnnouncement = media.type === 'ANNOUNCEMENT';
    
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
    html += `<div style="font-size: 8px; color: #666;">${isObsWidget ? (media.kind || 'widget') : isWebsite ? (media.url || 'No URL') : isAnnouncement ? 'Announcement' : `${media.type} \u2022 ${media.size}`}</div>`;
    html += `</div>`;
  });
  
  html += '</div>';

  // Empty state hint (no items added yet, not searching)
  if (allMedia.length === 0 && !query) {
    html += '<div style="padding: 20px; text-align: center; color: #999; font-size: 13px;">No media yet. Click + to add photos, videos, or websites, or use the New Color tile above.</div>';
  }

  display.innerHTML = html;
  
  // Add event listeners
  document.querySelectorAll('.media-item').forEach(item => {
    const index = parseInt(item.getAttribute('data-index'));
    
    // Special handling for create color button
    if (index === -1) {
      item.addEventListener('click', () => {
        openColorEditor();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openColorEditor();
        }
      });
      return; // Skip other handlers for create button
    }
    
    item.addEventListener('click', () => {
      selectedMediaIndex = index;
      const media = allMedia[index];
      console.log('Media item clicked:', media);
      if (media) {
        displayMediaOnPreview(media);
        renderMediaGrid(); // Re-render to show selection
      }
    });
    
    item.addEventListener('dblclick', () => {
      selectedMediaIndex = index;
      const media = allMedia[index];
      if (media) {
        displayMediaOnLive(media);
      }
    });
    
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const media = allMedia[index];
        if (media) {
          displayMediaOnLive(media);
        }
      }
    });
    
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectedMediaIndex = index;
      showMediaContextMenu(e.clientX, e.clientY);
    });
    
    item.addEventListener('dragstart', (e) => {
      const dragData = {
        type: 'media',
        mediaIndex: index
      };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragData));
    });
  });
}

function showMediaContextMenu(x, y) {
  let menu = document.getElementById('media-context-menu');
  
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'media-context-menu';
    menu.innerHTML = `
      <div class="context-menu-item" id="media-context-edit">Edit</div>
      <div class="context-menu-item" id="media-context-bg-songs">Set as Default Background for Songs</div>
      <div class="context-menu-item" id="media-context-bg-verses">Set as Default Background for Verses</div>
      <div class="context-menu-item" id="media-context-reset-songs">Reset Song Background to Default</div>
      <div class="context-menu-item" id="media-context-reset-verses">Reset Verse Background to Default</div>
      <div class="context-menu-item" id="media-context-delete">Delete</div>
    `;
    document.body.appendChild(menu);
    
    // Add Edit handler
    document.getElementById('media-context-edit').addEventListener('click', () => {
      if (selectedMediaIndex !== null) {
        const media = allMedia[selectedMediaIndex];
        const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
        const isVideo = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
        const isColor   = media.type === 'COLOR';
        const isWebsite = media.type === 'WEBSITE';
        const isObsWidget = media.type === 'OBS_WIDGET';
        const isAnnouncement = media.type === 'ANNOUNCEMENT';
        
        if (isImage) {
          if (media.type === 'GIF') {
            openGifEditor(selectedMediaIndex);
          } else {
            openImageEditor(selectedMediaIndex);
          }
        } else if (isVideo) {
          openVideoEditor(selectedMediaIndex);
        } else if (isColor) {
          openColorEditor(selectedMediaIndex);
        } else if (isWebsite) {
          openWebsiteModal(selectedMediaIndex);
        } else if (isObsWidget) {
          openLocalWidgetModal(selectedMediaIndex);
        } else if (isAnnouncement) {
          openAnnouncementModal(selectedMediaIndex);
        }
        menu.style.display = 'none';
      }
    });
    
    // Add handlers
    document.getElementById('media-context-bg-songs').addEventListener('click', async () => {
      if (selectedMediaIndex !== null) {
        // Store index of default background
        defaultBackgrounds.songs = selectedMediaIndex;
        await saveMedia();
        renderMediaGrid();
        menu.style.display = 'none';
      }
    });
    
    document.getElementById('media-context-bg-verses').addEventListener('click', async () => {
      if (selectedMediaIndex !== null) {
        // Store index of default background
        defaultBackgrounds.verses = selectedMediaIndex;
        await saveMedia();
        renderMediaGrid();
        menu.style.display = 'none';
      }
    });
    
    document.getElementById('media-context-reset-songs').addEventListener('click', async () => {
      defaultBackgrounds.songs = null;
      await saveMedia();
      renderMediaGrid();
      menu.style.display = 'none';
    });
    
    document.getElementById('media-context-reset-verses').addEventListener('click', async () => {
      defaultBackgrounds.verses = null;
      await saveMedia();
      renderMediaGrid();
      menu.style.display = 'none';
    });
    
    document.getElementById('media-context-delete').addEventListener('click', async () => {
      if (selectedMediaIndex !== null) {
        const media = allMedia[selectedMediaIndex];
        if (confirm(`Delete "${media.name}"?`)) {
          // Delete file (skip for virtual types like WEBSITE / COLOR that have no path)
          if (media.path) {
            try {
              if (fs.existsSync(media.path)) {
                fs.unlinkSync(media.path);
              }
            } catch (err) {
              console.error('Failed to delete file:', err);
            }
          }
          
          // Remove from list
          allMedia.splice(selectedMediaIndex, 1);
          await saveMedia();
          renderMediaGrid();
        }
        menu.style.display = 'none';
      }
    });
  }
  
  // Position menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = 'block';

  // Hide bg-setting items for WEBSITE media (cannot be used as slide background)
  const _selectedM = selectedMediaIndex !== null ? allMedia[selectedMediaIndex] : null;
  const isWebsiteSelected = _selectedM && (_selectedM.type === 'WEBSITE' || _selectedM.type === 'ANNOUNCEMENT');
  ['media-context-bg-songs', 'media-context-bg-verses', 'media-context-reset-songs', 'media-context-reset-verses'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isWebsiteSelected ? 'none' : '';
  });
  
  // Adjust if off-screen
  setTimeout(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - menuRect.width - 5}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(5, y - menuRect.height)}px`;
    }
  }, 0);
}

let _announcementEditingIndex = null;

function drawAnnouncementToCanvas(ctx, media, w, h) {
  const bgColor   = media.backgroundColor || '#1a1a2e';
  const textColor = media.textColor || '#ffffff';
  const align     = media.align || 'center';
  const title     = media.title   || '';
  const body      = media.body    || '';
  const subtext   = media.subtext || '';

  applyColorToCanvas(ctx, bgColor, w, h);

  const pad    = w * 0.07;
  const textX  = align === 'left' ? pad : align === 'right' ? w - pad : w / 2;
  ctx.textAlign  = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
  ctx.fillStyle  = textColor;

  let y = h * 0.35;

  if (title) {
    const titleSize = Math.round(h * 0.09);
    ctx.font = `bold ${titleSize}px sans-serif`;
    ctx.fillText(title, textX, y);
    y += titleSize * 1.3;
  }

  if (body) {
    const bodySize = Math.round(h * 0.055);
    ctx.font = `${bodySize}px sans-serif`;
    ctx.globalAlpha = 0.9;
    const lines = body.split('\n');
    for (const line of lines) {
      ctx.fillText(line, textX, y);
      y += bodySize * 1.4;
    }
    ctx.globalAlpha = 1;
  }

  if (subtext) {
    const subtextSize = Math.round(h * 0.035);
    ctx.font = `${subtextSize}px sans-serif`;
    ctx.globalAlpha = 0.7;
    ctx.fillText(subtext, textX, y + subtextSize * 0.5);
    ctx.globalAlpha = 1;
  }
}

function updateAnnouncementPreview() {
  const canvas = document.getElementById('announcement-preview-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const media = {
    backgroundColor: document.getElementById('announcement-bg-color').value,
    textColor: document.getElementById('announcement-text-color').value,
    title: document.getElementById('announcement-title-input').value,
    body: document.getElementById('announcement-body-input').value,
    subtext: document.getElementById('announcement-subtext-input').value,
    align: document.getElementById('announcement-align').value
  };
  drawAnnouncementToCanvas(ctx, media, canvas.width, canvas.height);
}

function openAnnouncementModal(mediaIndex = null) {
  _announcementEditingIndex = mediaIndex;
  const modal = document.getElementById('announcement-modal');
  if (!modal) return;

  document.getElementById('announcement-modal-title').textContent = mediaIndex !== null ? 'Edit Announcement' : 'Create Announcement';

  if (mediaIndex !== null) {
    const media = allMedia[mediaIndex];
    document.getElementById('announcement-name-input').value    = media.name    || '';
    document.getElementById('announcement-title-input').value   = media.title   || '';
    document.getElementById('announcement-body-input').value    = media.body    || '';
    document.getElementById('announcement-subtext-input').value = media.subtext || '';
    document.getElementById('announcement-bg-color').value      = media.backgroundColor || '#1a1a2e';
    document.getElementById('announcement-text-color').value    = media.textColor       || '#ffffff';
    document.getElementById('announcement-align').value         = media.align           || 'center';
  } else {
    document.getElementById('announcement-name-input').value    = '';
    document.getElementById('announcement-title-input').value   = '';
    document.getElementById('announcement-body-input').value    = '';
    document.getElementById('announcement-subtext-input').value = '';
    document.getElementById('announcement-bg-color').value      = '#1a1a2e';
    document.getElementById('announcement-text-color').value    = '#ffffff';
    document.getElementById('announcement-align').value         = 'center';
  }

  modal.classList.add('active');
  updateAnnouncementPreview();
}

function closeAnnouncementModal() {
  const modal = document.getElementById('announcement-modal');
  if (modal) modal.classList.remove('active');
  _announcementEditingIndex = null;
}

async function saveAnnouncement() {
  const name    = document.getElementById('announcement-name-input').value.trim()    || 'Announcement';
  const title   = document.getElementById('announcement-title-input').value.trim();
  const body    = document.getElementById('announcement-body-input').value;
  const subtext = document.getElementById('announcement-subtext-input').value.trim();
  const bgColor = document.getElementById('announcement-bg-color').value;
  const txtColor= document.getElementById('announcement-text-color').value;
  const align   = document.getElementById('announcement-align').value;

  const entry = {
    type: 'ANNOUNCEMENT',
    name: name,
    title: title,
    body: body,
    subtext: subtext,
    backgroundColor: bgColor,
    textColor: txtColor,
    align: align
  };

  if (_announcementEditingIndex !== null) {
    allMedia[_announcementEditingIndex] = entry;
  } else {
    allMedia.push(entry);
  }

  await saveMedia();
  renderMediaGrid();
  closeAnnouncementModal();
}

function initAnnouncementModal() {
  const modal   = document.getElementById('announcement-modal');
  if (!modal) return;

  document.getElementById('announcement-modal-close').addEventListener('click',  closeAnnouncementModal);
  document.getElementById('announcement-modal-cancel').addEventListener('click', closeAnnouncementModal);
  document.getElementById('announcement-modal-save').addEventListener('click',   saveAnnouncement);

  modal.addEventListener('click', (e) => { if (e.target === modal) closeAnnouncementModal(); });

  ['announcement-title-input', 'announcement-body-input', 'announcement-subtext-input',
   'announcement-bg-color', 'announcement-text-color', 'announcement-align'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateAnnouncementPreview);
  });
}

function initLowerThird() {
  const popover = document.getElementById('lower-third-popover');
  if (!popover) return;

  const LT_PRESETS = {
    classic: { bgColor: '#000000', bgOpacity: 0.85, textColor: '#ffffff', font: 'Arial',             fontSize: 36, align: 'center', scrollMode: false, transitionIn: 'fade',    transitionOut: 'fade'    },
    news:    { bgColor: '#003580', bgOpacity: 0.95, textColor: '#ffffff', font: 'Impact',             fontSize: 38, align: 'left',   scrollMode: true,  transitionIn: 'slide-up', transitionOut: 'slide-up', scrollDuration: 18 },
    elegant: { bgColor: '#1a1a2e', bgOpacity: 0.90, textColor: '#ffd700', font: 'Georgia',            fontSize: 32, align: 'center', scrollMode: false, transitionIn: 'fade',    transitionOut: 'fade'    },
    light:   { bgColor: '#f5f5f5', bgOpacity: 0.90, textColor: '#111111', font: 'Arial',              fontSize: 36, align: 'center', scrollMode: false, transitionIn: 'fade',    transitionOut: 'fade'    },
    alert:   { bgColor: '#c0392b', bgOpacity: 1.00, textColor: '#ffffff', font: 'Impact',             fontSize: 40, align: 'center', scrollMode: false, transitionIn: 'slide-up', transitionOut: 'slide-up' },
    ghost:   { bgColor: '#000000', bgOpacity: 0.40, textColor: '#ffffff', font: "'Trebuchet MS'",     fontSize: 34, align: 'center', scrollMode: false, transitionIn: 'fade',    transitionOut: 'fade'    }
  };

  let _ltState = {
    text: '',
    visible: false,
    scrollMode: false,
    scrollDuration: 20,
    bgColor: '#000000',
    bgOpacity: 0.85,
    textColor: '#ffffff',
    font: 'Arial',
    fontSize: 36,
    align: 'center',
    transitionIn: 'fade',
    transitionOut: 'fade'
  };
  function _sendAndSave() {
    ipcRenderer.send('update-lower-third', _ltState);
    ipcRenderer.invoke('update-settings', { lowerThird: _ltState }).catch(() => {});
  }

  function _sendWidgetToggle(visible) {
    let activeWidget = window.__activeObsWidget || {};
    if (!activeWidget.url && _rememberedWidget && _rememberedWidget.url) {
      activeWidget = {
        url: _rememberedWidget.url,
        layout: _rememberedWidget.layout || null,
        visible: false,
        transitionOut: _rememberedWidget.transitionOut || 'fade'
      };
      window.__activeObsWidget = activeWidget;
    }
    if (!activeWidget.url) return;
    ipcRenderer.send('update-live-window', {
      isWebsite: true,
      obsWidgetLayout: activeWidget.layout || null,
      obsWidgetUrl: activeWidget.url,
      obsWidgetVisible: !!visible,
      obsWidgetTransitionOut: activeWidget.transitionOut || 'fade'
    });
    activeWidget.visible = !!visible;
    _rememberedWidget = { url: activeWidget.url, layout: activeWidget.layout || null, transitionOut: activeWidget.transitionOut || 'fade' };
    try { ipcRenderer.invoke('update-settings', { lastWidget: _rememberedWidget }).catch(() => {}); } catch (_) {}
    _syncWidgetButtonVisibility();
  }

  function _syncUI(s) {
    const get = id => document.getElementById(id);
    if (get('lt-text')) get('lt-text').value = s.text;
    if (get('lt-bg-color')) get('lt-bg-color').value = s.bgColor;
    if (get('lt-bg-opacity')) {
      const pct = Math.round(s.bgOpacity * 100);
      get('lt-bg-opacity').value = pct;
      if (get('lt-bg-opacity-val')) get('lt-bg-opacity-val').textContent = pct + '%';
    }
    if (get('lt-text-color')) get('lt-text-color').value = s.textColor;
    if (get('lt-font-size')) {
      get('lt-font-size').value = s.fontSize;
      if (get('lt-font-size-val')) get('lt-font-size-val').textContent = s.fontSize + 'px';
    }
    if (get('lt-font')) get('lt-font').value = s.font;
    if (get('lt-toggle-scroll')) {
      get('lt-toggle-scroll').textContent = s.scrollMode ? 'On' : 'Off';
      get('lt-toggle-scroll').classList.toggle('lt-active', s.scrollMode);
    }
    if (get('lt-speed-field')) get('lt-speed-field').style.display = s.scrollMode ? '' : 'none';
    if (get('lt-scroll-speed')) get('lt-scroll-speed').value = s.scrollDuration;
    if (get('lt-transition-in')) get('lt-transition-in').value = s.transitionIn;
    if (get('lt-transition-out')) get('lt-transition-out').value = s.transitionOut;
    popover.querySelectorAll('[data-align]').forEach(b => b.classList.toggle('lt-active', b.dataset.align === s.align));
    if (get('lt-toggle-visible')) {
      get('lt-toggle-visible').textContent = s.visible ? 'Hide' : 'Show';
      get('lt-toggle-visible').classList.toggle('lt-active', s.visible);
    }
  }

  function _openPopover() {
    return;
  }

  function _closePopover() {
    popover.classList.remove('active');
  }

  window.onToggleLowerThird = () => {
    const activeWidget = window.__activeObsWidget || {};
    if (activeWidget.url) {
      _sendWidgetToggle(!activeWidget.visible);
      return;
    }
    if (_rememberedWidget && _rememberedWidget.url) {
      window.__activeObsWidget = {
        url: _rememberedWidget.url,
        layout: _rememberedWidget.layout || null,
        visible: true,
        transitionOut: _rememberedWidget.transitionOut || 'fade'
      };
      _sendWidgetToggle(true);
      return;
    }
    const selected = selectedMediaIndex !== null ? allMedia[selectedMediaIndex] : null;
    if (selected && selected.type === 'OBS_WIDGET') {
      const url = buildLocalWidgetNetworkUrl(selected);
      const layout = normalizeLocalWidgetLayout(selected.kind, selected.layout);
      const transitionOut = selected.params?.transitionOut || 'fade';
      window.__activeObsWidget = { url, layout, visible: true, transitionOut };
      _rememberedWidget = { url, layout, transitionOut };
      _sendWidgetToggle(true);
    }
  };

  document.addEventListener('click', (e) => {
    if (popover.classList.contains('active') && !popover.contains(e.target) && e.target !== document.getElementById('lower-third-btn')) {
      _closePopover();
    }
  });

  popover.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = LT_PRESETS[btn.dataset.preset];
      if (!p) return;
      Object.assign(_ltState, p);
      _syncUI(_ltState);
      popover.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('lt-active', b === btn));
      _sendAndSave();
    });
  });

  popover.querySelectorAll('[data-align]').forEach(btn => {
    btn.addEventListener('click', () => {
      _ltState.align = btn.dataset.align;
      popover.querySelectorAll('[data-align]').forEach(b => b.classList.toggle('lt-active', b === btn));
      _sendAndSave();
    });
  });

  const get = id => document.getElementById(id);

  if (get('lt-text')) get('lt-text').addEventListener('input', () => { _ltState.text = get('lt-text').value; _sendAndSave(); });
  if (get('lt-bg-color')) get('lt-bg-color').addEventListener('input', () => { _ltState.bgColor = get('lt-bg-color').value; _sendAndSave(); });
  if (get('lt-bg-opacity')) get('lt-bg-opacity').addEventListener('input', () => {
    _ltState.bgOpacity = parseInt(get('lt-bg-opacity').value) / 100;
    if (get('lt-bg-opacity-val')) get('lt-bg-opacity-val').textContent = get('lt-bg-opacity').value + '%';
    _sendAndSave();
  });
  if (get('lt-text-color')) get('lt-text-color').addEventListener('input', () => { _ltState.textColor = get('lt-text-color').value; _sendAndSave(); });
  if (get('lt-font-size')) get('lt-font-size').addEventListener('input', () => {
    _ltState.fontSize = parseInt(get('lt-font-size').value);
    if (get('lt-font-size-val')) get('lt-font-size-val').textContent = _ltState.fontSize + 'px';
    _sendAndSave();
  });
  if (get('lt-font')) get('lt-font').addEventListener('change', () => { _ltState.font = get('lt-font').value; _sendAndSave(); });
  if (get('lt-toggle-scroll')) get('lt-toggle-scroll').addEventListener('click', () => {
    _ltState.scrollMode = !_ltState.scrollMode;
    get('lt-toggle-scroll').textContent = _ltState.scrollMode ? 'On' : 'Off';
    get('lt-toggle-scroll').classList.toggle('lt-active', _ltState.scrollMode);
    if (get('lt-speed-field')) get('lt-speed-field').style.display = _ltState.scrollMode ? '' : 'none';
    _sendAndSave();
  });
  if (get('lt-scroll-speed')) get('lt-scroll-speed').addEventListener('change', () => { _ltState.scrollDuration = parseInt(get('lt-scroll-speed').value); _sendAndSave(); });
  if (get('lt-transition-in')) get('lt-transition-in').addEventListener('change', () => { _ltState.transitionIn = get('lt-transition-in').value; _sendAndSave(); });
  if (get('lt-transition-out')) get('lt-transition-out').addEventListener('change', () => { _ltState.transitionOut = get('lt-transition-out').value; _sendAndSave(); });
  if (get('lt-toggle-visible')) get('lt-toggle-visible').addEventListener('click', () => {
    _ltState.visible = !_ltState.visible;
    get('lt-toggle-visible').textContent = _ltState.visible ? 'Hide' : 'Show';
    get('lt-toggle-visible').classList.toggle('lt-active', _ltState.visible);
    _sendAndSave();
  });

  (async () => {
    try {
      const settings = await ipcRenderer.invoke('load-settings');
      if (settings && settings.lowerThird) {
        Object.assign(_ltState, settings.lowerThird);
        _syncUI(_ltState);
      }
      if (settings && settings.lastWidget && settings.lastWidget.url) {
        _rememberedWidget = {
          url: settings.lastWidget.url,
          layout: settings.lastWidget.layout || null,
          transitionOut: settings.lastWidget.transitionOut || 'fade'
        };
      }
      _syncWidgetButtonVisibility();
    } catch (e) {}
  })();
}

function parseSongEditorLyrics(lyricsText) {
  const sectionTexts = String(lyricsText || '').split(/\n\n+/).filter(v => v.trim());
  return sectionTexts.map((text) => {
    let sectionContent = text.trim();
    const lines = sectionContent.split('\n');
    const firstLine = lines[0] ? lines[0].trim() : '';
    const tagLineMatch = firstLine.match(/^[\[\{\(](.+?)[\]\}\)]$/);
    let section = 'Verse';
    if (tagLineMatch) {
      section = tagLineMatch[1].trim();
      lines.shift();
      sectionContent = lines.join('\n').trim();
    }
    return { section, text: sectionContent };
  }).filter((section) => section.text);
}

async function saveRemoteSong(data) {
  const title = String(data && data.title || '').trim();
  const lyricsText = String(data && data.lyrics || '').trim();
  if (!title) throw new Error('A song title is required.');
  if (!lyricsText) throw new Error('Song lyrics are required.');
  if (title.length > 240 || lyricsText.length > 200000) throw new Error('This song is too large.');
  const lyrics = parseSongEditorLyrics(lyricsText);
  if (!lyrics.length) throw new Error('Add at least one lyric section.');

  const songData = { title, author: String(data.author || '').trim(), lyrics };
  const hymnal = String(data.hymnal || '').trim();
  const page = Number.parseInt(data.page, 10);
  if (hymnal) songData.hymnal = hymnal;
  if (Number.isInteger(page) && page > 0) songData.page = page;

  const requestedIndex = Number.isInteger(data.songIndex) ? data.songIndex : null;
  let songIndex;
  if (requestedIndex !== null && requestedIndex >= 0 && requestedIndex < allSongs.length) {
    allSongs[requestedIndex] = songData;
    songIndex = requestedIndex;
  } else {
    allSongs.push(songData);
    songIndex = allSongs.length - 1;
  }
  const userData = await ipcRenderer.invoke('get-user-data-path');
  fs.writeFileSync(path.join(userData, 'songs.json'), JSON.stringify(allSongs, null, 2), 'utf8');
  selectedSongIndices = [songIndex];
  selectedSongVerseIndex = null;
  filteredSongs = [];
  renderSongList(allSongs);
  populateHymnalFilter();
  displaySelectedSong();
  await pushScheduleUpdate();
  return songIndex;
}

async function deleteRemoteSong(songIndex) {
  if (!Number.isInteger(songIndex) || songIndex < 0 || songIndex >= allSongs.length) throw new Error('Song not found.');
  allSongs.splice(songIndex, 1);
  const userData = await ipcRenderer.invoke('get-user-data-path');
  fs.writeFileSync(path.join(userData, 'songs.json'), JSON.stringify(allSongs, null, 2), 'utf8');
  selectedSongIndices = [];
  selectedSongVerseIndex = null;
  filteredSongs = [];
  renderSongList(allSongs);
  populateHymnalFilter();
  displaySelectedSong();
  await pushScheduleUpdate();
}

async function importRemoteSongs(songs) {
  if (!Array.isArray(songs) || songs.length === 0) throw new Error('No songs were found in that file.');
  if (songs.length > 1000) throw new Error('Import up to 1,000 songs at a time.');
  let added = 0;
  for (const rawSong of songs) {
    const title = String(rawSong && rawSong.title || '').trim();
    const lyrics = Array.isArray(rawSong && rawSong.lyrics) ? rawSong.lyrics
      .map((section) => ({ section: String(section && section.section || 'Verse').trim(), text: String(section && section.text || '').trim() }))
      .filter((section) => section.text) : [];
    if (!title || !lyrics.length) continue;
    const duplicate = allSongs.some((song) => String(song.title || '').trim().toLowerCase() === title.toLowerCase() && String(song.author || '').trim().toLowerCase() === String(rawSong.author || '').trim().toLowerCase());
    if (duplicate) continue;
    const song = { title, author: String(rawSong.author || '').trim(), lyrics };
    if (rawSong.hymnal) song.hymnal = String(rawSong.hymnal).trim();
    if (Number.isInteger(Number(rawSong.page)) && Number(rawSong.page) > 0) song.page = Number(rawSong.page);
    allSongs.push(song);
    added++;
  }
  if (!added) throw new Error('No new valid songs were found.');
  const userData = await ipcRenderer.invoke('get-user-data-path');
  fs.writeFileSync(path.join(userData, 'songs.json'), JSON.stringify(allSongs, null, 2), 'utf8');
  renderSongList(allSongs);
  populateHymnalFilter();
  await pushScheduleUpdate();
  return added;
}

function openColorEditor(mediaIndex = null) {
  editingMediaIndex = mediaIndex;
  const modal = document.getElementById('color-editor-modal');
  if (!modal) return;
  
  if (mediaIndex !== null) {
    // Editing existing color item
    const media = allMedia[mediaIndex];
    const colorCSS = media.color;
    
    // Parse the color/gradient to populate form
    if (colorCSS.startsWith('linear-gradient')) {
      document.getElementById('bg-type').value = 'gradient';
      document.getElementById('gradient-type').value = 'linear';
      document.getElementById('solid-color-options').style.display = 'none';
      document.getElementById('gradient-options').style.display = 'block';
      
      const match = colorCSS.match(/linear-gradient\((\d+)deg,\s*([^,]+),\s*(.+)\)/);
      if (match) {
        document.getElementById('gradient-angle').value = match[1];
        document.getElementById('angle-value').textContent = match[1];
        document.getElementById('gradient-color1').value = match[2].trim();
        document.getElementById('gradient-color2').value = match[3].trim();
      }
    } else if (colorCSS.startsWith('radial-gradient')) {
      document.getElementById('bg-type').value = 'gradient';
      document.getElementById('gradient-type').value = 'radial';
      document.getElementById('solid-color-options').style.display = 'none';
      document.getElementById('gradient-options').style.display = 'block';
      
      const match = colorCSS.match(/radial-gradient\(circle,\s*([^,]+),\s*(.+)\)/);
      if (match) {
        document.getElementById('gradient-color1').value = match[1].trim();
        document.getElementById('gradient-color2').value = match[2].trim();
      }
    } else {
      // Solid color
      document.getElementById('bg-type').value = 'solid';
      document.getElementById('solid-color-options').style.display = 'block';
      document.getElementById('gradient-options').style.display = 'none';
      document.getElementById('bg-color').value = colorCSS;
    }
  } else {
    // Creating new color - reset to defaults
    document.getElementById('bg-type').value = 'solid';
    document.getElementById('bg-color').value = '#000000';
    document.getElementById('solid-color-options').style.display = 'block';
    document.getElementById('gradient-options').style.display = 'none';
  }
  
  modal.classList.add('active');
  updateColorPreview();
}

function closeColorEditor() {
  const modal = document.getElementById('color-editor-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

function applyColorToCanvas(ctx, colorCSS, width, height) {
  console.log('applyColorToCanvas called with:', colorCSS, 'size:', width, 'x', height);
  // Check if it's a gradient
  if (colorCSS.startsWith('linear-gradient')) {
    // Parse linear-gradient(135deg, #667eea, #764ba2)
    const match = colorCSS.match(/linear-gradient\((\d+)deg,\s*([^,]+),\s*(.+)\)/);
    console.log('Linear gradient match:', match);
    if (match) {
      const angle = parseInt(match[1]);
      const color1 = match[2].trim();
      const color2 = match[3].trim();
      console.log('Creating linear gradient:', angle, 'deg from', color1, 'to', color2);
      
      // Convert angle to radians and calculate gradient direction
      const angleRad = (angle - 90) * Math.PI / 180;
      const x1 = width / 2 + Math.cos(angleRad) * width / 2;
      const y1 = height / 2 + Math.sin(angleRad) * height / 2;
      const x2 = width / 2 - Math.cos(angleRad) * width / 2;
      const y2 = height / 2 - Math.sin(angleRad) * height / 2;
      
      const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
      gradient.addColorStop(0, color1);
      gradient.addColorStop(1, color2);
      ctx.fillStyle = gradient;
    }
  } else if (colorCSS.startsWith('radial-gradient')) {
    // Parse radial-gradient(circle, #667eea, #764ba2)
    const match = colorCSS.match(/radial-gradient\(circle,\s*([^,]+),\s*(.+)\)/);
    console.log('Radial gradient match:', match);
    if (match) {
      const color1 = match[1].trim();
      const color2 = match[2].trim();
      console.log('Creating radial gradient from', color1, 'to', color2);
      
      const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) / 2);
      gradient.addColorStop(0, color1);
      gradient.addColorStop(1, color2);
      ctx.fillStyle = gradient;
    }
  } else {
    // Solid color
    console.log('Setting solid color:', colorCSS);
    ctx.fillStyle = colorCSS;
  }
  ctx.fillRect(0, 0, width, height);
  console.log('Color/gradient applied to canvas');
}

function drawImageWithSettings(ctx, img, canvasWidth, canvasHeight, settings = {}) {
  const bgSize = settings.bgSize || 'cover';
  const bgRepeat = settings.bgRepeat || 'no-repeat';
  const bgPosition = settings.bgPosition || 'center';
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  
  let drawWidth, drawHeight, scale;
  
  // Calculate dimensions based on background-size
  if (bgSize === 'cover') {
    scale = Math.max(canvasWidth / img.width, canvasHeight / img.height);
    drawWidth = img.width * scale;
    drawHeight = img.height * scale;
  } else if (bgSize === 'contain') {
    scale = Math.min(canvasWidth / img.width, canvasHeight / img.height);
    drawWidth = img.width * scale;
    drawHeight = img.height * scale;
  } else if (bgSize === '100% 100%') {
    drawWidth = canvasWidth;
    drawHeight = canvasHeight;
  } else { // 'auto' - original size
    drawWidth = img.width;
    drawHeight = img.height;
  }
  
  // Calculate position
  let startX = 0, startY = 0;
  if (bgPosition.includes('center') || bgPosition === 'center') {
    startX = (canvasWidth - drawWidth) / 2;
    startY = (canvasHeight - drawHeight) / 2;
  } else {
    const positions = bgPosition.split(' ');
    const posX = positions[0] || 'center';
    const posY = positions[1] || 'center';
    
    if (posX === 'left') startX = 0;
    else if (posX === 'right') startX = canvasWidth - drawWidth;
    else if (posX === 'center') startX = (canvasWidth - drawWidth) / 2;
    
    if (posY === 'top') startY = 0;
    else if (posY === 'bottom') startY = canvasHeight - drawHeight;
    else if (posY === 'center') startY = (canvasHeight - drawHeight) / 2;
  }
  
  // Handle repeat
  if (bgRepeat === 'no-repeat') {
    ctx.drawImage(img, startX, startY, drawWidth, drawHeight);
  } else if (bgRepeat === 'repeat') {
    for (let x = startX % drawWidth - drawWidth; x < canvasWidth; x += drawWidth) {
      for (let y = startY % drawHeight - drawHeight; y < canvasHeight; y += drawHeight) {
        ctx.drawImage(img, x, y, drawWidth, drawHeight);
      }
    }
  } else if (bgRepeat === 'repeat-x') {
    for (let x = startX % drawWidth - drawWidth; x < canvasWidth; x += drawWidth) {
      ctx.drawImage(img, x, startY, drawWidth, drawHeight);
    }
  } else if (bgRepeat === 'repeat-y') {
    for (let y = startY % drawHeight - drawHeight; y < canvasHeight; y += drawHeight) {
      ctx.drawImage(img, startX, y, drawWidth, drawHeight);
    }
  }
}

function updateColorPreview() {
  const preview = document.getElementById('bg-preview');
  if (!preview) return;
  
  const type = document.getElementById('bg-type').value;
  
  if (type === 'solid') {
    const color = document.getElementById('bg-color').value;
    preview.style.background = color;
  } else {
    const gradType = document.getElementById('gradient-type').value;
    const color1 = document.getElementById('gradient-color1').value;
    const color2 = document.getElementById('gradient-color2').value;
    const angle = document.getElementById('gradient-angle').value;
    
    if (gradType === 'linear') {
      preview.style.background = `linear-gradient(${angle}deg, ${color1}, ${color2})`;
    } else {
      preview.style.background = `radial-gradient(circle, ${color1}, ${color2})`;
    }
  }
}

function saveColorBackground() {
  const type = document.getElementById('bg-type').value;
  let colorCSS;
  let name;
  
  if (type === 'solid') {
    const color = document.getElementById('bg-color').value;
    colorCSS = color;
    name = `Solid ${color}`;
  } else {
    const gradType = document.getElementById('gradient-type').value;
    const color1 = document.getElementById('gradient-color1').value;
    const color2 = document.getElementById('gradient-color2').value;
    const angle = document.getElementById('gradient-angle').value;
    
    if (gradType === 'linear') {
      colorCSS = `linear-gradient(${angle}deg, ${color1}, ${color2})`;
      name = `Linear Gradient ${color1}-${color2}`;
    } else {
      colorCSS = `radial-gradient(circle, ${color1}, ${color2})`;
      name = `Radial Gradient ${color1}-${color2}`;
    }
  }
  
  if (editingMediaIndex !== null) {
    // Update existing color item
    const media = allMedia[editingMediaIndex];
    media.color = colorCSS;
    media.name = name;
    
    saveMedia();
    renderMediaGrid();
    
    // Refresh display if this media is currently shown
    if (selectedMediaIndex === editingMediaIndex) {
      displayMediaOnPreview(media);
    }
  } else {
    // Add new color item
    allMedia.push({
      name: name,
      path: null,
      type: 'COLOR',
      color: colorCSS,
      size: '0 B',
      addedDate: new Date().toISOString()
    });
    
    saveMedia();
    renderMediaGrid();
  }
  
  closeColorEditor();
  editingMediaIndex = null;
}

function initColorEditor() {
  const modal = document.getElementById('color-editor-modal');
  if (!modal) return;
  
  document.getElementById('color-editor-close').addEventListener('click', closeColorEditor);
  document.getElementById('color-editor-cancel').addEventListener('click', closeColorEditor);
  document.getElementById('color-editor-save').addEventListener('click', saveColorBackground);
  
  document.getElementById('bg-type').addEventListener('change', (e) => {
    const solidOptions = document.getElementById('solid-color-options');
    const gradientOptions = document.getElementById('gradient-options');
    
    if (e.target.value === 'solid') {
      solidOptions.style.display = 'block';
      gradientOptions.style.display = 'none';
    } else {
      solidOptions.style.display = 'none';
      gradientOptions.style.display = 'block';
    }
    updateColorPreview();
  });
  
  document.getElementById('gradient-type').addEventListener('change', (e) => {
    const angleControl = document.getElementById('linear-angle');
    angleControl.style.display = e.target.value === 'linear' ? 'block' : 'none';
    updateColorPreview();
  });
  
  document.getElementById('bg-color').addEventListener('input', updateColorPreview);
  document.getElementById('gradient-color1').addEventListener('input', updateColorPreview);
  document.getElementById('gradient-color2').addEventListener('input', updateColorPreview);
  document.getElementById('gradient-angle').addEventListener('input', (e) => {
    document.getElementById('angle-value').textContent = e.target.value;
    updateColorPreview();
  });
  
  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeColorEditor();
    }
  });
}

let editingMediaIndex = null;
let imagePreviewImg = null;

function getBackgroundMedia(backgroundIndex) {
  if (backgroundIndex === null || backgroundIndex === undefined) return null;
  if (typeof backgroundIndex === 'number') {
    return allMedia[backgroundIndex] || null;
  }
  // Legacy: if it's a string path, try to find the media
  if (typeof backgroundIndex === 'string') {
    return allMedia.find(m => m.path === backgroundIndex) || null;
  }
  return null;
}

function updateImagePreview() {
  if (editingMediaIndex === null || !imagePreviewImg) return;
  
  const canvas = document.getElementById('image-preview-canvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const bgSize = document.getElementById('image-bg-size').value;
  const bgRepeat = document.getElementById('image-bg-repeat').value;
  const bgPosition = document.getElementById('image-bg-position').value;
  
  drawImageWithSettings(ctx, imagePreviewImg, canvas.width, canvas.height, {
    bgSize: bgSize,
    bgRepeat: bgRepeat,
    bgPosition: bgPosition
  });
}

function openImageEditor(mediaIndex) {
  editingMediaIndex = mediaIndex;
  const media = allMedia[mediaIndex];
  const modal = document.getElementById('image-editor-modal');
  if (!modal) return;
  
  // Load existing settings or defaults
  document.getElementById('image-bg-size').value = media.bgSize || 'cover';
  document.getElementById('image-bg-repeat').value = media.bgRepeat || 'no-repeat';
  document.getElementById('image-bg-position').value = media.bgPosition || 'center';
  
  // Load image for preview
  imagePreviewImg = new Image();
  imagePreviewImg.onload = () => {
    updateImagePreview();
  };
  imagePreviewImg.src = pathToFileURL(media.path);
  
  modal.classList.add('active');
}

function closeImageEditor() {
  const modal = document.getElementById('image-editor-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  editingMediaIndex = null;
  imagePreviewImg = null;
}

let videoPreviewElement = null;
let videoPreviewAnimationId = null;

function updateVideoPreview() {
  if (editingMediaIndex === null || !videoPreviewElement) return;
  
  const canvas = document.getElementById('video-preview-canvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');

  // Cancel previous animation if any
  if (videoPreviewAnimationId) {
    cancelAnimationFrame(videoPreviewAnimationId);
    videoPreviewAnimationId = null;
  }

  const _useRVFC = typeof videoPreviewElement.requestVideoFrameCallback === 'function';

  const drawFrame = () => {
    if (!videoPreviewElement || videoPreviewElement.readyState < 2) {
      if (!_useRVFC) videoPreviewAnimationId = requestAnimationFrame(drawFrame);
      return;
    }
    const objectFit = document.getElementById('video-object-fit') ? document.getElementById('video-object-fit').value : 'contain';
    const width = canvas.width;
    const height = canvas.height;
    let scale, w, h, x, y;
    
    if (objectFit === 'fill') {
      w = width; h = height; x = 0; y = 0;
    } else if (objectFit === 'cover') {
      scale = Math.max(width / videoPreviewElement.videoWidth, height / videoPreviewElement.videoHeight);
      w = videoPreviewElement.videoWidth * scale;
      h = videoPreviewElement.videoHeight * scale;
      x = (width - w) / 2; y = (height - h) / 2;
    } else if (objectFit === 'none') {
      w = videoPreviewElement.videoWidth; h = videoPreviewElement.videoHeight;
      x = (width - w) / 2; y = (height - h) / 2;
    } else {
      scale = Math.min(width / videoPreviewElement.videoWidth, height / videoPreviewElement.videoHeight);
      w = videoPreviewElement.videoWidth * scale;
      h = videoPreviewElement.videoHeight * scale;
      x = (width - w) / 2; y = (height - h) / 2;
    }
    
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(videoPreviewElement, x, y, w, h);

    if (_useRVFC) {
      videoPreviewElement.requestVideoFrameCallback(drawFrame);
    } else {
      videoPreviewAnimationId = requestAnimationFrame(drawFrame);
    }
  };
  
  if (_useRVFC) {
    videoPreviewElement.requestVideoFrameCallback(drawFrame);
  } else {
    drawFrame();
  }
  imagePreviewImg = null;
}

function saveImageSettings() {
  if (editingMediaIndex === null) return;
  
  const media = allMedia[editingMediaIndex];
  media.bgSize = document.getElementById('image-bg-size').value;
  media.bgRepeat = document.getElementById('image-bg-repeat').value;
  media.bgPosition = document.getElementById('image-bg-position').value;
  
  saveMedia();
  closeImageEditor();
  
  // Refresh display if this media is currently shown
  if (selectedMediaIndex === editingMediaIndex) {
    displayMediaOnPreview(media);
  }
}

function openVideoEditor(mediaIndex) {
  editingMediaIndex = mediaIndex;
  const media = allMedia[mediaIndex];
  const modal = document.getElementById('video-editor-modal');
  if (!modal) return;
  
  // Load existing settings or defaults
  document.getElementById('video-object-fit').value = media.objectFit || 'contain';
  document.getElementById('video-repeat-count').value = media.videoRepeat !== undefined ? media.videoRepeat : 0;
  document.getElementById('video-playback-speed').value = media.playbackSpeed !== undefined ? String(media.playbackSpeed) : '1';
  document.getElementById('video-play-audio').checked = media.muted === false; // checked = audio plays (default unchecked = muted)
  
  // Load video for preview
  videoPreviewElement = document.createElement('video');
  videoPreviewElement.src = pathToFileURL(media.path);
  videoPreviewElement.loop = true;
  videoPreviewElement.muted = true;
  safePlay(videoPreviewElement);
  
  // Start preview rendering
  updateVideoPreview();
  
  modal.classList.add('active');
}

function closeVideoEditor() {
  const modal = document.getElementById('video-editor-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  
  // Clean up video preview
  if (videoPreviewElement) {
    videoPreviewElement.pause();
    videoPreviewElement = null;
  }
  if (videoPreviewAnimationId) {
    cancelAnimationFrame(videoPreviewAnimationId);
    videoPreviewAnimationId = null;
  }
  
  editingMediaIndex = null;
}

function saveVideoSettings() {
  if (editingMediaIndex === null) return;
  
  const media = allMedia[editingMediaIndex];
  media.objectFit = document.getElementById('video-object-fit').value;
  media.videoRepeat = parseInt(document.getElementById('video-repeat-count').value, 10) || 0;
  media.playbackSpeed = parseFloat(document.getElementById('video-playback-speed').value) || 1;
  media.muted = !document.getElementById('video-play-audio').checked; // unchecked = muted (default)
  // Derive loop from repeat: 0 = infinite loop, >0 = finite
  media.loop = media.videoRepeat === 0;
  
  saveMedia();
  closeVideoEditor();
  
  // Refresh display if this media is currently shown
  if (selectedMediaIndex === editingMediaIndex) {
    displayMediaOnLive(media);
  }
}

function initImageEditor() {
  const modal = document.getElementById('image-editor-modal');
  if (!modal) return;
  
  document.getElementById('image-editor-close').addEventListener('click', closeImageEditor);
  document.getElementById('image-editor-cancel').addEventListener('click', closeImageEditor);
  document.getElementById('image-editor-save').addEventListener('click', saveImageSettings);
  
  // Update preview on setting changes
  document.getElementById('image-bg-size').addEventListener('change', updateImagePreview);
  document.getElementById('image-bg-repeat').addEventListener('change', updateImagePreview);
  document.getElementById('image-bg-position').addEventListener('change', updateImagePreview);
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeImageEditor();
    }
  });
}

function initVideoEditor() {
  const modal = document.getElementById('video-editor-modal');
  if (!modal) return;
  
  document.getElementById('video-editor-close').addEventListener('click', closeVideoEditor);
  document.getElementById('video-editor-cancel').addEventListener('click', closeVideoEditor);
  document.getElementById('video-editor-save').addEventListener('click', saveVideoSettings);
  
  // Update preview on setting changes
  document.getElementById('video-object-fit').addEventListener('change', updateVideoPreview);
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeVideoEditor();
    }
  });
}

// --- GIF Editor ---

function openGifEditor(mediaIndex) {
  editingMediaIndex = mediaIndex;
  const media = allMedia[mediaIndex];
  const modal = document.getElementById('gif-editor-modal');
  if (!modal) return;

  document.getElementById('gif-bg-size').value = media.bgSize || 'cover';
  document.getElementById('gif-bg-position').value = media.bgPosition || 'center';
  document.getElementById('gif-repeat-count').value = media.gifRepeat !== undefined ? media.gifRepeat : 0;

  const preview = document.getElementById('gif-preview-img');
  if (preview) preview.src = pathToFileURL(media.path);

  modal.classList.add('active');
}

function closeGifEditor() {
  const modal = document.getElementById('gif-editor-modal');
  if (modal) modal.classList.remove('active');
  const preview = document.getElementById('gif-preview-img');
  if (preview) preview.src = '';
  editingMediaIndex = null;
}

function saveGifSettings() {
  if (editingMediaIndex === null) return;
  const savedIndex = editingMediaIndex;
  const media = allMedia[savedIndex];
  media.bgSize = document.getElementById('gif-bg-size').value;
  media.bgPosition = document.getElementById('gif-bg-position').value;
  media.gifRepeat = parseInt(document.getElementById('gif-repeat-count').value, 10) || 0;

  saveMedia();
  closeGifEditor();

  if (selectedMediaIndex === savedIndex) {
    displayMediaOnPreview(media);
    displayMediaOnLive(media);
  }
}

function initGifEditor() {
  const modal = document.getElementById('gif-editor-modal');
  if (!modal) return;
  document.getElementById('gif-editor-close').addEventListener('click', closeGifEditor);
  document.getElementById('gif-editor-cancel').addEventListener('click', closeGifEditor);
  document.getElementById('gif-editor-save').addEventListener('click', saveGifSettings);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeGifEditor(); });
}

// ========== WEBSITE MEDIA TYPE ==========

function openWebsiteModal(mediaIndex = null) {
  editingMediaIndex = mediaIndex;
  const modal = document.getElementById('website-modal');
  if (!modal) return;

  const titleEl = document.getElementById('website-modal-title');
  if (mediaIndex !== null) {
    const media = allMedia[mediaIndex];
    document.getElementById('website-name-input').value = media.name || '';
    document.getElementById('website-url-input').value = media.url || '';
    if (titleEl) titleEl.textContent = 'Edit Website';
  } else {
    document.getElementById('website-name-input').value = '';
    document.getElementById('website-url-input').value = '';
    if (titleEl) titleEl.textContent = 'Add Website';
  }

  modal.classList.add('active');
  document.getElementById('website-url-input').focus();
}

function closeWebsiteModal() {
  const modal = document.getElementById('website-modal');
  if (modal) modal.classList.remove('active');
  editingMediaIndex = null;
}

async function saveWebsiteItem() {
  let name = (document.getElementById('website-name-input').value || '').trim();
  let url  = (document.getElementById('website-url-input').value || '').trim();

  if (!url) {
    alert('Please enter a URL.');
    return;
  }

  // Auto-prepend https:// if missing
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!name) name = url;

  if (editingMediaIndex !== null) {
    const media = allMedia[editingMediaIndex];
    media.name = name;
    media.url  = url;
  } else {
    allMedia.push({ name, url, type: 'WEBSITE', size: '-', addedDate: new Date().toISOString() });
  }

  await saveMedia();
  renderMediaGrid();
  closeWebsiteModal();
}

function initWebsiteModal() {
  const modal = document.getElementById('website-modal');
  if (!modal) return;

  document.getElementById('website-modal-close').addEventListener('click', closeWebsiteModal);
  document.getElementById('website-modal-cancel').addEventListener('click', closeWebsiteModal);
  document.getElementById('website-modal-save').addEventListener('click', saveWebsiteItem);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeWebsiteModal(); });

  document.querySelectorAll('.website-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('website-url-input').value = btn.dataset.url;
      document.getElementById('website-name-input').value = btn.dataset.name;
    });
  });

  document.getElementById('website-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveWebsiteItem();
  });
}

function openLocalWidgetModal(mediaIndex = null) {
  editingMediaIndex = mediaIndex;
  const modal = document.getElementById('local-widget-modal');
  if (!modal) return;
  const titleEl = document.getElementById('local-widget-modal-title');
  if (mediaIndex !== null) {
    const media = allMedia[mediaIndex];
    document.getElementById('local-widget-name-input').value = media.name || '';
    document.getElementById('local-widget-kind-input').value = media.kind || 'timer';
    loadLocalWidgetFields(media);
    loadLocalWidgetLayout(media);
    if (titleEl) titleEl.textContent = 'Edit OBS Widget';
  } else {
    document.getElementById('local-widget-name-input').value = '';
    document.getElementById('local-widget-kind-input').value = 'timer';
    loadLocalWidgetFields({ kind: 'timer' });
    loadLocalWidgetLayout({ kind: 'timer' });
    if (titleEl) titleEl.textContent = 'Add OBS Widget';
  }
  modal.classList.add('active');
  syncLocalWidgetFieldVisibility();
  syncLocalWidgetLayoutEditorVisibility();
}

function closeLocalWidgetModal() {
  const modal = document.getElementById('local-widget-modal');
  if (modal) modal.classList.remove('active');
  editingMediaIndex = null;
}

function buildLocalWidgetUrl(media) {
  return buildLocalWidgetFileUrl(media);
}

function buildLocalWidgetFileUrl(media) {
  if (!media || !media.kind) return '';
  const filePath = {
    timer: path.join(__dirname, 'obs', 'timers', '1', 'index.html'),
    lowerthird: path.join(__dirname, 'obs', 'lowerthirds', '1', 'index.html'),
    alert: path.join(__dirname, 'obs', 'alerts', '1', 'index.html')
  }[media.kind];
  if (!filePath) return '';
  const params = new URLSearchParams(media.params || {});
  const query = params.toString();
  const base = pathToFileURL(filePath).toString();
  return query ? base + '?' + query : base;
}

function buildLocalWidgetNetworkUrl(media) {
  if (!media || !media.kind) return '';
  const relPath = {
    timer: '/obs/timers/1/index.html',
    lowerthird: '/obs/lowerthirds/1/index.html',
    alert: '/obs/alerts/1/index.html'
  }[media.kind];
  if (!relPath) return '';
  const params = new URLSearchParams(media.params || {});
  const query = params.toString();
  return query ? relPath + '?' + query : relPath;
}

function syncLocalWidgetFieldVisibility() {
  const kind = document.getElementById('local-widget-kind-input')?.value || 'timer';
  document.getElementById('local-widget-fields-timer').style.display = kind === 'timer' ? '' : 'none';
  document.getElementById('local-widget-fields-lowerthird').style.display = kind === 'lowerthird' ? '' : 'none';
  document.getElementById('local-widget-fields-alert').style.display = kind === 'alert' ? '' : 'none';
  syncLocalWidgetLayoutEditorVisibility();
  updateLocalWidgetKindPicker(kind);
}

function syncLocalWidgetLayoutEditorVisibility() {
  const kind = document.getElementById('local-widget-kind-input')?.value || 'timer';
  const editor = document.getElementById('local-widget-layout-editor');
  if (editor) editor.style.display = (kind === 'lowerthird' || kind === 'alert') ? '' : 'none';
}

function loadLocalWidgetFields(media) {
  const kind = media.kind || 'timer';
  if (kind === 'timer') {
    document.getElementById('local-widget-timer-seconds').value = media.params?.seconds ?? 60;
    document.getElementById('local-widget-timer-title').value = media.params?.title ?? '';
    document.getElementById('local-widget-timer-subtitle').value = media.params?.subtitle ?? '';
    setChoiceGroupValue('local-widget-timer-transition-out', media.params?.transitionOut ?? 'fade');
  } else if (kind === 'lowerthird') {
    document.getElementById('local-widget-lt-name').value = media.params?.name ?? '';
    document.getElementById('local-widget-lt-title').value = media.params?.title ?? '';
    document.getElementById('local-widget-lt-primary').value = media.params?.primary ?? '#1a1a2e';
    document.getElementById('local-widget-lt-secondary').value = media.params?.secondary ?? '#0f3460';
    document.getElementById('local-widget-lt-accent').value = media.params?.accent ?? '#e94560';
    document.getElementById('local-widget-lt-text').value = media.params?.text ?? '#ffffff';
    document.getElementById('local-widget-lt-textsecondary').value = media.params?.textsecondary ?? '#b8bcc8';
    setChoiceGroupValue('local-widget-lt-animation', media.params?.animation ?? 'slide');
    setChoiceGroupValue('local-widget-lt-theme', media.params?.theme ?? 'default');
    setChoiceGroupValue('local-widget-lt-position', media.params?.position ?? 'bottomleft');
    setChoiceGroupValue('local-widget-lt-style', media.params?.style ?? '1');
    document.getElementById('local-widget-lt-timeout').value = media.params?.timeout ?? '';
    setChoiceGroupValue('local-widget-lt-box-align', media.params?.boxAlign ?? 'center');
    setChoiceGroupValue('local-widget-lt-transition-out', media.params?.transitionOut ?? 'fade');
  } else if (kind === 'alert') {
    document.getElementById('local-widget-alert-title').value = media.params?.title ?? '';
    document.getElementById('local-widget-alert-color').value = media.params?.color ?? '#380848';
    setChoiceGroupValue('local-widget-alert-align', media.params?.boxAlign ?? 'center');
    setChoiceGroupValue('local-widget-alert-transition-out', media.params?.transitionOut ?? 'fade');
  }
  updateLocalWidgetPreview();
}

function getDefaultLocalWidgetLayout(kind) {
  if (kind === 'timer') return { x: 0, y: 0, w: 1, h: 1 };
  if (kind === 'lowerthird') return { x: 0.06, y: 0.74, w: 0.88, h: 0.22 };
  if (kind === 'alert') return { x: 0.18, y: 0.24, w: 0.64, h: 0.28 };
  return { x: 0.5, y: 0.58, w: 0.8, h: 0.28 };
}

function normalizeLocalWidgetLayout(kind, layout) {
  const def = getDefaultLocalWidgetLayout(kind);
  if (kind === 'timer') return def;
  if (!layout || typeof layout !== 'object') return def;
  const x = Number(layout.x);
  const y = Number(layout.y);
  const w = Number(layout.w);
  const h = Number(layout.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return def;
  if (w <= 0.01 || h <= 0.01) return def;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    w: Math.max(0.05, Math.min(1, w)),
    h: Math.max(0.05, Math.min(1, h))
  };
}

function updateLocalWidgetKindPicker(kind) {
  document.querySelectorAll('#local-widget-kind-picker .local-widget-kind-card').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.kind === kind);
  });
}

function setChoiceGroupValue(groupId, value) {
  document.querySelectorAll(`[data-group="${groupId}"] .local-widget-choice`).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function getChoiceGroupValue(groupId) {
  const active = document.querySelector(`[data-group="${groupId}"] .local-widget-choice.active`);
  return active ? active.dataset.value : null;
}

function updateLocalWidgetPreview() {
  const preview = document.getElementById('local-widget-preview-frame');
  if (!preview) return;
  const kind = document.getElementById('local-widget-kind-input')?.value || 'timer';
  const media = { kind, params: {}, layout: getDefaultLocalWidgetLayout(kind) };
  if (kind === 'timer') {
    media.params.seconds = parseInt(document.getElementById('local-widget-timer-seconds').value, 10) || 0;
    media.params.title = document.getElementById('local-widget-timer-title').value.trim();
    media.params.subtitle = document.getElementById('local-widget-timer-subtitle').value.trim();
    media.params.transitionOut = getChoiceGroupValue('local-widget-timer-transition-out') || 'fade';
  } else if (kind === 'lowerthird') {
    media.params.name = document.getElementById('local-widget-lt-name').value.trim();
    media.params.title = document.getElementById('local-widget-lt-title').value.trim();
    media.params.primary = document.getElementById('local-widget-lt-primary').value;
    media.params.secondary = document.getElementById('local-widget-lt-secondary').value;
    media.params.accent = document.getElementById('local-widget-lt-accent').value;
    media.params.text = document.getElementById('local-widget-lt-text').value;
    media.params.textsecondary = document.getElementById('local-widget-lt-textsecondary').value;
    media.params.animation = getChoiceGroupValue('local-widget-lt-animation') || 'slide';
    media.params.theme = getChoiceGroupValue('local-widget-lt-theme') || 'default';
    media.params.position = getChoiceGroupValue('local-widget-lt-position') || 'bottomleft';
    media.params.style = getChoiceGroupValue('local-widget-lt-style') || '1';
    media.params.timeout = document.getElementById('local-widget-lt-timeout').value.trim();
    media.params.boxAlign = getChoiceGroupValue('local-widget-lt-box-align') || 'center';
    media.params.transitionOut = getChoiceGroupValue('local-widget-lt-transition-out') || 'fade';
  } else if (kind === 'alert') {
    media.params.title = document.getElementById('local-widget-alert-title').value.trim();
    media.params.color = document.getElementById('local-widget-alert-color').value;
    media.params.boxAlign = getChoiceGroupValue('local-widget-alert-align') || 'center';
    media.params.transitionOut = getChoiceGroupValue('local-widget-alert-transition-out') || 'fade';
  }
  const url = buildLocalWidgetUrl(media);
  const bust = Date.now().toString(36);
  preview.src = url ? `${url}${url.includes('?') ? '&' : '?'}_cb=${bust}` : 'about:blank';
}

function loadLocalWidgetLayout(media) {
  const kind = media.kind || 'timer';
  const layout = normalizeLocalWidgetLayout(kind, media.layout);
  const shell = document.getElementById('local-widget-preview-shell');
  if (!shell) return;
  shell.style.left = `${layout.x * 100}%`;
  shell.style.top = `${layout.y * 100}%`;
  shell.style.width = `${layout.w * 100}%`;
  shell.style.height = `${layout.h * 100}%`;
  shell.dataset.kind = kind;
}

function resetLocalWidgetLayoutToDefault() {
  const kind = document.getElementById('local-widget-kind-input')?.value || 'timer';
  loadLocalWidgetLayout({ kind });
}

async function saveLocalWidgetItem() {
  let name = (document.getElementById('local-widget-name-input').value || '').trim();
  const kind = (document.getElementById('local-widget-kind-input').value || 'timer').trim();
  if (!name) name = kind;
  const params = {};
  if (kind === 'timer') {
    params.seconds = parseInt(document.getElementById('local-widget-timer-seconds').value, 10) || 0;
    params.title = document.getElementById('local-widget-timer-title').value.trim();
    params.subtitle = document.getElementById('local-widget-timer-subtitle').value.trim();
    params.transitionOut = getChoiceGroupValue('local-widget-timer-transition-out') || 'fade';
  } else if (kind === 'lowerthird') {
    params.name = document.getElementById('local-widget-lt-name').value.trim();
    params.title = document.getElementById('local-widget-lt-title').value.trim();
    params.primary = document.getElementById('local-widget-lt-primary').value;
    params.secondary = document.getElementById('local-widget-lt-secondary').value;
    params.accent = document.getElementById('local-widget-lt-accent').value;
    params.text = document.getElementById('local-widget-lt-text').value;
    params.textsecondary = document.getElementById('local-widget-lt-textsecondary').value;
    params.animation = getChoiceGroupValue('local-widget-lt-animation') || 'slide';
    params.theme = getChoiceGroupValue('local-widget-lt-theme') || 'default';
    params.position = getChoiceGroupValue('local-widget-lt-position') || 'bottomleft';
    params.style = getChoiceGroupValue('local-widget-lt-style') || '1';
    params.timeout = document.getElementById('local-widget-lt-timeout').value.trim();
    params.boxAlign = getChoiceGroupValue('local-widget-lt-box-align') || 'center';
    params.transitionOut = getChoiceGroupValue('local-widget-lt-transition-out') || 'fade';
  } else if (kind === 'alert') {
    params.title = document.getElementById('local-widget-alert-title').value.trim();
    params.color = document.getElementById('local-widget-alert-color').value;
    params.boxAlign = getChoiceGroupValue('local-widget-alert-align') || 'center';
    params.transitionOut = getChoiceGroupValue('local-widget-alert-transition-out') || 'fade';
  }

  const box = document.getElementById('local-widget-preview-shell');
  const stage = document.getElementById('local-widget-layout-stage');
  let layout = getDefaultLocalWidgetLayout(kind);
  if (box && stage) {
    const sr = stage.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const rawW = sr.width ? br.width / sr.width : 0;
    const rawH = sr.height ? br.height / sr.height : 0;
    if (rawW > 0.01 && rawH > 0.01) {
      layout = {
        x: Math.max(0, Math.min(1, (br.left - sr.left) / sr.width)),
        y: Math.max(0, Math.min(1, (br.top - sr.top) / sr.height)),
        w: Math.max(0.05, Math.min(1, rawW)),
        h: Math.max(0.05, Math.min(1, rawH))
      };
    }
  }
  const item = { name, type: 'OBS_WIDGET', kind, params, layout, size: '-', addedDate: new Date().toISOString() };
  if (editingMediaIndex !== null) allMedia[editingMediaIndex] = { ...allMedia[editingMediaIndex], ...item };
  else allMedia.push(item);
  await saveMedia();
  renderMediaGrid();
  closeLocalWidgetModal();
}

function initLocalWidgetModal() {
  const modal = document.getElementById('local-widget-modal');
  if (!modal) return;
  document.getElementById('local-widget-modal-close').addEventListener('click', closeLocalWidgetModal);
  document.getElementById('local-widget-modal-cancel').addEventListener('click', closeLocalWidgetModal);
  document.getElementById('local-widget-modal-save').addEventListener('click', saveLocalWidgetItem);
  document.querySelectorAll('#local-widget-kind-picker .local-widget-kind-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kindInput = document.getElementById('local-widget-kind-input');
      if (!kindInput) return;
      kindInput.value = btn.dataset.kind || 'timer';
      syncLocalWidgetFieldVisibility();
      loadLocalWidgetFields({ kind: kindInput.value });
      loadLocalWidgetLayout({ kind: kindInput.value });
      updateLocalWidgetPreview();
    });
  });
  document.querySelectorAll('.local-widget-choice-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.local-widget-choice');
      if (!btn) return;
      row.querySelectorAll('.local-widget-choice').forEach((b) => b.classList.toggle('active', b === btn));
      updateLocalWidgetPreview();
    });
  });
  const resetBtn = document.getElementById('local-widget-layout-reset');
  if (resetBtn) resetBtn.addEventListener('click', (e) => {
    e.preventDefault();
    resetLocalWidgetLayoutToDefault();
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeLocalWidgetModal(); });
  const kind = document.getElementById('local-widget-kind-input');
  if (kind) kind.addEventListener('change', () => {
    syncLocalWidgetFieldVisibility();
    loadLocalWidgetFields({ kind: kind.value });
    loadLocalWidgetLayout({ kind: kind.value });
    updateLocalWidgetPreview();
  });

  ['local-widget-timer-seconds','local-widget-timer-title','local-widget-timer-subtitle',
   'local-widget-lt-name','local-widget-lt-title','local-widget-lt-primary','local-widget-lt-secondary',
   'local-widget-lt-accent','local-widget-lt-text','local-widget-lt-textsecondary',
   'local-widget-lt-timeout',
   'local-widget-timer-transition-out',
   'local-widget-alert-title','local-widget-alert-color'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateLocalWidgetPreview);
      el.addEventListener('change', updateLocalWidgetPreview);
    }
  });

  const shell = document.getElementById('local-widget-preview-shell');
  const handle = document.getElementById('local-widget-layout-handle');
  const stage = document.getElementById('local-widget-layout-stage');
  let mode = null;
  let start = null;

  const onMove = (e) => {
    if (!mode || !start || !shell || !stage) return;
    const sr = stage.getBoundingClientRect();
    const nx = (e.clientX - sr.left - start.offsetX) / sr.width;
    const ny = (e.clientY - sr.top - start.offsetY) / sr.height;
    if (mode === 'move') {
      const x = Math.max(0, Math.min(1 - start.w, nx));
      const y = Math.max(0, Math.min(1 - start.h, ny));
      shell.style.left = `${x * 100}%`;
      shell.style.top = `${y * 100}%`;
    } else if (mode === 'resize') {
      const w = Math.max(0.05, Math.min(1 - start.x, (e.clientX - sr.left - start.x * sr.width) / sr.width));
      const h = Math.max(0.05, Math.min(1 - start.y, (e.clientY - sr.top - start.y * sr.height) / sr.height));
      shell.style.width = `${w * 100}%`;
      shell.style.height = `${h * 100}%`;
    }
  };

  const onUp = () => {
    if (!mode) return;
    mode = null;
    start = null;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  if (shell) shell.addEventListener('mousedown', (e) => {
    if (e.target === handle) return;
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    const br = shell.getBoundingClientRect();
    mode = 'move';
    start = {
      offsetX: e.clientX - br.left,
      offsetY: e.clientY - br.top,
      x: (br.left - sr.left) / sr.width,
      y: (br.top - sr.top) / sr.height,
      w: br.width / sr.width,
      h: br.height / sr.height
    };
    document.body.style.cursor = 'move';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
  if (handle) handle.addEventListener('mousedown', (e) => {
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    const br = shell.getBoundingClientRect();
    mode = 'resize';
    start = {
      x: (br.left - sr.left) / sr.width,
      y: (br.top - sr.top) / sr.height,
      w: br.width / sr.width,
      h: br.height / sr.height
    };
    document.body.style.cursor = 'nwse-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
    e.stopPropagation();
  });

  updateLocalWidgetPreview();
}

// Draw a placeholder on the preview canvas showing the website name/URL
function drawWebsitePlaceholder(media) {
  const canvas = document.getElementById('preview-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  // Globe icon (simple circle + lines)
  const cx = w / 2, cy = h / 2 - 40;
  const r = Math.min(w, h) * 0.12;
  ctx.strokeStyle = '#0078d4';
  ctx.lineWidth = r * 0.12;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(cx, cy, r * 0.5, r, 0, 0, Math.PI * 2); ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = `bold ${Math.round(r * 0.55)}px Arial`;
  ctx.fillText(media.name || 'Website', cx, cy + r + r * 0.7);

  ctx.fillStyle = '#aaa';
  ctx.font = `${Math.round(r * 0.38)}px Arial`;
  const url = media.url || '';
  const shortUrl = url.length > 40 ? url.substring(0, 37) + '...' : url;
  ctx.fillText(shortUrl, cx, cy + r + r * 1.35);

  ctx.fillStyle = '#555';
  ctx.font = `${Math.round(r * 0.32)}px Arial`;
  ctx.fillText('Double-click to go live', cx, cy + r + r * 1.85);
}

function drawObsWidgetPlaceholder(media) {
  const canvas = document.getElementById('preview-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 72px Arial';
  ctx.fillText((media.kind || 'widget').toUpperCase(), w / 2, h / 2 - 20);
  ctx.font = '28px Arial';
  ctx.fillStyle = '#9fb3c8';
  ctx.fillText(media.name || 'OBS Widget', w / 2, h / 2 + 30);
}

function drawObsWidgetNative(ctx, media, w, h) {
  // HTML rendering is the canonical path for local OBS widgets now.
  // This remains as a no-op so stale call sites do not break.
}

// Website mirror — capturePage polling state
let _mirrorActive = false;
let _mirrorTimer = null;
const WEBSITE_MIRROR_FPS = 24;
const WEBSITE_MIRROR_FRAME_INTERVAL_MS = 1000 / WEBSITE_MIRROR_FPS;
let _websiteVideoFillIndex = null;
let _websiteMirrorCrop = null;

// Preview webview dom-ready tracking (for loading URL into interactive preview)
let _websiteWvReady = false;
let _websiteWvPendingUrl = null;
let _websiteActiveMediaIndex = null; // which allMedia[] index is currently open in the webview

function showWebsiteLivePanel(url) {
  _websiteActiveMediaIndex = selectedMediaIndex; // capture before anything can change it
  const panel = document.getElementById('website-live-panel');
  const wv    = document.getElementById('website-live-webview');  
  if (!panel || !wv) return;

  const urlBar = document.getElementById('website-url-bar');
  if (urlBar) urlBar.value = url;

  // Use visibility toggle — keeps the webview render process alive at all times
  // so loadURL never hits ERR_ABORTED from a suspended renderer
  panel.classList.add('visible');
  scaleWebviewToContainer();

  if (_websiteWvReady) {
    wv.loadURL(url).catch(() => { try { wv.src = url; } catch (_) {} });
  } else {
    _websiteWvPendingUrl = url;
  }
}

function scaleWebviewToContainer() {
  const wv      = document.getElementById('website-live-webview');
  const wrapper = document.querySelector('.website-webview-wrapper');
  if (!wv || !wrapper) return;
  const W = wrapper.clientWidth;
  const H = wrapper.clientHeight;
  if (!W || !H) return;
  const scale  = Math.min(W / 1920, H / 1080);
  const tx     = (W - 1920 * scale) / 2;
  const ty     = (H - 1080 * scale) / 2;
  wv.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

function hideWebsiteLivePanel(stopMirror = false) {
  const panel = document.getElementById('website-live-panel');
  const wv    = document.getElementById('website-live-webview');
  if (panel) panel.classList.remove('visible');
  _websiteActiveMediaIndex = null;
  _websiteIsLive = false;
  _websiteVideoFillIndex = null;
  _websiteMirrorCrop = null;
  const videoFillButton = document.getElementById('website-vid-fullscreen-btn');
  if (videoFillButton) videoFillButton.classList.remove('active');
  // Destroy the page — navigate to blank so video/audio stops completely,
  // just like any other content type when it goes offline.
  if (wv) {
    try { wv.loadURL('about:blank'); } catch (_) { try { wv.src = 'about:blank'; } catch (_2) {} }
    const urlBar = document.getElementById('website-url-bar');
    if (urlBar) urlBar.value = '';
  }
  if (stopMirror) stopWebsiteMirror();
}

// ─── Website mirror — webview.capturePage() polling ──────────────────────────────────────

// Start mirror after the page is ready so the first visible frame is stable.
function startMirrorAfterLoad() {
  const wv = document.getElementById('website-live-webview');
  if (!wv) return;

  let started = false;
  const go = () => { if (started) return; started = true; startWebsiteMirror(); };

  const onLoad = () => { wv.removeEventListener('did-finish-load', onLoad); wv.removeEventListener('did-fail-load', onErr); go(); };
  const onErr  = () => { wv.removeEventListener('did-finish-load', onLoad); wv.removeEventListener('did-fail-load', onErr); go(); };
  wv.addEventListener('did-finish-load', onLoad);
  wv.addEventListener('did-fail-load', onErr);
  setTimeout(go, 8000); // safety fallback
}

// Capture frames directly from the webview's render buffer and send to live windows.
// No desktopCapturer, no WebRTC, no source matching — just asks the webview itself.
function startWebsiteMirror() {
  // Stop the previous polling loop locally without sending website-mirror-stop to the
  // live window — sending stop would flip _mirrorEnabled=false in live.html and block
  // all frames from this new session (since update-content {isWebsite:true} was already
  // processed before this function runs).
  _mirrorActive = false;
  if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }

  const wv = document.getElementById('website-live-webview');
  if (!wv) return;
  _mirrorActive = true;
  const capture = async () => {
    if (!_mirrorActive) return;
    const frameStartedAt = Date.now();
    try {
      // Video fill is output-only: crop the captured live frame without changing
      // the interactive website shown in Liturgia's right-hand preview.
      const crop = _websiteVideoFillIndex !== null && _websiteMirrorCrop
        ? { ..._websiteMirrorCrop }
        : null;
      const img = _websiteVideoFillIndex === null
        ? await wv.capturePage()
        : crop
          ? await wv.capturePage(crop)
          : null;
      if (_mirrorActive && img && img.getSize().width > 0) {
        ipcRenderer.send('mirror-frame', img.toJPEG(75));
      }
    } catch (_) {}
    if (_mirrorActive) {
      const elapsed = Date.now() - frameStartedAt;
      _mirrorTimer = setTimeout(capture, Math.max(0, WEBSITE_MIRROR_FRAME_INTERVAL_MS - elapsed));
    }
  };
  _mirrorTimer = setTimeout(capture, 0);
}

function stopWebsiteMirror() {
  _mirrorActive = false;
  if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
  ipcRenderer.send('website-mirror-stop');
}

// ─────────────────────────────────────────────────────────────────────────────

function initWebsitePanels() {
  const wv = document.getElementById('website-live-webview');
  if (!wv) return;

  // Flush any queued navigation URL; safe to call multiple times (idempotent)
  const _flushPendingUrl = () => {
    _websiteWvReady = true;
    if (_websiteWvPendingUrl) {
      const url = _websiteWvPendingUrl;
      _websiteWvPendingUrl = null;
      wv.loadURL(url).catch(() => { try { wv.src = url; } catch (_) {} });
    }
  };
  wv.addEventListener('dom-ready', _flushPendingUrl);
  // dom-ready fires for about:blank at startup. If initWebsitePanels() ran after that
  // event, _websiteWvReady stays false. Detect readiness by probing getURL().
  try { if (typeof wv.getURL() === 'string') _flushPendingUrl(); } catch (_) {}

  document.getElementById('website-back-btn').addEventListener('click', () => {
    try { if (wv.canGoBack()) wv.goBack(); } catch (_) {}
  });
  document.getElementById('website-forward-btn').addEventListener('click', () => {
    try { if (wv.canGoForward()) wv.goForward(); } catch (_) {}
  });
  document.getElementById('website-reload-btn').addEventListener('click', () => {
    try { wv.reload(); } catch (_) {}
  });

  const urlBar = document.getElementById('website-url-bar');
  const goBtn  = document.getElementById('website-go-btn');

  const navigateTo = () => {
    let url = urlBar.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    urlBar.value = url;
    wv.loadURL(url).catch(() => { try { wv.src = url; } catch (_) {} });
  };

  goBtn.addEventListener('click', navigateTo);
  urlBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateTo(); });

  // Sync URL bar when webview navigates internally
  // capturePage polling picks up page changes automatically — no restart needed
  const onNavigate = (e) => {
    const url = e.url || wv.src;
    if (urlBar && url && url !== 'about:blank') urlBar.value = url;
  };

  try {
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
  } catch (_) {}

  // Set the preload script so requestFullscreen() is blocked inside the webview.
  // This prevents YouTube/other sites from triggering OS-level fullscreen.
  // Our custom button below handles filling the canvas with the page's video.
  try {
    const path = require('path');
    const { pathToFileURL } = require('url');
    wv.setAttribute('preload', pathToFileURL(path.join(__dirname, 'webview-preload.js')).toString());
  } catch (_) {}

  // ── Actions dropdown (Update Thumbnail / Update URL) ──────────────────────────
  const actionsBtn  = document.getElementById('website-actions-btn');
  const actionsDrop = document.getElementById('website-actions-dropdown');

  document.addEventListener('click', (e) => {
    if (actionsDrop && !actionsDrop.contains(e.target) && e.target !== actionsBtn) {
      actionsDrop.style.display = 'none';
    }
  });

  if (actionsBtn) {
    actionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!actionsDrop) return;
      if (actionsDrop.style.display === 'none') {
        actionsDrop.style.display = '';
        positionDropdown(actionsBtn, actionsDrop);
      } else {
        actionsDrop.style.display = 'none';
      }
    });
  }

  const actionThumb = document.getElementById('website-action-thumb');
  if (actionThumb) {
    actionThumb.addEventListener('click', async () => {
      if (actionsDrop) actionsDrop.style.display = 'none';
      const idx = _websiteActiveMediaIndex;
      if (idx === null || !allMedia[idx]) { alert('No website item is currently open.'); return; }
      try {
        const img = await wv.capturePage();
        const jpegBuf = img.toJPEG(80);
        allMedia[idx].thumbnail = 'data:image/jpeg;base64,' + Buffer.from(jpegBuf).toString('base64');
        await saveMedia();
        renderMediaGrid();
      } catch (err) {
        console.error('[actions] capturePage failed', err);
        alert('Could not capture thumbnail: ' + err.message);
      }
    });
  }

  const actionUrl = document.getElementById('website-action-url');
  if (actionUrl) {
    actionUrl.addEventListener('click', async () => {
      if (actionsDrop) actionsDrop.style.display = 'none';
      const idx = _websiteActiveMediaIndex;
      if (idx === null || !allMedia[idx]) { alert('No website item is currently open.'); return; }
      let currentUrl;
      try { currentUrl = wv.getURL(); } catch (_) { currentUrl = ''; }
      if (!currentUrl || currentUrl === 'about:blank') { alert('No URL loaded in the webview yet.'); return; }
      allMedia[idx].url = currentUrl;
      await saveMedia();
      renderMediaGrid();
      // Also update the nav bar display
      const urlBar = document.getElementById('website-url-bar');
      if (urlBar) urlBar.value = currentUrl;
    });
  }
  // Detects video elements on the loaded page and shows a floating button.
  // Video fill crops only the captured output frame; the interactive preview
  // webview remains untouched.
  let _vidList = []; // [{index, w, h, src, paused}]

  const vidWrap  = document.getElementById('website-vid-picker-wrap');
  const vidBtn   = document.getElementById('website-vid-fullscreen-btn');
  const vidBadge = document.getElementById('website-vid-badge');
  const vidDrop  = document.getElementById('website-vid-dropdown');

  // Helper: position a fixed dropdown below its trigger button
  const positionDropdown = (btn, drop) => {
    const r = btn.getBoundingClientRect();
    drop.style.top  = (r.bottom + 4) + 'px';
    // Prefer right-aligned; clamp so it doesn't go off-screen
    const w = drop.offsetWidth || 220;
    let left = r.right - w;
    if (left < 4) left = 4;
    drop.style.left = left + 'px';
    drop.style.right = '';
  };

  document.addEventListener('click', (e) => {
    if (vidDrop && !vidDrop.contains(e.target) && e.target !== vidBtn) {
      vidDrop.style.display = 'none';
    }
  });

  const checkForVideo = () => {
    wv.executeJavaScript(`
      JSON.stringify([...document.querySelectorAll('video')].map((v, i) => ({
        index: i,
        w: v.videoWidth,
        h: v.videoHeight,
        paused: v.paused,
        src: (v.src || v.currentSrc || '').replace(/^blob:.*/, '[blob]').slice(0, 80)
      })))
    `).then(json => {
      const vids = JSON.parse(json).filter(v => v.w > 0 || v.h > 0);
      _vidList = vids;
      if (!vidWrap) return;
      if (vids.length === 0) {
        vidWrap.style.display = 'none';
        return;
      }
      vidWrap.style.display = '';
      if (vidBadge) vidBadge.textContent = vids.length;
      if (_websiteVideoFillIndex !== null) refreshVideoFillCrop(_websiteVideoFillIndex);
    }).catch(() => {
      _vidList = [];
      if (vidWrap) vidWrap.style.display = 'none';
    });
  };

  const buildDropdown = () => {
    if (!vidDrop) return;
    vidDrop.innerHTML = '';
    if (_websiteVideoFillIndex !== null) {
      const exit = document.createElement('div');
      exit.className = 'exit-row';
      exit.textContent = 'X  Exit video fill';
      exit.addEventListener('click', () => { vidDrop.style.display = 'none'; exitVidFill(); });
      vidDrop.appendChild(exit);
    }
    _vidList.forEach(v => {
      const item = document.createElement('div');
      item.className = 'website-vid-dropdown-item';
      const label = document.createElement('span');
      label.className = 'vid-label';
      label.textContent = `Video ${v.index + 1}  ${v.w}\u00d7${v.h}${v.paused ? '' : '  ▶'}`;
      const meta = document.createElement('span');
      meta.className = 'vid-meta';
      meta.textContent = v.src || '(no src)';
      item.appendChild(label);
      item.appendChild(meta);
      item.addEventListener('click', () => {
        vidDrop.style.display = 'none';
        if (_websiteVideoFillIndex !== null) exitVidFill(() => enterVidFill(v.index));
        else enterVidFill(v.index);
      });
      vidDrop.appendChild(item);
    });
  };

  const refreshVideoFillCrop = async (vidIndex) => {
    try {
      const bounds = await wv.executeJavaScript(`
        (function(idx) {
          const all = [...document.querySelectorAll('video')];
          const vid = all[idx] || all.find(v => !v.paused) || all[0];
          if (!vid) return null;
          const r = vid.getBoundingClientRect();
          const x = Math.max(0, Math.floor(r.left));
          const y = Math.max(0, Math.floor(r.top));
          const right = Math.min(window.innerWidth, Math.ceil(r.right));
          const bottom = Math.min(window.innerHeight, Math.ceil(r.bottom));
          if (right - x < 2 || bottom - y < 2) return null;
          return { x, y, width: right - x, height: bottom - y };
        })(${vidIndex})
      `);
      if (_websiteVideoFillIndex === vidIndex) _websiteMirrorCrop = bounds || null;
    } catch (_) {
      if (_websiteVideoFillIndex === vidIndex) _websiteMirrorCrop = null;
    }
  };

  const enterVidFill = (vidIndex) => {
    _websiteVideoFillIndex = vidIndex;
    _websiteMirrorCrop = null;
    if (vidBtn) vidBtn.classList.add('active');
    refreshVideoFillCrop(vidIndex);
  };

  const exitVidFill = (callback) => {
    _websiteVideoFillIndex = null;
    _websiteMirrorCrop = null;
    if (vidBtn) vidBtn.classList.remove('active');
    if (callback) callback();
  };

  if (vidBtn) {
    vidBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!vidDrop) return;
      if (vidDrop.style.display === 'none') {
        buildDropdown();
        vidDrop.style.display = '';
        positionDropdown(vidBtn, vidDrop);
      } else {
        vidDrop.style.display = 'none';
      }
    });
  }

  // Check for video after each page load; reset fill state on navigation
  wv.addEventListener('did-finish-load', () => {
    if (_websiteVideoFillIndex !== null) exitVidFill();
    checkForVideo();
  });
  wv.addEventListener('did-fail-load', checkForVideo);

  // YouTube and other SPAs create <video> elements after page load via JS.
  // Poll every 2 s so the badge updates once the player initialises.
  let _vidPollTimer = null;
  const startVidPoll = () => {
    if (_vidPollTimer) clearInterval(_vidPollTimer);
    _vidPollTimer = setInterval(checkForVideo, 2000);
  };
  wv.addEventListener('did-finish-load', startVidPoll);
  wv.addEventListener('did-navigate', () => {
    if (_websiteVideoFillIndex !== null) exitVidFill();
    startVidPoll();
  });

  // Scale webview to container whenever its wrapper resizes
  const wrapper = document.querySelector('.website-webview-wrapper');
  if (wrapper && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => scaleWebviewToContainer()).observe(wrapper);
  }
}

// ===================================

function displayMediaOnPreview(media) {
  console.log('displayMediaOnPreview called with:', media);

  // Kill any running video draw-loop from a previous video preview.
  // Without this, switching from a video to any other type leaves the rAF loop
  // running and it keeps overwriting the newly-drawn content every frame.
  const _previewCanvas = document.getElementById('preview-canvas');
  if (_previewCanvas) {
    _previewCanvas._currentPreviewVideo = null;
    // Also stop any animated background loop on this canvas
    _previewCanvas._bgToken = (_previewCanvas._bgToken || 0) + 1;
  }

  // WEBSITE: draw placeholder on the LEFT preview canvas only.
  // Never touch the right canvas or the website panel — single-click must never
  // interrupt whatever is currently live.
  if (media.type === 'WEBSITE') {
    drawWebsitePlaceholder(media);
    return;
  }
  if (media.type === 'OBS_WIDGET') {
    drawObsWidgetPlaceholder(media);
    return;
  }

  // For all non-website types: draw to the preview (left) canvas only.
  // Do NOT call hideWebsiteLivePanel here — that hides the overlay on the RIGHT
  // side, revealing the bare live-canvas which was never updated during website
  // mode, making the right canvas appear to clear on every single-click.

  const canvas = document.getElementById('preview-canvas');
  console.log('Preview canvas element:', canvas);
  if (!canvas) {
    console.error('Preview canvas not found!');
    return;
  }
  
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  console.log('Canvas cleared, size:', canvas.width, 'x', canvas.height);
  
  const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
  const isVideo = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
  const isColor = media.type === 'COLOR';
  const isAnnouncement = media.type === 'ANNOUNCEMENT';
  console.log('Media type:', media.type, 'isImage:', isImage, 'isVideo:', isVideo, 'isColor:', isColor);
  
  if (isAnnouncement) {
    drawAnnouncementToCanvas(ctx, media, canvas.width, canvas.height);
  } else if (isColor) {
    applyColorToCanvas(ctx, media.color, canvas.width, canvas.height);
    console.log('Color background drawn to preview canvas');
  } else if (isImage) {
    const img = new Image();
    const fileURL = pathToFileURL(media.path);
    console.log('Loading image from:', fileURL);
    img.onload = () => {
      console.log('Image loaded successfully, dimensions:', img.width, 'x', img.height);
      drawImageWithSettings(ctx, img, canvas.width, canvas.height, {
        bgSize: media.bgSize,
        bgRepeat: media.bgRepeat,
        bgPosition: media.bgPosition
      });
      console.log('Image drawn to preview canvas');
    };
    img.onerror = (e) => {
      console.error('Failed to load image for preview:', media.path, e);
    };
    img.src = fileURL;
  } else if (isVideo) {
    const video = document.createElement('video');
    video.src = pathToFileURL(media.path);
    video.muted = true;
    video.loop = true;
    safePlay(video);

    // Stop guard — prevents ghost loops when clicking multiple video items
    canvas._currentPreviewVideo = video;
    const _useRVFC = typeof video.requestVideoFrameCallback === 'function';
    
    const drawFrame = () => {
      if (canvas._currentPreviewVideo !== video) {
        video.pause();
        if (video.parentNode) video.parentNode.removeChild(video);
        return;
      }
      if (video.readyState >= 2) {
        const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, x, y, w, h);
      }
      if (_useRVFC) {
        video.requestVideoFrameCallback(drawFrame);
      } else {
        requestAnimationFrame(drawFrame);
      }
    };
    if (_useRVFC) {
      video.requestVideoFrameCallback(drawFrame);
    } else {
      drawFrame();
    }
  }
}

// ========== VIDEO LIVE BAR ==========
let _vlbRafId = null;
let _vlbIsScrubbing = false;

function _vlbFormatTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

function _vlbRafUpdate() {
  _vlbRafId = requestAnimationFrame(() => {
    const bar = document.getElementById('video-live-bar');
    if (!bar || !bar.classList.contains('active')) { _vlbRafId = null; return; }

    const video = window._liveVideoElement;
    if (video) {
      const btn = document.getElementById('vlb-play-pause');
      if (btn) {
        const playIcon = document.getElementById('vlb-icon-play');
        const pauseIcon = document.getElementById('vlb-icon-pause');
        if (playIcon) playIcon.style.display = video.paused ? '' : 'none';
        if (pauseIcon) pauseIcon.style.display = video.paused ? 'none' : '';
      }

      const timeEl = document.getElementById('vlb-time');
      if (timeEl) {
        timeEl.textContent = `${_vlbFormatTime(video.currentTime)} / ${_vlbFormatTime(video.duration)}`;
      }

      if (!_vlbIsScrubbing) {
        const scrub = document.getElementById('vlb-scrub');
        if (scrub && video.duration) {
          scrub.value = video.currentTime / video.duration;
        }
      }
    }

    _vlbRafUpdate();
  });
}

async function showVideoLiveBar() {
  const liveCanvas = document.getElementById('live-canvas');
  window._liveVideoElement = liveCanvas ? liveCanvas._currentPreviewVideo : null;
  if (!window._liveVideoElement) return;

  const bar = document.getElementById('video-live-bar');
  if (!bar) return;

  // Reset speed selector to match the video's current rate
  const speedSel = document.getElementById('vlb-speed');
  if (speedSel && window._liveVideoElement) {
    const rate = window._liveVideoElement.playbackRate || 1;
    const opt = speedSel.querySelector(`option[value="${rate}"]`);
    if (opt) speedSel.value = rate;
    else speedSel.value = '1';
  }

  // Populate audio output device popover
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
    const settings = await ipcRenderer.invoke('load-settings');
    const savedDeviceId = (settings && settings.audioOutputDeviceId) || 'default';
    const popover = document.getElementById('vlb-audio-popover');
    if (popover) {
      popover.innerHTML = '<div id="vlb-audio-popover-title">Audio Output</div>';
      const allDevices = [{ deviceId: 'default', label: 'System Default' }, ...audioOutputs.filter(d => d.deviceId !== 'default')];
      allDevices.forEach((d, i) => {
        const item = document.createElement('div');
        item.className = 'vlb-device-item' + (d.deviceId === savedDeviceId ? ' selected' : '');
        item.dataset.deviceId = d.deviceId;
        const check = document.createElement('span');
        check.className = 'vlb-device-check';
        check.textContent = d.deviceId === savedDeviceId ? '\u2713' : '';
        const label = document.createElement('span');
        label.className = 'vlb-device-item-label';
        label.textContent = d.label || `Audio Output ${i + 1}`;
        item.appendChild(check);
        item.appendChild(label);
        popover.appendChild(item);
      });
    }
    // Highlight speaker button if a non-default device is saved
    const audioBtn = document.getElementById('vlb-audio-btn');
    if (audioBtn) audioBtn.classList.toggle('active-device', savedDeviceId !== 'default');
    // Apply saved device to local preview video immediately
    if (window._liveVideoElement && typeof window._liveVideoElement.setSinkId === 'function') {
      window._liveVideoElement.setSinkId(savedDeviceId).catch(() => {});
    }
  } catch (e) { /* ignore audio device query errors */ }

  bar.classList.add('active');
  if (!_vlbRafId) _vlbRafUpdate();
}

function hideVideoLiveBar() {
  window._liveVideoElement = null;
  const bar = document.getElementById('video-live-bar');
  if (bar) bar.classList.remove('active');
}

function initVideoLiveBar() {
  const playPauseBtn = document.getElementById('vlb-play-pause');
  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => {
      const v = window._liveVideoElement;
      if (!v) return;
      if (v.paused) {
        v.play();
        // Don't include currentTime on play — let live window continue from its own position
        ipcRenderer.send('video-live-control', { action: 'sync', paused: false, playbackRate: v.playbackRate });
      } else {
        v.pause();
        // Include currentTime on pause so live window freezes at exact same position
        ipcRenderer.send('video-live-control', { action: 'sync', paused: true, currentTime: v.currentTime, playbackRate: v.playbackRate });
      }
    });
  }

  const scrub = document.getElementById('vlb-scrub');
  if (scrub) {
    scrub.addEventListener('mousedown', () => { _vlbIsScrubbing = true; });
    scrub.addEventListener('input', () => {
      const v = window._liveVideoElement;
      if (!v || !v.duration) return;
      const t = parseFloat(scrub.value) * v.duration;
      v.currentTime = t;
      // Sync full state so live window seeks to same position
      ipcRenderer.send('video-live-control', { action: 'sync', currentTime: t, paused: v.paused, playbackRate: v.playbackRate });
    });
    scrub.addEventListener('mouseup', () => { _vlbIsScrubbing = false; });
    scrub.addEventListener('change', () => { _vlbIsScrubbing = false; });
  }

  const speedSelect = document.getElementById('vlb-speed');
  if (speedSelect) {
    speedSelect.addEventListener('change', () => {
      const v = window._liveVideoElement;
      const rate = parseFloat(speedSelect.value);
      if (v) v.playbackRate = rate;
      // Sync speed only (no currentTime to avoid stutter on rate change)
      ipcRenderer.send('video-live-control', { action: 'sync', playbackRate: rate, paused: v ? v.paused : false });
    });
  }

  const audioBtn = document.getElementById('vlb-audio-btn');
  const audioPopover = document.getElementById('vlb-audio-popover');
  if (audioBtn && audioPopover) {
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audioPopover.classList.toggle('active');
    });
    audioPopover.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = e.target.closest('.vlb-device-item');
      if (!item) return;
      const deviceId = item.dataset.deviceId || 'default';
      // Update checkmarks and selected state
      audioPopover.querySelectorAll('.vlb-device-item').forEach(el => {
        const isThis = el === item;
        el.classList.toggle('selected', isThis);
        const chk = el.querySelector('.vlb-device-check');
        if (chk) chk.textContent = isThis ? '\u2713' : '';
      });
      audioPopover.classList.remove('active');
      // Highlight button when non-default device is chosen
      audioBtn.classList.toggle('active-device', deviceId !== 'default');
      // Apply to local preview video
      if (window._liveVideoElement && typeof window._liveVideoElement.setSinkId === 'function') {
        window._liveVideoElement.setSinkId(deviceId).catch(() => {});
      }
      // Tell live window to route its audio to the same device
      ipcRenderer.send('video-live-control', { action: 'audio-output', deviceId });
      // Persist atomically
      await ipcRenderer.invoke('update-settings', { audioOutputDeviceId: deviceId });
    });
    // Close when clicking anywhere outside the bar
    document.addEventListener('click', () => {
      audioPopover.classList.remove('active');
    });
  }
}

async function displayMediaOnLive(media) {
  // Ensure the live window exists and liveMode is active — same as handleVerseDoubleClick
  if (!liveMode) {
    liveMode = true;
    await ipcRenderer.invoke('create-live-window');
    updateLiveButtonState(true);
  }

  // WEBSITE: show interactive preview webview in right panel + mirror to live window(s)
  if (media.type === 'WEBSITE') {
    _websiteIsLive = true;
    // Exiting clear/black if they were active
    clearMode = false; blackMode = false;
    if (window.clearButton) window.clearButton.classList.remove('active');
    if (window.blackButton) window.blackButton.classList.remove('active');
    showWebsiteLivePanel(media.url);
    // Tell live windows to prepare mirror mode (hide canvases, show video element)
    ipcRenderer.send('update-live-window', { isWebsite: true });
    // Wait for the page to actually render before starting the WebRTC mirror
    startMirrorAfterLoad();
    return;
  }

  if (media.type === 'OBS_WIDGET') {
    _websiteIsLive = false;
    clearMode = false; blackMode = false;
    if (window.clearButton) window.clearButton.classList.remove('active');
    if (window.blackButton) window.blackButton.classList.remove('active');
    const widgetPath = buildLocalWidgetUrl(media);
    const widgetUrl = buildLocalWidgetNetworkUrl(media);
    showWebsiteLivePanel(widgetPath);
    const widgetState = {
      url: widgetUrl,
      path: widgetPath,
      layout: normalizeLocalWidgetLayout(media.kind, media.layout),
      visible: true,
      transitionOut: media.params?.transitionOut || 'fade'
    };
    window.__activeObsWidget = widgetState;
    _rememberedWidget = { url: widgetState.url, layout: widgetState.layout, transitionOut: widgetState.transitionOut };
    try { ipcRenderer.invoke('update-settings', { lastWidget: _rememberedWidget }).catch(() => {}); } catch (_) {}
    _syncWidgetButtonVisibility();
    ipcRenderer.send('update-live-window', {
      isWebsite: true,
      obsWidgetLayout: normalizeLocalWidgetLayout(media.kind, media.layout),
      obsWidgetKind: media.kind || 'timer',
      obsWidgetUrl: widgetUrl,
      obsWidgetPath: widgetPath,
      obsWidgetVisible: true,
      obsWidgetTransitionOut: media.params?.transitionOut || 'fade'
    });
    return;
  }

  // Stop animated background loops on both canvases before starting new media loops
  const _pc = document.getElementById('preview-canvas');
  const _lc = document.getElementById('live-canvas');
  if (_pc) { _pc._currentPreviewVideo = null; _pc._bgToken = (_pc._bgToken || 0) + 1; }
  if (_lc) { _lc._currentPreviewVideo = null; _lc._bgToken = (_lc._bgToken || 0) + 1; }

  // For all non-website types: hide website panel and stop mirror
  // because something non-website is now going live.
  hideWebsiteLivePanel(true);
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  // Set window.currentContent for media type
  window.currentContent = {
    mediaPath: media.path,
    mediaType: media.type,
    mediaColor: media.type === 'ANNOUNCEMENT' ? media.backgroundColor : media.color,
    announcementTitle: media.title,
    announcementBody: media.body,
    announcementSubtext: media.subtext,
    announcementTextColor: media.textColor,
    announcementAlign: media.align,
    width: width,
    height: height,
    isMedia: true
  };
  
  // Send to external live window
  const _liveUpdatePayload = {
    mediaPath: media.path,
    mediaType: media.type,
    mediaColor: media.type === 'ANNOUNCEMENT' ? media.backgroundColor : media.color,
    announcementTitle: media.title,
    announcementBody: media.body,
    announcementSubtext: media.subtext,
    announcementTextColor: media.textColor,
    announcementAlign: media.align,
    bgSize: media.bgSize,
    bgRepeat: media.bgRepeat,
    bgPosition: media.bgPosition,
    objectFit: media.objectFit,
    loop: media.loop,
    muted: media.muted,
    videoRepeat: media.videoRepeat !== undefined ? media.videoRepeat : 0,
    playbackSpeed: media.playbackSpeed || 1,
    gifRepeat: media.gifRepeat !== undefined ? media.gifRepeat : 0,
    transitionIn: transitionSettings['fade-in'],
    transitionOut: transitionSettings['fade-out'],
    isMedia: true
  };
  window._lastLiveUpdateData = _liveUpdatePayload;
  ipcRenderer.send('update-live-window', _liveUpdatePayload);
  
  const previewCanvas = document.getElementById('preview-canvas');
  const liveCanvas = document.getElementById('live-canvas');
  
  const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
  const isVideo = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
  const isColor = media.type === 'COLOR';
  const isAnnouncement = media.type === 'ANNOUNCEMENT';
  
  [previewCanvas, liveCanvas].forEach(canvas => {
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    if (isAnnouncement) {
      drawAnnouncementToCanvas(ctx, media, canvas.width, canvas.height);
    } else if (isColor) {
      // Render color/gradient
      applyColorToCanvas(ctx, media.color, canvas.width, canvas.height);
    } else if (isImage) {
      const img = new Image();
      img.onload = () => {
        drawImageWithSettings(ctx, img, canvas.width, canvas.height, {
          bgSize: media.bgSize,
          bgRepeat: media.bgRepeat,
          bgPosition: media.bgPosition
        });
      };
      img.onerror = (e) => console.error('Failed to load image for live:', media.path, e);
      img.src = pathToFileURL(media.path);
    } else if (isVideo) {
      const video = document.createElement('video');
      video.src = pathToFileURL(media.path);
      video.muted = media.muted !== false; // default true
      video.loop = media.loop !== false; // default true
      safePlay(video);

      // Stop guard: tag the canvas with the current video so stale loops self-terminate
      canvas._currentPreviewVideo = video;
      
      const objectFit = media.objectFit || 'contain';
      const _useRVFC = typeof video.requestVideoFrameCallback === 'function';
      
      const drawFrame = () => {
        if (canvas._currentPreviewVideo !== video) {
          video.pause();
          if (video.parentNode) video.parentNode.removeChild(video);
          return;
        }
        if (video.readyState >= 2) {
          let scale, w, h, x, y;
          
          if (objectFit === 'fill') {
            w = canvas.width;
            h = canvas.height;
            x = 0;
            y = 0;
          } else if (objectFit === 'cover') {
            scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
            w = video.videoWidth * scale;
            h = video.videoHeight * scale;
            x = (canvas.width - w) / 2;
            y = (canvas.height - h) / 2;
          } else if (objectFit === 'none') {
            w = video.videoWidth;
            h = video.videoHeight;
            x = (canvas.width - w) / 2;
            y = (canvas.height - h) / 2;
          } else { // contain (default)
            scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
            w = video.videoWidth * scale;
            h = video.videoHeight * scale;
            x = (canvas.width - w) / 2;
            y = (canvas.height - h) / 2;
          }
          
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, x, y, w, h);
        }
        if (_useRVFC) {
          video.requestVideoFrameCallback(drawFrame);
        } else {
          requestAnimationFrame(drawFrame);
        }
      };
      if (_useRVFC) {
        video.requestVideoFrameCallback(drawFrame);
      } else {
        drawFrame();
      }
    }
  });

  // Show or hide the video live control bar
  if (isVideo) {
    showVideoLiveBar();
  } else {
    hideVideoLiveBar();
  }
}

// ========== TRANSITION SYSTEM ==========

let transitionSettings = {
  'fade-in': { type: 'fade', duration: 0.4 },
  'fade-out': { type: 'fade', duration: 0.4 }
};

// Load transition settings from config
async function loadTransitionSettings() {
  try {
    const settings = await ipcRenderer.invoke('load-settings');
    if (settings && settings.transitions) {
      transitionSettings = { ...transitionSettings, ...settings.transitions };
    }
  } catch (err) {
    console.error('Failed to load transition settings:', err);
  }
}

function setupTransitionButtons() {
  const fadeInBtn = document.getElementById('transition-in-btn');
  const fadeOutBtn = document.getElementById('transition-out-btn');
  
  if (fadeInBtn) {
    fadeInBtn.addEventListener('click', () => openTransitionEditor('fade-in'));
  }
  if (fadeOutBtn) {
    fadeOutBtn.addEventListener('click', () => openTransitionEditor('fade-out'));
  }
}

function openTransitionEditor(transitionType) {
  const modal = document.getElementById('transition-editor-modal');
  const titleEl = document.getElementById('transition-modal-title');
  const durationInput = document.getElementById('transition-duration');
  const typeSelect = document.getElementById('transition-type');
  const previewCanvas = document.getElementById('transition-preview-canvas');
  
  if (!modal) return;
  
  const isIn = transitionType === 'fade-in';
  titleEl.textContent = isIn ? 'Fade In Transition' : 'Fade Out Transition';
  
  const settings = transitionSettings[transitionType];
  durationInput.value = settings.duration;
  typeSelect.value = settings.type;
  
  modal.style.display = 'flex';
  
  // Start preview animation loop
  let animationFrameId = null;
  let startTime = Date.now();
  
  const ctx = previewCanvas.getContext('2d');
  const previewWidth = previewCanvas.width;
  const previewHeight = previewCanvas.height;
  
  const animatePreview = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const duration = parseFloat(durationInput.value) || 1.0;
    const cycleProgress = (elapsed % (duration * 2)) / (duration * 2);
    const isSecondHalf = cycleProgress > 0.5;
    const progress = isSecondHalf ? 2 - (cycleProgress * 2) : cycleProgress * 2;
    
    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, previewWidth, previewHeight);
    
    // Draw sample text with transition based on selected type
    const sampleText = 'Sample Text';
    ctx.font = 'bold 72px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    
    const animType = typeSelect.value;
    
    if (animType === 'fade') {
      // Fade in first half, fade out second half
      if (isSecondHalf) {
        ctx.globalAlpha = 1 - progress;
      } else {
        ctx.globalAlpha = progress;
      }
      ctx.fillText(sampleText, previewWidth / 2, previewHeight / 2);
    } else if (animType === 'slide-left') {
      // Slide in from right to left: start at +width, end at 0
      const xOffset = isSecondHalf ? -previewWidth * (1 - progress) : previewWidth * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2 + xOffset, previewHeight / 2);
    } else if (animType === 'slide-right') {
      // Slide in from left to right: start at -width, end at 0
      const xOffset = isSecondHalf ? previewWidth * (1 - progress) : -previewWidth * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2 + xOffset, previewHeight / 2);
    } else if (animType === 'slide-up') {
      // Slide in from bottom to top: start at +height, end at 0
      const yOffset = isSecondHalf ? -previewHeight * (1 - progress) : previewHeight * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2, previewHeight / 2 + yOffset);
    } else if (animType === 'slide-down') {
      // Slide in from top to bottom: start at -height, end at 0
      const yOffset = isSecondHalf ? previewHeight * (1 - progress) : -previewHeight * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2, previewHeight / 2 + yOffset);
    }
    
    ctx.globalAlpha = 1;
    
    animationFrameId = requestAnimationFrame(animatePreview);
  };
  
  animatePreview();
  
  // Update animation when type or duration changes
  typeSelect.addEventListener('change', () => {
    // Restart animation when type changes
    startTime = Date.now();
  });
  
  durationInput.addEventListener('input', () => {
    // Restart animation when duration changes
    startTime = Date.now();
  });
  
  // Close handler
  const closeHandler = () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    modal.style.display = 'none';
    typeSelect.removeEventListener('change', () => {});
    durationInput.removeEventListener('input', () => {});
  };
  
  const closeBtn = document.getElementById('transition-editor-close');
  const cancelBtn = document.getElementById('transition-editor-cancel');
  const saveBtn = document.getElementById('transition-editor-save');
  
  const cleanup = () => {
    closeBtn.removeEventListener('click', closeHandler);
    cancelBtn.removeEventListener('click', closeHandler);
    saveBtn.removeEventListener('click', saveHandler);
    modal.removeEventListener('click', backdropHandler);
  };
  
  const saveHandler = async () => {
    transitionSettings[transitionType] = {
      type: typeSelect.value,
      duration: parseFloat(durationInput.value) || 1.0
    };
    
    // Save to config
    try {
      const settings = await ipcRenderer.invoke('load-settings') || {};
      const newTransitions = { ...(settings.transitions || {}), [transitionType]: transitionSettings[transitionType] };
      await ipcRenderer.invoke('update-settings', { transitions: newTransitions });
    } catch (err) {
      console.error('Failed to save transition settings:', err);
    }
    
    cleanup();
    closeHandler();
  };
  
  const backdropHandler = (e) => {
    if (e.target === modal) {
      cleanup();
      closeHandler();
    }
  };
  
  closeBtn.addEventListener('click', closeHandler);
  cancelBtn.addEventListener('click', () => {
    cleanup();
    closeHandler();
  });
  saveBtn.addEventListener('click', saveHandler);
  modal.addEventListener('click', backdropHandler);
}

// Initialize transition buttons when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  await loadTransitionSettings();
  setupTransitionButtons();
});

// Remote Control Command Handler
ipcRenderer.on('relay-push-state-request', async () => {
  try {
    await pushBrowserRemoteState();
  } catch (err) {
    console.error('[relay] Failed to push initial state:', err);
  }
});

ipcRenderer.on('remote-command', async (event, { deviceId, deviceName, command, data }) => {
  console.log('[remote] Command from', deviceName, ':', command, data);
  
  try {
    switch (command) {
      case 'REQUEST_STATE':
        try {
          await pushBrowserRemoteState();
        } catch (err) {
          console.error('[relay] Failed to push state on REQUEST_STATE:', err);
        }
        break;

      case 'SELECT_VERSE':
        // Select a verse or verse range and optionally go live
        if (data.book && data.chapter && data.verse) {
          const startVerseKey = `${data.book} ${data.chapter}:${data.verse}`;
          const startIndex = allVerses.findIndex(v => v.key === startVerseKey);
          
          if (startIndex !== -1) {
            // Switch to verses tab if not already there
            if (currentTab !== 'verses') {
              switchTab('verses');
            }
            
            // Handle verse range if verseEnd is provided
            if (data.verseEnd && data.verseEnd > data.verse) {
              const endVerseKey = `${data.book} ${data.chapter}:${data.verseEnd}`;
              const endIndex = allVerses.findIndex(v => v.key === endVerseKey);
              
              if (endIndex !== -1) {
                // Select all verses in the range
                selectedIndices = [];
                for (let i = startIndex; i <= endIndex; i++) {
                  selectedIndices.push(i);
                }
                updateVerseDisplay();
                await updatePreview(selectedIndices);
                
                // Go live with the range
                if (data.goLive) {
                  await handleVerseDoubleClick(selectedIndices);
                }
              } else {
                console.error('[remote] End verse not found:', endVerseKey);
                // Fall back to single verse
                await handleVerseClick(startIndex, null);
                if (data.goLive) {
                  await handleVerseDoubleClick(startIndex);
                }
              }
            } else {
              // Single verse
              await handleVerseClick(startIndex, null);
              if (data.goLive) {
                await handleVerseDoubleClick(startIndex);
              }
            }
            await pushBrowserRemoteState();
          } else {
            console.error('[remote] Verse not found:', startVerseKey);
          }
        }
        break;

      case 'LOOKUP_VERSES': {
        if (!data.book || !data.chapter || !data.verse) break;
        const startKey = `${data.book} ${data.chapter}:${data.verse}`;
        const startIndex = allVerses.findIndex((verse) => verse.key === startKey);
        if (startIndex < 0) break;
        const endVerse = Number(data.verseEnd) >= Number(data.verse) ? Number(data.verseEnd) : Number(data.verse);
        const selected = [];
        for (let verseNumber = Number(data.verse); verseNumber <= endVerse; verseNumber++) {
          const verse = allVerses.find((entry) => entry.key === `${data.book} ${data.chapter}:${verseNumber}`);
          if (verse) selected.push({ verseNumber, text: verse.text || '' });
        }
        const lookup = [{ book: data.book, chapter: Number(data.chapter), startVerse: Number(data.verse), endVerse, length: selected.length, text: selected.map((verse) => `${verse.verseNumber}  ${verse.text}`).join('\n') }];
        const nextState = {
          ...(lastRelayState || {}),
          // A lookup fills the browser's verse list; it must not overwrite the
          // currently-live canvas with the searched reference.
          bible: (lastRelayState && lastRelayState.bible) || [],
          preview: { ...getCurrentPreviewFields(), lookup },
          verseResults: selected.map((verse) => ({ key: `${data.book} ${data.chapter}:${verse.verseNumber}`, text: verse.text })),
          songs: (lastRelayState && lastRelayState.songs) || [],
          scheduling: (lastRelayState && lastRelayState.scheduling) || { totalItems: scheduleItems.length, currentItem: currentLiveScheduleIndex, hasSchedule: scheduleItems.length > 0 },
          allScheduleItems: (lastRelayState && lastRelayState.allScheduleItems) || buildRelayAllScheduleItems(),
          allSongs: (lastRelayState && lastRelayState.allSongs) || allSongs.map((song, idx) => ({ index: idx, title: song.title, author: song.author || '', lyrics: song.lyrics || [] })),
          verseMeta: { verseCounts: dynamicBibleMeta.verseCounts, bookNames: dynamicBibleMeta.bookNames },
          verseRefs: allVerses.map((verse, index) => ({ index, key: verse.key })),
          lastUpdated: Date.now()
        };
        nextState.remoteCanvases = getRemoteCanvasSnapshots();
        lastRelayState = nextState;
        await ipcRenderer.invoke('relay-push-state', nextState);
        break;
      }

      case 'SELECT_SONG':
        // Select a song by index and display it
        if (typeof data.songIndex === 'number') {
          console.log('[remote] Selecting song index:', data.songIndex);
          // Switch to songs tab if not already there
          if (currentTab !== 'songs') {
            switchTab('songs');
          }
          // Select the song
          selectedSongIndices = [data.songIndex];
          selectedSongVerseIndex = 0;
          // Display the song
          displaySelectedSong();
          await updatePreviewFromSongVerse(0);
          // Re-render song list to show selection
          renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
          await pushBrowserRemoteState();
        } else {
          console.warn('[remote] SELECT_SONG missing songIndex:', data);
        }
        break;
        
      case 'SELECT_SONG_VERSE':
        // Select a specific verse within the currently selected song
        if (typeof data.songIndex === 'number' && allSongs[data.songIndex]) {
          selectedSongIndices = [data.songIndex];
        }
        if (typeof data.verseIndex === 'number' && selectedSongIndices.length > 0) {
          console.log('[remote] Selecting song verse index:', data.verseIndex);
          selectedSongVerseIndex = data.verseIndex;
          displaySelectedSong();
          await updatePreviewFromSongVerse(data.verseIndex);
          await pushBrowserRemoteState();
        } else {
          console.warn('[remote] SELECT_SONG_VERSE missing verseIndex or no song selected:', data);
        }
        break;
        
      case 'DISPLAY_SONG_VERSE':
        // Display a specific song verse live without changing desktop selection
        if (typeof data.songIndex === 'number' && typeof data.verseIndex === 'number') {
          console.log('[remote] Displaying song verse live - song:', data.songIndex, 'verse:', data.verseIndex);
          const song = allSongs[data.songIndex];
          if (!song) {
            console.warn('[remote] Song not found at index:', data.songIndex);
            break;
          }
          
          // Get the verse text using same logic as getSongVerseText
          let verseData = null;
          let currentVerseIndex = 0;
          for (const section of song.lyrics) {
            const verses = section.text.split(/\n\n+/);
            for (const verse of verses) {
              if (currentVerseIndex === data.verseIndex) {
                verseData = {
                  title: song.title,
                  section: section.section,
                  text: verse
                };
                break;
              }
              currentVerseIndex++;
            }
            if (verseData) break;
          }
          
          if (!verseData) {
            console.warn('[remote] Verse not found at index:', data.verseIndex);
            break;
          }
          
          // Display it live using proper rendering (like updateLiveFromSongVerse but without changing selection)
          hideVideoLiveBar();
          hideWebsiteLivePanel(true);
          
          const settings = await ipcRenderer.invoke('load-settings');
          const displays = await ipcRenderer.invoke('get-displays');
          const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
          const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
          const width = display ? display.bounds.width : 1920;
          const height = display ? display.bounds.height : 1080;
          
          const liveCanvas = document.getElementById('live-canvas');
          if (liveCanvas) {
            const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
            const styles = getCanvasStylesFor('song');
            window.currentContent = {
              type: 'song',
              number: '',
              text: verseData.text,
              reference: `${verseData.title} - ${verseData.section}`,
              showHint: null,
              width: width,
              height: height,
              backgroundMedia: backgroundMedia,
              styles
            };
            renderToCanvas(liveCanvas, window.currentContent, width, height);
          }
          
          const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
          ipcRenderer.send('update-live-window', {
            number: '',
            text: verseData.text,
            reference: `${verseData.title} - ${verseData.section}`,
            showingCount: 1,
            totalSelected: 1,
            backgroundMedia: backgroundMedia,
            styles: getCanvasStylesFor('song'),
            _displayStyleOverrides: getPerDisplayStyleOverrides('song') || undefined,
            transitionIn: transitionSettings['fade-in'],
            transitionOut: transitionSettings['fade-out']
          });
          
          // Turn on live mode if not already on
          if (!liveMode) {
            toggleLive(true);
          }
        } else {
          console.warn('[remote] DISPLAY_SONG_VERSE missing songIndex or verseIndex:', data);
        }
        break;

      case 'UPSERT_SONG':
        await saveRemoteSong(data || {});
        break;

      case 'DELETE_SONG':
        await deleteRemoteSong(data && data.songIndex);
        break;

      case 'IMPORT_SONGS':
        await importRemoteSongs(data && data.songs);
        break;

      case 'GO_LIVE':
        // Make current selection go live
        if (currentTab === 'verses' && selectedIndices.length > 0) {
          await handleVerseDoubleClick(selectedIndices);
        } else if (currentTab === 'songs' && selectedSongIndices.length > 0 && selectedSongVerseIndex !== null) {
          await handleSongVerseDoubleClick(selectedSongVerseIndex);
        } else if (!liveMode) {
          // No selection but live mode is off - just turn it on
          toggleLive(true);
        }
        break;
        
      case 'CLEAR_LIVE':
        // Toggle clear mode (show background only)
        toggleClear();
        break;
      
      case 'BLACK_SCREEN':
        // Toggle black screen
        toggleBlack();
        break;
        
      case 'NEXT_VERSE':
        // Navigate to next verse
        selectNextVerse();
        break;
        
      case 'PREV_VERSE':
        // Navigate to previous verse
        selectPrevVerse();
        break;
        
      case 'NEXT_SCHEDULE_ITEM':
        // Navigate to next schedule item
        selectNextScheduleItem();
        break;
        
      case 'PREV_SCHEDULE_ITEM':
        // Navigate to previous schedule item
        selectPrevScheduleItem();
        break;
        
      case 'ADD_TO_SCHEDULE':
        // Add verse to schedule from mobile
        if (data && data.book && data.chapter && data.verse) {
          const verseKey = `${data.book} ${data.chapter}:${data.verse}`;
          console.log('[remote] Adding to schedule:', verseKey);
          
          // Find the verse index in allVerses
          const verseIndex = allVerses.findIndex(v => v.key === verseKey);
          if (verseIndex !== -1) {
            // Add to schedule with proper indices structure
            addScheduleItem([verseIndex]);
            console.log('[remote] Added verse to schedule at index:', verseIndex);
          } else {
            console.error('[remote] Verse not found:', verseKey);
          }
        } else {
          console.warn('[remote] ADD_TO_SCHEDULE missing data:', data);
        }
        break;

      case 'ADD_SONG_TO_SCHEDULE':
        if (typeof data.songIndex === 'number' && allSongs[data.songIndex]) {
          addSongToSchedule(data.songIndex);
        } else {
          console.warn('[remote] ADD_SONG_TO_SCHEDULE missing or invalid songIndex:', data);
        }
        break;

      case 'GO_LIVE_SCHEDULE_ITEM':
        if (typeof data.scheduleIndex === 'number') {
          const schedItem = scheduleItems[data.scheduleIndex];
          if (schedItem) {
            if (schedItem.type === 'verses') {
              let verseIdx;
              if (typeof data.subItemIndex === 'number' && schedItem.indices[data.subItemIndex] !== undefined) {
                verseIdx = schedItem.indices[data.subItemIndex];
              } else {
                verseIdx = schedItem.indices;
              }
              if (currentTab !== 'verses') switchTab('verses');
              await handleVerseDoubleClick(verseIdx);
            } else if (schedItem.type === 'song') {
              if (currentTab !== 'songs') switchTab('songs');
              selectedSongIndices = [schedItem.songIndex];
              selectedSongVerseIndex = typeof data.subItemIndex === 'number' ? data.subItemIndex : 0;
              if (!liveMode) await toggleLive(true);
              await updateLiveFromSongVerse(selectedSongVerseIndex);
            }
          }
        }
        break;

      case 'REORDER_SCHEDULE':
        if (typeof data.from === 'number' && typeof data.to === 'number' &&
            data.from >= 0 && data.to >= 0 &&
            data.from < scheduleItems.length && data.to < scheduleItems.length &&
            data.from !== data.to) {
          const moved = scheduleItems.splice(data.from, 1)[0];
          scheduleItems.splice(data.to, 0, moved);
          renderSchedule();
          saveScheduleToSettings();
        }
        break;

      case 'DELETE_SCHEDULE_ITEM':
        if (typeof data.scheduleIndex === 'number' && data.scheduleIndex >= 0 && data.scheduleIndex < scheduleItems.length) {
          deleteScheduleItem(data.scheduleIndex);
        }
        break;

      case 'CLEAR_SCHEDULE':
        if (scheduleItems.length) {
          scheduleItems = [];
          currentLiveScheduleIndex = null;
          selectedScheduleItems = [];
          renderSchedule();
          saveScheduleToSettings();
        }
        break;

      case 'SET_BIBLE_TRANSLATION':
        if (data && typeof data.bible === 'string' && data.bible.trim()) {
          ipcRenderer.send('set-default-bible', data.bible.trim());
        }
        break;

      case 'OPEN_SETTINGS':
        ipcRenderer.send('remote-open-settings');
        break;

      case 'TOGGLE_WIDGET':
        if (typeof window.onToggleLowerThird === 'function') window.onToggleLowerThird();
        break;

      case 'UPDATE_STYLES':
        if (data && data.previewStyles && typeof data.previewStyles === 'object') {
          previewStyles = { ...data.previewStyles };
          await ipcRenderer.invoke('update-settings', { previewStyles });
          applyPreviewStyles();
          rerenderPreviewForStyles();
          lastRelayState = { ...(lastRelayState || {}), previewStyles: { ...previewStyles }, remoteCanvases: getRemoteCanvasSnapshots(), lastUpdated: Date.now() };
          await ipcRenderer.invoke('relay-push-state', lastRelayState);
        }
        break;

      case 'OPEN_STYLE_EDITOR':
        openTextStyleModal();
        break;

    }
  } catch (e) {
    console.error('[remote] Error handling command:', e);
  }
});

// Export test hooks for unit tests (if running under Node)
if (typeof module !== 'undefined' && module.exports) {
  module.exports._renderMediaGrid = renderMediaGrid;
  module.exports._setAllMedia = (m) => { allMedia = m; };
  module.exports._setDefaultBackgrounds = (d) => { defaultBackgrounds = d; };
}



