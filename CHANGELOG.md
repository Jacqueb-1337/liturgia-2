# Changelog

## 6.1.7 - 2026-08-02

- fix: keep cloud relay state and mobile sessions available after websocket fallback


## 6.1.6 - 2026-07-15

- fix: restore website live output with 24 FPS output-only video fill and network display mirroring


## 6.1.5 - 2026-07-05

- fix: widget toggle restore and live selection precedence

## 6.1.4 - 2026-07-05

- fix: keep widget overlays active across normal verse/song changes
- fix: widget exit animations now play on the iframe surface
- fix: timer widgets normalize bad layouts and no longer save 0x0 bounds
- fix: tutorial prompt now respects dismissal on next launch

## 5.8.0 - 2026-05-17

- feat: right-click context menu (Cut, Copy, Paste, Select All) in song editor

## 5.7.1 - 2026-05-10

- feat: improved some of the transitions and aesthetics


## 5.7.0 - 2026-05-10

- fix: sorting of searched items in SONGS tab
- fix: overflow of changelog/diff in the update popover


## 5.6.0 - 2026-05-10

- fix: a race condition caused CLEAR and BLACK to not work correctly in tandem with schedule items
- fix: clicking an item in schedule will now go-to the item in either songs or bible tab and select it for go-live


## 5.5.0 - 2026-04-26

- fix: VideoPsalm import


## 5.4.3 - 2026-03-23

- fix: lots of issues with verse selection in the mobile app


## 5.4.2 - 2026-03-22

- fix: lots of bugs introduced in the previous update
- fix: some bugs with cloud relay


## 5.4.1 - 2026-03-22

- fix: fixed some issues with the sign-in flow and the view subscription modal 


## 5.4.0 - 2026-03-22

- fix: fixed an issue with search inputs not focusing on cold boot
- fix: fixed an issue with search inputs not focusing on cold boot
- feat: added some cloud relay logic


## 5.3.0 - 2026-03-20

- fix: fixed a bunch of issues and pushed a bunch of changes I forgot to commit before lol


## 5.2.0 - 2026-03-19

- feat: Bible export now supports both JSON and XML formats (matching thiagobodruk/bible schema)
- feat: Bible import flow redesigned with format info popover before file selection
- feat: export format chooser popover for selecting JSON or XML when exporting Bibles

## 5.0.7 - 2026-03-12

- fix: startup sanitizer now also collapses double blank lines left by earlier partial fix (stripping \\r left \\n\\n between each lyric line); each line is also trimmed
- fix: normalizeVerseSpacing collapses 3+ consecutive newlines to prevent same issue on fresh imports

## 5.0.6 - 2026-03-12

- fix: CRLF song sanitization moved to main process startup (runs before window opens, guaranteed to succeed); creates songs.json.bak as safety net before rewriting

## 5.0.5 - 2026-03-12

- fix: EasyWorship import no longer produces double blank lines between every lyric line (CRLF \\r\\n not fully stripped from RTF output)
- fix: existing imported songs with stale \\r characters are auto-cleaned on next launch

## 5.0.4 - 2026-03-12

- fix: all global keybinds (go-live Enter, prev/next verse, etc.) are now suppressed when any modal or editor overlay is open — pressing Enter in the song editor no longer triggers Go Live

## 5.0.3 - 2026-03-12

- fix: crash on startup caused by stray double comma in crash dialog message string

## 5.0.2 - 2026-03-12

- feat: app renamed to "Liturgia • Worship" across all titles, dialogs, and site pages
- feat: song list now sorts A-Z by title

## 5.0.1 - 2026-03-12

- fix: sidecar stderr (Vosk internal warnings) no longer triggers the "Errors detected" toast — downgraded from console.error to console.warn

## 5.0.0 - 2026-03-12

- feat: style editor — draggable safe-area overlay on canvas preview; resize from any edge or corner, move by dragging interior
- feat: style editor — per-section sync-from-global (↻) and reset-to-defaults (↺) buttons for per-display overrides
- feat: style editor — song inline-lyrics toggle collapses line breaks into a single flowing block
- fix: style editor — per-display preview no longer shows a black canvas when opened without active live content; displays placeholder text instead
- feat: network display now respects the safe area setting; text no longer overflows when safe area is adjusted
- fix: relay heartbeat re-registers session automatically on 404 (session expired) instead of looping in failure
- fix: speech recognition noise gate (JS + Python RMS) prevents Vosk from hallucinating Bible book abbreviations (Hag, Heb, Hab) from microphone silence
- refactor: all user-facing "AI" labels renamed to "Speech Recognition" (settings panel, toggles, status messages)

## 4.2.1 - 2026-03-10

- fix: verse overlay/ghosting on live display — backgroundsEqual now returns true when both contents have no background, preventing spurious crossfade
- fix: crossfade animation now re-renders with new content text after completing
- fix: removed duplicate external verse number (inline subscript number is sufficient)
- fix: dual translation not rendering on app reopen — display now refreshes when dual mode is restored from saved state
- fix: clear/black mode no longer leaves secondary translation text and divider visible on preview canvas
- feat: speech recognition — all OT books (Malachi, Kings, Chronicles, minor prophets, etc.) added to alias table
- feat: speech recognition — Vosk grammar word list sent at session start to bias decoder toward Bible book names (fixes misrecognitions like "malachi" → "maliki", "exodus" → "x oh x")

## 4.1.0 - 2026-03-02

- feat: multi-format Bible importer — supports Zefania XML, verse-per-line TXT, and JSON formats
- feat: settings UI for Bible import with drag-and-drop file picker
- feat: dynamic Bible metadata — book names, chapter/verse counts update live when a new Bible is loaded
- feat: speech recognition and reference validation use dynamic book names from the loaded Bible
- feat: website media clear/black now fades mirror out and back in (respects transition duration setting)
- feat: website mirror uses z-index overlay so clear/black falls back cleanly to last verse/song background
- fix: website item going live no longer leaves mirror overlaying subsequent verse, song, or photo content
- fix: switching away from a website item destroys the webview (stops audio/video playback)
- fix: black button now correctly stops video background draw loop (was only clearing text)
- fix: clear while website is active shows background underneath without flashing text

## 4.0.1 - 2026-03-01

- fix: book.name fallback to book.book for alternative Bible JSON formats

## 4.0.0 - 2026-03-01

- feat: live window video background plays continuously without restarting between verse changes
- feat: live window GIF background no longer restarts animation on verse change
- fix: video background loop skips crossfade path (was freezing on first frame)
- fix: black flash eliminated when changing verses with a video background
- fix: text fade-out animation no longer stomps on bgCtx during video background playback
- fix: fade-out loop now animates on textCtx when video loop owns bgCtx

## 3.0.19 - 2026-02-22

- fix: improve python discovery in packaged app for sidecar spawning
- fix: search common Windows python installation directories (Program Files, LocalAppData)
- fix: use shell spawning as fallback for PATH-based python resolution
- improve: more helpful error message when Python not found in packaged builds

## 3.0.18 - 2026-02-22

- fix: add splashscreen real-time sidecar download progress (0-100%)
- fix: register liturgia:// protocol handler for deep-link authentication
- fix: add deep-link auth listener to receive tokens from protocol handler
- fix: magic link auth now supports both app (deep link) and web (cookie) flows
- fix: verify token database lookup and creation in auth.db tokens table
- fix: list-tokens now returns all sessions when authenticating via magic link

## 3.0.17 - 2026-02-22

- fix: enable magic link auto-signin on web and app with full token list visibility
- fix: magic links now work via deep protocol (app) and cookies (web)
- fix: resolve token database mismatch between auth.db and verify flow
- fix: token list now displays when authenticating via magic link JWT

## 3.0.6 - 2026-02-20

- CRITICAL FIX: token handlers were returning test token instead of real token
- Secure token handlers (get/set/delete) were using undefined settingsPath variable
- This caused all signins to fail with 500 error and users to be signed out

## 3.0.5 - 2026-02-20

- fix: add single instance lock to prevent multiple windows
- fix: improve remote server port cleanup and EADDRINUSE handling
- improve: show dialog when user tries to open second instance

## 3.0.4 - 2026-02-20

- bump patch release

## 3.0.3 - 2026-02-20

- fix: add error handler for spawn() failures when Python not found
- improve: add Python dependency diagnostics in settings with download link
- improve: add "Recheck Dependencies" button for real-time validation
- improve: check Python availability on settings panel open
- improve: update UI in real-time after Python install without closing settings

## 3.0.2 - 2026-02-20

- improve: clearer error message when Python is not found

## 3.0.1 - 2026-02-20

- fix: move Python dependency check to background to prevent startup hang

## 3.0.0 - 2026-02-20

- release: AI verse suggestions with stable scrolling and automatic dependency installation
- Added real-time AI verse suggestion ticker with smart grouping and refinement detection
- Implemented smooth scroll animations, hover pause, and pending suggestion queue
- Auto-detects and installs Python dependencies (vosk, websockets, numpy)
- Cross-platform compatible (Windows, macOS, Linux)
- Fixed suggestion view stability when new items arrive while hovering

## 2.3.13 - 2026-01-30

- bump patch release

## 2.3.12 - 2026-01-29

- fixed some errors i forgot about

## 2.2.3 - 2026-01-23

- test version

## 2.2.2 - 2026-01-23

- Enhancement: In-app update download and installer progress UI.

## 2.2.1 - 2026-01-23

- Fix: Remove unused Theme textbox from Settings (prepares for future theming options).

## 2.2.0 - 2026-01-23

- Fix: Restore global UI styles so setup/login popover buttons and inputs use app-wide styles.
- Fix: Ensure setup modal inputs and buttons are styled and aligned in dark/light modes.
- Misc: Small UI polish and dark mode tweaks.
