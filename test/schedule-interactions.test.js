const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('schedule interaction safeguards', () => {
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
});
