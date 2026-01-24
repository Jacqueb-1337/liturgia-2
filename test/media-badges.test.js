// @jest-environment jsdom

// Mock electron before requiring renderer.js
jest.mock('electron', () => ({
  ipcRenderer: { on: () => {}, invoke: async () => ({}) },
  shell: { openExternal: () => {} }
}));

const fs = require('fs');
const path = require('path');

describe('media badges', () => {
  let renderer;

  beforeEach(() => {
    // Ensure DOM container exists
    document.body.innerHTML = '<div id="media-display"></div><input id="media-search-input" value="" />';
    // Clear require cache and re-require renderer to get fresh state
    jest.resetModules();
    renderer = require('../renderer.js');
  });

  test('no badges when defaults not set', () => {
    const sample = [ { name: 'img1', type: 'PNG', path: '/tmp/img1.png', size: '10KB' } ];
    renderer._setAllMedia(sample);
    renderer._setDefaultBackgrounds({ songs: null, verses: null });

    renderer._renderMediaGrid();
    const html = document.getElementById('media-display').innerHTML;
    expect(html).toContain('img1');
    expect(html).not.toContain('fa-badge');
  });

  test('shows song badge when songs default set', () => {
    const sample = [ { name: 'img1', type: 'PNG', path: '/tmp/img1.png', size: '10KB' } ];
    renderer._setAllMedia(sample);
    renderer._setDefaultBackgrounds({ songs: 0, verses: null });

    renderer._renderMediaGrid();
    const html = document.getElementById('media-display').innerHTML;
    expect(html).toContain('fa-badge fa-bottom-right');
    expect(html).toContain('title="Default background for songs"');

    // Debug: print HTML to help diagnose DOM structure
    console.log('\n--- RENDERED HTML ---\n', html, '\n--- END HTML ---\n');

    // Ensure badge is inside the thumbnail and label remains outside
    const item = document.querySelector('.media-item[data-index="0"]');
    expect(item).not.toBeNull();
    console.log('ITEM INNERHTML:\n', item.innerHTML);
    const thumb = item && item.querySelector('.media-thumb');
    console.log('thumb found?', !!thumb, thumb);
    expect(thumb).not.toBeNull();
    expect(thumb.querySelector('.fa-bottom-right')).not.toBeNull();
    expect(thumb.nextElementSibling && thumb.nextElementSibling.textContent).toContain('img1');
  });

  test('shows verse badge when verses default set', () => {
    const sample = [ { name: 'img1', type: 'PNG', path: '/tmp/img1.png', size: '10KB' } ];
    renderer._setAllMedia(sample);
    renderer._setDefaultBackgrounds({ songs: null, verses: 0 });

    renderer._renderMediaGrid();
    const html = document.getElementById('media-display').innerHTML;
    expect(html).toContain('fa-badge fa-bottom-left');
    expect(html).toContain('title="Default background for verses"');
    // Debug output for failing case
    console.log('\n--- VERSE RENDERED HTML ---\n', html, '\n--- END HTML ---\n');
    const item = document.querySelector('.media-item[data-index="0"]');
    expect(item).not.toBeNull();
    console.log('ITEM INNERHTML (verse):\n', item.innerHTML);
    console.log('querySelector .media-thumb =>', item.querySelector('.media-thumb'));
    const thumb = item && item.querySelector('.media-thumb');
    console.log('thumb found?', !!thumb, thumb);
    expect(thumb).not.toBeNull();
    expect(thumb.querySelector('.fa-bottom-left')).not.toBeNull();
    expect(thumb.nextElementSibling && thumb.nextElementSibling.textContent).toContain('img1');
  });

  test('shows both badges when both defaults point to same index', () => {
    const sample = [ { name: 'img1', type: 'PNG', path: '/tmp/img1.png', size: '10KB' } ];
    renderer._setAllMedia(sample);
    renderer._setDefaultBackgrounds({ songs: 0, verses: 0 });

    renderer._renderMediaGrid();
    const html = document.getElementById('media-display').innerHTML;
    expect((html.match(/fa-badge/g) || []).length).toBe(2);
    expect(html).toContain('title="Default background for songs"');
    expect(html).toContain('title="Default background for verses"');

    const item = document.querySelector('.media-item[data-index="0"]');
    expect(item).not.toBeNull();
    const thumb = item && item.querySelector('.media-thumb');
    expect(thumb).not.toBeNull();
    expect(thumb.querySelectorAll('.fa-badge').length).toBe(2);
    expect(thumb.nextElementSibling && thumb.nextElementSibling.textContent).toContain('img1');
  });
});