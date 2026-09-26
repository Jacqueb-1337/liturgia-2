# Liturgia Stream MVP Progress

## 2026-09-26

### Product baseline

- Committed `LITURGIA_STREAM_SPEC.md` in commit `fb709bb`.
- Locked MVP direction: standalone Windows app, focused navigation, LAN Worship output enabled by default, configuration editable from either app, and secure stream-key storage.

### Working slice in progress

- Added `stream/` as a separate Electron application package.
- Added focused Live, Scenes, Video Devices, Audio Devices, and Stream Setup pages.
- Added local-network mDNS discovery for Liturgia Network Display outputs.
- Added connection to the existing Worship Network Display receiver for a rendered Program preview.
- Added camera and microphone enumeration, local preview/level checks, and persisted device selections.
- Added mDNS advertisement to Worship's existing Network Display servers, including output ID and app version.

### Current limits

- Discovery advertises Network Display outputs that are already enabled in Worship. Default-on Program output and its one-time, private-network firewall setup are the next integration milestone.
- Stream does not yet compose scenes or send a stream. Go Live and destination saving remain disabled.
- Stream can preview Worship output but cannot yet edit Worship configuration or styles remotely.
- The existing Network Display endpoint does not provide authenticated Stream pairing. Remote configuration will use a separate authenticated protocol.

### Next milestones

1. Create the default-on Worship Program output and add a narrowly scoped, idempotent Windows Private-profile firewall rule with UAC approval.
2. Add authenticated LAN pairing and synchronized output/style configuration.
3. Compose the Liturgia Program and camera sources into the preview.
4. Add RTMPS/H.264/AAC output, reconnect behavior, and protected destination storage.
5. Add persistent scenes and the remaining audio controls, then run long-duration reliability tests.

