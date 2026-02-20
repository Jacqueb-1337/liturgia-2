# Speech Desktop App — Detailed Usage & Integration Guide

## 1) What this app is

This is an Electron desktop transcription app that:

- Captures microphone audio locally.
- Streams audio to a local Python sidecar over WebSocket.
- Uses Vosk for offline ASR (no cloud API key required).
- Supports model sizes (`small`, `medium`, `large`).
- Auto-downloads missing Vosk models.
- Shows live download progress and model status.
- Generates scripture suggestions from rolling transcript context.

It is built to be embedded into another Electron app with minimal backend coupling.

---

## 2) High-level architecture

### Renderer (`index.html`)

Responsibilities:

- Microphone capture (`getUserMedia`, WebAudio graph).
- Sends PCM audio chunks to sidecar WebSocket (`ws://127.0.0.1:8765/transcribe`).
- Renders:
  - Transcript (`final` + `partial`)
  - Status pills
  - Model download progress
  - Scripture suggestions
- Calls preload-exposed Electron IPC methods for sidecar lifecycle and model controls.

### Electron Main (`desktop/main.js`)

Responsibilities:

- Spawns and supervises Python sidecar (`backend/server.py`).
- Parses sidecar stdout/stderr status lines and emits runtime status to renderer.
- Implements IPC handlers:
  - `sidecar:get-status`
  - `sidecar:restart`
  - `sidecar:set-model-size`
  - `sidecar:open-model-folder`
- Serves static app content.

### Preload (`desktop/preload.js`)

Responsibilities:

- Secure bridge via `contextBridge.exposeInMainWorld('desktopRuntime', ...)`.
- Exposes typed-ish runtime methods into renderer without enabling `nodeIntegration`.

### Python Sidecar (`backend/server.py`)

Responsibilities:

- Hosts WebSocket server for transcription.
- Loads/initializes Vosk model.
- Downloads model if missing.
- Emits structured progress/status via log lines.
- Streams `partial` and `final` text messages.

---

## 3) Runtime data flow

1. App starts (`npm start` / `electron .`).
2. Main process ensures sidecar is running.
3. Renderer polls sidecar status and subscribes to pushed status updates.
4. User clicks **Start**:
   - Renderer starts mic capture.
   - Renderer opens WebSocket to sidecar and sends `{ type: "start" }`.
   - Renderer sends binary PCM chunks (16k mono PCM16) continuously.
5. Sidecar returns:
   - `{ type: "partial", text: "..." }`
   - `{ type: "final", text: "..." }`
6. Renderer updates transcript and suggestions.
7. User clicks **Stop**:
   - Renderer sends `{ type: "stop" }` and closes session.

---

## 4) Model sizes and download behavior

Supported model sizes:

- `small`
- `medium`
- `large`

Model mapping is configured in Python (`MODEL_SPECS`) and determines:

- Target folder name under `backend/models`
- Remote download ZIP URL

When a selected model folder is missing:

- Sidecar downloads to `backend/models/<model-dir>.zip.part` (visible while downloading).
- Progress emits both:
  - Percent updates
  - Byte updates
  - Total byte size (when server provides `Content-Length`)
- Archive is extracted and moved into final model folder.

---

## 5) UI behavior (important details)

### Model dropdown and Apply semantics

- Dropdown selection is **pending** until **Apply Model** is clicked.
- Status polling does not overwrite a dirty selection.
- On Apply:
  - IPC sets model size in main process state.
  - Sidecar restarts.
  - New model is loaded/downloaded as needed.

### Download progress area

Displays while downloading:

- Progress bar (determinate when total known; otherwise fallback behavior).
- Text label in form:
  - `X% • downloaded / total` when total known.
  - `X% • downloaded` when total unknown.
- Folder button (SVG icon): opens model folder in Explorer/Finder.

---

## 6) IPC contract reference

Exposed to renderer through `window.desktopRuntime`:

- `getSidecarStatus(): Promise<Status>`
- `restartSidecar(): Promise<{ ok: boolean, status: Status }>`
- `setSidecarModelSize(size: string): Promise<{ ok: boolean, modelSize: string, status: Status }>`
- `openSidecarModelFolder(): Promise<{ ok: boolean, path?: string, error?: string }>`
- `onSidecarStatus(handler: (status) => void): () => void` (unsubscribe)

### Status object fields (current practical set)

- `processRunning: boolean`
- `managedProcess: boolean`
- `portOpen: boolean`
- `modelReady: boolean`
- `statusMessage: string`
- `modelSize: "small" | "medium" | "large"`
- `downloadProgress: number | null`
- `downloadBytes: number`
- `downloadTotalBytes: number`
- `modelDownloadDir: string`
- `restarting: boolean`
- `lastError: string`
- `sidecarWsUrl: string`

When integrating elsewhere, keep these field names stable or version them.

---

## 7) Sidecar WebSocket protocol

Renderer → Sidecar:

- JSON control messages:
  - `{ "type": "start" }`
  - `{ "type": "stop" }`
- Binary audio frames:
  - PCM16 mono audio at 16kHz

Sidecar → Renderer:

- `{ "type": "status", "message": "..." }`
- `{ "type": "partial", "text": "..." }`
- `{ "type": "final", "text": "..." }`

---

## 8) Local setup and run

### Prerequisites

- Node.js + npm
- Python 3.x
- Project virtual environment (`.venv`) with sidecar deps installed

### Start app

- `npm start`

### If stale processes cause odd behavior

Use PowerShell:

- `Get-Process electron,python -ErrorAction SilentlyContinue | Stop-Process -Force`

Then restart:

- `npm start`

---

## 9) Typical user workflow

1. Launch app.
2. Select mic device (if needed).
3. Select model size.
4. Click **Apply Model**.
5. Wait for download/load (first-time only per model).
6. Click **Start** to transcribe.
7. Observe transcript + suggestions.
8. Click **Stop** when done.

---

## 10) Integration plan for another Electron app

Use this as a checklist for porting.

### A. Main process integration

1. Copy/adapt sidecar lifecycle manager from `desktop/main.js`:
   - spawn
   - stdout/stderr parsing
   - status state machine
   - restart and watchdog logic
2. Keep IPC endpoints identical initially to reduce renderer changes.
3. Preserve sidecar environment variables:
   - `VOSK_MODEL_SIZE`
   - optional `VOSK_MODEL_PATH`

### B. Preload bridge

1. Add `desktopRuntime` API with the same function names.
2. Keep `contextIsolation: true`, `nodeIntegration: false`.
3. Expose only required methods/events.

### C. Renderer integration

1. Add or map controls:
   - Start/Stop
   - Restart server
   - Model select + Apply
   - Download progress + open-folder button
2. Subscribe to `onSidecarStatus` and render pills/progress.
3. Connect to sidecar WebSocket and stream mic PCM chunks.

### D. Backend integration

1. Bring over `backend/server.py` and Python deps.
2. Ensure model folder path is writable in target app environment.
3. Verify firewall/AV rules don’t block local WebSocket binding.

---

## 11) Recommended boundaries for clean embedding

To make future migration easier:

- Keep sidecar manager in its own module (main process).
- Keep renderer-side transport (audio + socket) separate from UI rendering.
- Keep scripture inference logic isolated from transcription transport.

Suggested module boundaries:

- `main/sidecarManager.ts`
- `renderer/transcriptionClient.ts`
- `renderer/modelDownloadView.ts`
- `renderer/scriptureEngine.ts`

---

## 12) Troubleshooting guide

### Issue: `No handler registered for 'sidecar:set-model-size'`

Cause: stale Electron main process.

Fix:

1. Kill all Electron/Python processes.
2. Relaunch app.

### Issue: `OSError: [Errno 10048] ... address already in use`

Cause: existing process bound to port `8765`.

Fix:

- Kill stale Python/Electron processes and restart.

### Issue: Download appears stuck at 0% or slow updates

Possible causes:

- Percent granularity too coarse vs large file size (fixed in current implementation).
- No total-size header from remote server (fallback bytes display).
- Interrupted sidecar lifecycle during download.

### Issue: Browser seems faster than in-app download

Possible causes:

- Server-side throttling differences per user-agent/connection behavior.
- Single-stream Python download path overhead.
- Background process interruptions/restarts.

---

## 13) Operational notes for production hardening

If you ship this in another app, consider:

- Download resume support (`Range` requests) for `.zip.part`.
- Checksum verification for downloaded ZIP.
- Explicit “download in progress” guard to avoid accidental restart.
- Persisted telemetry/log ring buffer for diagnosing sidecar exits.
- Signed binaries and controlled Python runtime packaging strategy.

---

## 14) Quick reference

### Important paths

- UI: `index.html`
- Main process: `desktop/main.js`
- Preload: `desktop/preload.js`
- Sidecar backend: `backend/server.py`
- Models directory: `backend/models`

### Medium model direct URL

- `https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip`

---

## 15) Copilot prompt seed (for integration)

You can paste this into Copilot Chat in your target app:

"Integrate a local Vosk transcription sidecar into my Electron app with this contract:
- Main process IPC: sidecar:get-status, sidecar:restart, sidecar:set-model-size, sidecar:open-model-folder
- Renderer WebSocket audio streaming to ws://127.0.0.1:8765/transcribe using 16k mono PCM16
- Status fields: processRunning, portOpen, modelReady, statusMessage, modelSize, downloadProgress, downloadBytes, downloadTotalBytes, modelDownloadDir, restarting, lastError
- UI controls: Start/Stop, model size dropdown + Apply, progress bar with downloaded/total, open folder button
- Preserve contextIsolation=true and preload bridge
- Add robust process restart handling and stale-process mitigation"

---

If you want, the next step is I can generate a second document that is purely technical API docs (no UI text) for direct engineering handoff.