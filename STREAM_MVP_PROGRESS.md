# Liturgia Stream MVP Progress

## 2026-09-26

### Product baseline

- Committed `LITURGIA_STREAM_SPEC.md` in `fb709bb`.
- Locked MVP direction: standalone Windows app, focused navigation, LAN Worship output enabled by default, configuration editable from either app, and secure stream-key storage.

### Working slice

- Added `stream/` as a separate Electron application package in `c9bd1f1`.
- Added focused Live, Scenes, Video Devices, Audio Devices, and Stream Setup pages.
- Added local-network mDNS discovery for Liturgia Network Display outputs.
- Added connection to the existing Worship Network Display receiver for a rendered Program preview.
- Added camera and microphone enumeration, local preview/level checks, and persisted device selections.
- Added mDNS advertisement to Worship's existing Network Display servers, including output ID and app version.
- Added default-on Liturgia Program output on port 7777. An explicit saved opt-out is preserved.
- Added Windows firewall verification and, when needed, one elevated approval flow for app-scoped TCP Program and UDP mDNS rules, limited to inbound Private-profile LocalSubnet traffic.
- Added a Worship settings status and retry action if Windows permission is declined.
- Restricted the existing receiver's media endpoint to image/video paths recently included in the current Program payload.

- Added destination and output preset storage in the Stream settings page. Stream keys are encrypted through Electron safeStorage (Windows DPAPI) and are never returned to the UI when loading settings.
- Added persistent Camera, Camera + Liturgia, and Liturgia Fullscreen scenes that switch the Live preview and keep the selected scene.

### Current limits

- The LAN output reuses the existing Network Display renderer, so Worship's existing style and output settings apply.
- Remote Stream-side editing of Worship output settings/styles still needs an authenticated pairing and configuration protocol.
- The three starter scenes switch the preview and persist their selection. Custom scene/source editing, transforms, and encoded output are still pending.
- Go Live remains disabled until the RTMPS pipeline is implemented.
- The media endpoint remains part of the legacy receiver; the allowlist narrows access but does not replace it with an authenticated media protocol.
- Firewall behavior has unit coverage and static validation but still needs an interactive Windows/UAC and multi-computer smoke test.

### Next milestones

1. Add authenticated LAN pairing and synchronized output/style configuration.
2. Compose Liturgia Program and camera sources into the preview with scene switching.
3. Add RTMPS/H.264/AAC output, reconnect behavior, and protected destination storage.
4. Add persistent scenes and remaining audio controls, then run long-duration reliability tests.
- Added FFmpeg runtime discovery with NVENC, Quick Sync, AMD AMF, and libx264 preference order; the normal setting stays Automatic.
- Added tested RTMP/RTMPS URL validation and baseline H.264/AAC CBR output argument construction. This is still not connected to the compositor or Go Live control.
- Camera and microphone IDs now persist in the local settings file alongside scenes and output settings. Stream keys remain DPAPI-protected by Electron safeStorage.
### Program frame preview

- Added an on-demand Program frame WebSocket from Worship's fullscreen Program window. Stream discovers and connects to Program automatically, then combines the Program feed and selected camera in a 1920x1080 canvas preview.
- This first capture path uses Electron webContents.capturePage at up to 30 FPS and JPEG quality 82, with backpressure limits. It needs a real two-computer performance check before it can be treated as production-ready; direct shared-GPU frame transfer remains future work.

### FFmpeg output prototype

- Connected the Go Live and End Stream controls to FFmpeg using the composited 1920x1080 canvas and selected microphone. Chromium supplies an intermediate WebM stream; FFmpeg transcodes it to the configured H.264/AAC profile and sends RTMP or RTMPS.
- Added live FFmpeg progress reporting, requested reconnect delays, hardware encoder fallback, graceful stop, and output capture cleanup. Disabled background throttling for the Stream window during capture.
- Validation: Stream package syntax check and five focused Jest suites passed (26 tests).
- This is an integration prototype. A real RTMPS service, prolonged stream, encoder throughput, reconnect behavior against a service that preserves sessions, and two-computer Worship capture still need testing. FFmpeg is detected at runtime and is not yet packaged with the installer; the Chromium WebM intermediate encode also needs latency and performance benchmarking.

### Live health display

- Added a persistent elapsed-time counter during LIVE and made resolution, encoder FPS, upload bitrate, and dropped-frame count visible under stream status. The counter resets on End Stream and continues through reconnects.

### Live health display

- Added a persistent elapsed-time counter during LIVE and made resolution, encoder FPS, upload bitrate, and dropped-frame count visible under stream status. The counter resets on End Stream and continues through reconnects.

### RTMPS readiness check

- Confirmed the Facebook ingest host accepts TCP connections on port 443 from the development computer.
- Ran the real FFmpeg output manager locally with a generated video/audio sample. It produced a valid 4-second FLV containing H.264 video at 640x360 and AAC audio at 48 kHz. Temporary media files were removed.
- No stream key was saved, and no video was sent to Facebook. A short ingest test is still needed to verify credentials and RTMPS publishing.

### Facebook RTMPS ingest test

- Sent a 10-second synthetic color-bar and silence test to the supplied Facebook RTMPS ingest endpoint using FFmpeg H.264/AAC output at 1080p30, 6,000 Kbps video, and 160 Kbps audio. FFmpeg sent 300 frames and exited with code 0.
- The stream key was entered through a masked Windows prompt, was not saved, and was not added to the repository. Temporary test helper files were removed.
- This verifies RTMPS ingest with FFmpeg and the target credentials. It does not verify Liturgia Stream's Electron UI, camera, Worship capture, or Facebook's viewer-facing broadcast state. Those still need an end-to-end test.

### Stream application validation

- Ran `npm --prefix stream run check`: all Stream Electron JavaScript files passed syntax checks.
- Ran the four focused Stream Jest suites: 22 tests passed.
- The Electron application was launched with `npm --prefix stream start`; this turn did not complete a visual or camera/Worship in-app test.
- The direct 10-second Facebook RTMPS test used synthetic color bars and silence. It verified service ingest but not the Stream UI or live Worship/camera pipeline.
- Next Stream validation is an in-app Go Live test with Worship Program, camera, and audio sources.
