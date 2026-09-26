const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('schedule and song interaction safeguards', () => {
  test('uses the app confirmation dialog instead of native confirm for schedule actions', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

    expect(renderer).toContain('function showAppConfirm(');
    expect(renderer).toContain("await showAppConfirm('Remove all items from the schedule?'");
    expect(renderer).not.toContain("confirm('Remove all items from the schedule?')");
    expect(renderer).toContain('const canRestoreScheduleFocus =');
  });

  test('provides a large draggable schedule header with visible insertion feedback', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

    expect(renderer).toContain("header.setAttribute('draggable', 'true')");
    expect(renderer).toContain("dragHandle.className = 'schedule-drag-handle'");
    expect(renderer).toContain("'schedule-drop-before'");
    expect(renderer).toContain("'schedule-drop-after'");
    expect(renderer).toContain("const dropPosition = e.clientY >= rect.top + (rect.height / 2) ? 'after' : 'before'");

    expect(css).toContain('.schedule-drag-handle');
    expect(css).toContain('.schedule-item.schedule-drop-before::before');
    expect(css).toContain('.schedule-item.schedule-drop-after::after');
  });

  test('keeps keyboard song navigation visible and maps numbered sections to flattened verse indices', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

    expect(renderer).toContain('function scrollSelectedSongVerseIntoView()');
    expect(renderer).toContain("selectedVerse.scrollIntoView({");
    expect(renderer).toContain('requestAnimationFrame(scrollSelectedSongVerseIntoView);');
    expect(renderer).toContain('verseSections.push(flattenedIndex);');
    expect(renderer).toContain('chorusSections.push(flattenedIndex);');
    expect(renderer).toContain("flattenedIndex += section.text.split(/\\n\\n+/).length;");
  });

  test('schedule Bible verse clicks sync the Bible list and search reference', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

    expect(renderer).toContain('const clickedVerseIndex = item.indices[verseIndexInGroup];');
    expect(renderer).toContain('anchorIndex = clickedVerseIndex;');
    expect(renderer).toContain('verseListContainer.scrollTop = Math.max(0, clickedVerseIndex * ITEM_HEIGHT - 80);');
    expect(renderer).toContain('updateSearchBoxForVerse(clickedVerseIndex);');
    expect(renderer).toContain('updateSearchBoxForVerse(item.indices[0]);');
  });
  test('schedule focus does not block global presentation shortcuts', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

    expect(renderer).not.toContain("if (active && (active.closest('.schedule-item-header') || (active.closest('.schedule-verse-item') && !isSongScheduleVerse))) return;");
    expect(renderer).toContain('must not disable global presentation shortcuts such as Clear or Black');
  });
});
