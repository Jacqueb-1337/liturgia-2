# Liturgia Stream Product Specification

Status: Product definition for MVP planning
Target release: 0.1
Primary platform: Windows 10 and 11, 64 bit

## Product goal

Liturgia Stream is a separate Windows streaming companion for Liturgia Worship. It gives churches a simpler way to send a composed program to RTMP or RTMPS without needing to understand a broadcast engineering workflow.

The operator opens Worship and Stream, connects a camera and microphone, enters a streaming destination once, and clicks Go Live. Stream discovers Worship automatically, receives its Program output, and retains the configuration for the next service.

Stream must fail independently. A Stream crash or encoder failure must not close or interrupt Worship.

## Product principles

- Keep routine operation simple enough for a nontechnical church operator.
- Show one main task area at a time. Do not imitate OBS's dense multi-panel layout.
- Match Liturgia Worship's visual language, controls, spacing, themes, and familiar wording wherever practical.
- Keep the streaming engine independent from Worship and keep the compositor independent from FFmpeg.
- Make the normal service workflow work without opening Worship settings.
- Allow the operator to configure Worship output and its display styles from either Worship or Stream.
- Work without internet for Worship discovery, connection, video transfer, and remote configuration. Internet is needed only to reach the streaming destination.

## Application relationship

Liturgia Stream is a separate application with an independent release cycle. Liturgia Worship gains a Stream button that launches Stream and connects it to the available Worship Program output.

Stream can run on the same computer as Worship or on another computer on the same local network. The second-computer workflow is a core requirement for LAN discovery and configuration, but video and audio synchronization must be maintained when sources are split across computers.

## First-run and returning-user flow

First run guides the operator through:
1. Detect Liturgia Worship instances on the local network.
2. Pair with the desired Worship instance.
3. Select one camera and one microphone or capture-card audio source.
4. Add a destination with a display name, RTMP or RTMPS server, and stream key.
5. Run a short preview and connection check.
6. Save the setup.

Worship output is enabled and broadcasting by default. A normal user does not need to open Worship settings or manually locate its presentation window. If Stream cannot discover Worship, it offers refresh and a manual local-network address option without requiring internet access.

Returning users open both apps and see the saved connection, devices, scenes, and destination. They can click Go Live without repeating setup.

## Focused interface

Use a Liturgia-styled, uncluttered navigation with dedicated pages or tabs:
- Live
- Scenes
- Video Devices
- Audio Devices
- Stream Setup
- Settings

Only the selected workspace is shown as the main configuration surface. Do not place scenes, sources, mixer, preview, and stream diagnostics in multiple docked columns at once.

Live is the service page. It shows a clear preview, selected scene, Worship connection state, a prominent Go Live or End Stream button, and concise live health. Keep compact audio meters and stream status available during a broadcast without opening an advanced dashboard.

Scenes focuses on scene selection and composition. Video Devices focuses on camera and capture inputs. Audio Devices focuses on microphones, system audio, capture-card audio, levels, mute, monitoring, and sync. Stream Setup focuses on destination and output quality. Advanced details remain collapsed unless requested.

Use shared design tokens or closely matched Liturgia Worship styling. Support the user's Worship theme where practical. Avoid introducing an unrelated OBS-style visual identity.

## Liturgia Program output

Liturgia Program is a first-class Stream source. The operator chooses the Worship instance by its friendly device/computer name and selects the Program output. They never browse for a window title or manually add a capture window.

Worship broadcasts the rendered Program output over the LAN by default. It also publishes structured state in the protocol, including:
- Presentation active state
- Current schedule item
- Current slide
- Current song and verse
- Scripture reference
- Clear-screen state
- Black-screen state

MVP video uses the rendered output so custom Worship layouts and themes arrive as shown. The Stream compositor treats this feed like any other visual source. Metadata is carried now for future overlays and automation, but MVP does not require Stream to interpret it.

The existing Network Display behavior is the compatibility baseline for output appearance. Retain its per-display style overrides, transparent background option, black-as-clear behavior, and support for the existing verse, song, and global style settings. Stream users can edit these styles from its Liturgia Program configuration page. Changes made in Stream are sent to Worship, saved in Worship's normal configuration, and reflected in the LAN Program output. The same settings remain editable in Worship. Changes from either application synchronize to the other.

The default output should look like Worship's current Program display. Operators can customize the output's appearance from either app, including output-specific text and global styles. A customization made for Stream must not unexpectedly change a physical sanctuary display unless the user explicitly chooses to share settings.

## LAN discovery, pairing, and control

Use local-network discovery, such as mDNS/DNS-SD, to advertise Worship instances and their Stream Program endpoint. Discovery, pairing, control, state, and media transfer must not require a cloud service or internet access.

Use a versioned protocol over an authenticated LAN connection. It must support:
- Discover and list available Worship instances.
- Pair Stream with a selected Worship instance.
- Subscribe to Program video and state.
- Receive ProgramStarted, ProgramStopped, SlideChanged, ScheduleItemChanged, ClearChanged, and BlackChanged events.
- Read and update Stream-output configuration and per-output styles from either app.
- Report connection, version, and capability state.
- Reconnect after a network interruption without requiring a Worship restart.

Pairing must make the target machine and requested access clear to the operator. Restrict control and firewall exposure to the local/private network. Do not expose a stream key or other RTMP credentials to Worship or its LAN protocol.

## Default network access and Windows Firewall

Worship's LAN Program output is enabled by default. On first launch after installation or when the feature first needs a firewall exception, Worship checks whether its required inbound firewall rule already exists. If not, it invokes a narrowly scoped elevated setup and asks Windows for administrator approval. The operator should not need to type commands or configure router settings.

The rule must:
- Allow only the documented Liturgia Program/control port or ports.
- Apply only to Windows Private network profiles.
- Identify the Liturgia executable or signed helper where Windows supports application scoping.
- Be idempotent, so repeated setup does not create duplicate rules.
- Be removable or repairable through Liturgia settings or the installer.
- Never enable router port forwarding or open the output to the public internet.

Do not silently elevate or run a broad firewall command. Explain the one-time Windows approval in plain language. If the user declines or lacks administrator rights, Worship remains usable, same-computer capture or another available path remains possible, and both apps clearly report that LAN discovery/output is unavailable. Provide a retry action.

## Video transport and rendering

Keep the compositor, sources, and scene model independent from FFmpeg. FFmpeg may provide encoding, audio conversion, muxing, and RTMP/RTMPS transport.

Prototype the Liturgia Program with the existing rendered network-display path or Windows Graphics Capture when both apps run on one computer. For cross-computer operation, the Program output must be carried over the LAN as video frames or a media stream. Do not assume Windows Graphics Capture can capture a window on another computer. Keep the transport behind a source interface so Worship can later share rendered GPU resources for a lower-copy path.

## MVP scope

### Streaming output

- RTMP and RTMPS.
- Destination name, server URL, encrypted stream key, resolution, frame rate, video bitrate, audio bitrate.
- Default 1920x1080, 30 FPS, 6000 Kbps H.264 video, 160 Kbps AAC audio, 48 kHz audio, two-second keyframe interval, CBR.
- Presets: 720p30, 1080p30, 1080p60. Default: 1080p30.
- Automatic encoder selection, preferring NVIDIA NVENC, Intel Quick Sync, AMD hardware encoding, then software H.264.
- Advanced setting can show the selected encoder.
- Store stream keys with Windows DPAPI. Never write keys in plain text to a JSON settings file.

### Sources and scenes

- Sources: Liturgia Program, one active camera or capture card, display capture, window capture, image, video file, and text.
- Browser sources are deferred.
- Scenes: Camera, Camera + Liturgia, and Liturgia Fullscreen. Include Starting Soon and Be Right Back if they fit without delaying the core pipeline.
- Scene transitions: Cut and Fade, with a 300 ms default fade.
- Visual sources support position, size, crop, visibility, opacity, layer order, lock, fit to canvas, and center. Drag and resize directly in the preview.
- Preserve scenes and source settings between launches.

### Video devices

- Windows Media Foundation where practical.
- Enumerate webcams and camera-like USB or HDMI capture devices.
- Configure device, supported resolution, and frame rate.
- MVP reliability target is one active camera source. Multiple cameras can follow.

### Audio

- Microphone, system audio, and capture-card audio.
- Per-source volume, mute, visible level meter, monitoring option, and sync offset.
- Keep level meters available while live.
- Maintain synchronization through long sessions. Capture-card sync offset is a first-class control.

### Preview and stream health

- Default output canvas: 1920x1080. Resizing the app must not change stream resolution.
- Preview should show the composed frame being encoded.
- Show LIVE state, elapsed time, upload bitrate, dropped frames, encoder FPS, output resolution, and connection state.
- Normal status labels: Excellent, Unstable, Disconnected. Keep detailed networking statistics in an advanced section.
- On disconnect, keep rendering locally and reconnect immediately, then after 2 seconds, 5 seconds, and every 10 seconds. Show Connection lost and Reconnecting, then return to LIVE after recovery.
- Allow End Stream explicitly.

### Local recording

Include recording in MVP if it does not delay a stable streaming pipeline. Support recording while streaming and recording without streaming. Prefer a crash-resilient format such as MKV, with MP4 remux/export afterward. A crash should not destroy the entire recording.

### Settings

Save scenes, source arrangement, audio configuration, device selections, destinations, encoder/output settings, and Liturgia integration configuration locally. Encrypt stream keys with DPAPI. Make supported Liturgia output configuration available in both applications and synchronize changes.

## MVP acceptance scenario

On a Windows 10 or Windows 11 64-bit church computer:
1. Worship starts with LAN Program output enabled by default.
2. The operator approves a one-time, narrowly scoped Private-network firewall exception if Windows requires one.
3. Stream discovers Worship automatically. The operator can instead run Stream on another computer on the same LAN and discover and pair with Worship there.
4. The operator selects one camera and microphone or capture-card audio source.
5. The operator creates or selects a scene containing camera and Liturgia Program.
6. The operator enters an RTMPS server and key once.
7. Stream sends stable 1080p30 H.264 video and AAC audio. Worship slide changes appear in the Program source promptly.
8. The operator switches between Camera, Camera + Liturgia, and Liturgia Fullscreen.
9. A brief internet interruption triggers automatic reconnect while local preview and Worship continue.
10. The operator ends the stream. Scenes, devices, destination, and styles remain saved for the next service.
11. The operator can edit Liturgia Program output and its styles from Stream or Worship and sees the same saved configuration in both.

## First technical milestone

Build a small end-to-end prototype before polishing the interface:
- One Liturgia Program source, proven on the same computer and across two computers on a LAN.
- One camera source.
- One microphone source.
- One preview and basic composite.
- One H.264 encoder and AAC encoder.
- One RTMPS destination.
- Start and stop streaming.
- Validate Worship output configuration and style updates from Stream over the LAN.
- Verify the one-time firewall setup and its denied-permission state.

Hardcode most streaming settings for this milestone. The first proof must establish the media pipeline, cross-computer Program transport, synchronization, and recovery path.

## Reliability gate

Before calling MVP production-ready, run repeated long-duration tests. Minimum gate: one three-hour 1080p30 session with camera, Liturgia Program, audio, scene and slide changes, a temporary internet disconnect, reconnect, and recording enabled.

Require no crash, growing memory leak, progressive audio drift, frozen source, or need to restart Worship or Stream. Record reconnect time, dropped frames, encoder load, and synchronization results.

## Deferred beyond MVP

Do not include YouTube, Facebook, or Twitch login, multistreaming, chat, viewer counts, donations, alerts, cloud accounts, scene sync, remote control outside the trusted local network, mobile app, replay buffer, virtual camera, advanced filters, chroma key, studio mode, nested scenes, OBS plugin compatibility, NDI, SRT, AV1, or HEVC streaming.

## Later versions

Version 0.2 may add provider OAuth and broadcast creation, stream metadata editing, multiple destinations, chroma key, audio filters, browser sources, and hotkeys.

Later Liturgia-specific features can use the existing structured state to automate lower thirds, overlays, and scene changes from schedule items. These must remain optional and must not complicate the core service workflow.

