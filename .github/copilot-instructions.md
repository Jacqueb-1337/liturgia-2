# GitHub Copilot Instructions for Liturgia

## General Guidelines

### Dark Mode Support (CRITICAL)
**ALWAYS ensure dark mode compatibility when adding new UI elements:**

1. **Never use inline styles for colors, backgrounds, or borders**
   - Use CSS classes instead of `style="background: #fff"` or similar
   - Inline styles override CSS and break dark mode theming

2. **CSS Structure for Dark Mode**
   ```css
   /* Light mode (default) */
   .my-element {
     background: #fff;
     color: #000;
     border: 1px solid #ccc;
   }
   
   /* Dark mode */
   body.dark-theme .my-element {
     background: #2a2a2a;
     color: #eee;
     border: 1px solid #444;
   }
   ```

3. **Common Dark Mode Color Palette**
   - Background: `#2a2a2a` or `#23272a`
   - Text: `#eee`
   - Borders: `#444`
   - Hover background: `#333`
   - Muted text: `#999` or `#aaa`

4. **Elements Requiring Dark Mode**
   - All backgrounds (divs, modals, panels)
   - All text colors
   - All borders
   - All buttons and interactive elements
   - All form inputs
   - All context menus and dropdowns
   - All tooltips and popovers

### Code Quality

1. **File Structure**
   - HTML: `index.html`, `settings.html`, `live.html`
   - CSS: `style.css` (all styles in one file)
   - JavaScript: `renderer.js`, `main.js`, `settings.js`
   - Data: `bible.json`, `songs.json`, `scheduleItems.json`

2. **Naming Conventions**
   - Use camelCase for JavaScript variables and functions
   - Use kebab-case for CSS classes and IDs
   - Use descriptive names (e.g., `handleSongClick` not `hsc`)

3. **Consistency**
   - Match existing code style and patterns
   - Use existing utility functions when available
   - Follow established patterns for similar features

### Feature Implementation

1. **Context Menus**
   - Always implement both Edit and Delete for multi-select compatibility
   - Right-click should auto-select if item not already selected
   - Show/hide options based on selection count (e.g., Edit only for single selection)
   - Include dark mode styles

2. **Modals and Dialogs**
   - Use backdrop with `rgba(0,0,0,0.5)`
   - Close on backdrop click or ESC key
   - Include close button (×)
   - Support dark mode

3. **Virtual Lists**
   - Used for large datasets (songs, verses, schedule)
   - Calculate visible range based on scroll position
   - Use absolute positioning for items
   - Buffer items above/below viewport

4. **Search and Filtering**
   - Highlight matching text
   - Preserve search state when clicking items
   - Use `currentSearchQuery` variable pattern
   - Filter using lowercase comparison

### Best Practices

1. **Always save state to settings.json**
   - User preferences
   - Last selection
   - Window positions and sizes
   - UI state (view modes, expanded items)

2. **Use IPC for main process communication**
   - `ipcRenderer.invoke()` for async operations
   - `ipcRenderer.send()` for fire-and-forget

3. **Error Handling**
   - Wrap file operations in try-catch
   - Show user-friendly error messages
   - Log errors to console for debugging

4. **Accessibility**
   - Keyboard navigation support
   - Focus management in modals
   - ARIA labels where appropriate
   - Visible focus indicators

5. **Commit Policy (CRITICAL)**
   - **Never** add, stage, commit, or push any files to the repository unless explicitly instructed by the repository owner. Only make local edits and propose changes if you do not have explicit approval to commit.
  - **Policy update:** Going forward, do **not** commit or push changes. Use the local `scripts/release-bump.js` helper (or explicit, user-approved commits) to perform version bumps, tagging, and releases — do not create commits/tags/pushes yourself unless explicitly instructed.
   - When you need to propose changes to the site or other sensitive files, create a patch/diff and request explicit approval before committing or pushing.
  - NOTE: In all conversations and instructions, when the user references the "site" or asks for changes to the site, treat that as referring specifically to the files in the `./liturgia/` directory (the web site and server-side PHP files).

  **Commit message and changelog style**
  - **Avoid** using the literal string `(chore)` in commit messages. Use clear semantic prefixes like `release:`, `fix:`, `feat:`, `refactor:`, or `docs:` instead.
  - **Do not** include phrases like `bump to <version>` in commit messages or changelog entries. Prefer messages like `release: 2.2.2 — In-app update download` or `fix: remove unused theme textbox` which describe intent and the user-facing change.
  - Keep changelog entries concise, actionable, and focused on user-visible changes rather than internal version bump mechanics.
- Support newline rendering for songs (`content.text.split('\n')`)
- Handle verse numbers as subscripts
- Auto-size fonts to fill available space

### Tab Management
- Use `currentTab` variable ('verses' or 'songs')
- Switch tabs with `switchTab(tabName)`
- Control buttons persist across tabs
- Tab-specific keyboard handlers

### Song Management
- Store in `songs.json` as array of `{title, author, lyrics: [{section, text}]}`
- Support multi-select operations
- Export/import as JSON
- Markdown support in editor (`**bold**`, `*italic*`)

### Dark Mode Toggle
- Stored in settings
- Applied via `body.dark-theme` class
- All elements must support both themes
- Never use inline styles for theme-dependent properties

## Common Pitfalls to Avoid

1. ❌ Inline color styles: `style="background: #fff"`
2. ❌ Hardcoded light colors in JavaScript
3. ❌ Missing dark mode CSS counterparts
4. ❌ Breaking search by not preserving `filteredSongs`
5. ❌ Using display array indices instead of `allSongs` indices
6. ❌ Not handling newlines in song text
7. ❌ Forgetting to save state to settings.json
8. ❌ Not supporting multi-select for delete operations

## Testing Checklist

Before completing any feature:
- [ ] Light mode looks correct
- [ ] Dark mode looks correct
- [ ] No inline styles for theme-dependent properties
- [ ] Keyboard navigation works
- [ ] Multi-select works (if applicable)
- [ ] State persists across restarts
- [ ] Search/filter preserved
- [ ] Canvas rendering correct
- [ ] Error handling in place
