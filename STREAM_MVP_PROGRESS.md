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

### Current limits

- The LAN output reuses the existing Network Display renderer, so Worship's existing style and output settings apply.
- Remote Stream-side editing of Worship output settings/styles still needs an authenticated pairing and configuration protocol.
- Stream does not yet compose scenes or send a stream. Go Live remains disabled until the RTMPS pipeline is implemented.
- The media endpoint remains part of the legacy receiver; the allowlist narrows access but does not replace it with an authenticated media protocol.
- Firewall behavior has unit coverage and static validation but still needs an interactive Windows/UAC and multi-computer smoke test.

### Next milestones

1. Add authenticated LAN pairing and synchronized output/style configuration.
2. Compose Liturgia Program and camera sources into the preview with scene switching.
3. Add RTMPS/H.264/AAC output, reconnect behavior, and protected destination storage.
4. Add persistent scenes and remaining audio controls, then run long-duration reliability tests.
