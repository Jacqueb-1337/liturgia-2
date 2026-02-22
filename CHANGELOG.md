# Changelog

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
