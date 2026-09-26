const tabs = [...document.querySelectorAll('.tab')];
const pages = [...document.querySelectorAll('.page')];
const instanceList = document.getElementById('instance-list');
const worshipStatus = document.getElementById('worship-status');
const headerStatus = document.querySelector('.header-status');
const preview = document.getElementById('program-preview');
const previewContext = preview.getContext('2d');
let programSocket = null;
let selectedInstanceKey = '';
let programFrame = null;
let pendingProgramFrame = null;
let decodingProgramFrame = false;
const previewEmpty = document.getElementById('preview-empty');
const previewState = document.getElementById('preview-state');
const sceneCameraPreview = document.getElementById('scene-camera-preview');
const sceneList = document.getElementById('scene-list');
const sceneMessage = document.getElementById('scene-message');
const instancesByKey = new Map();
let scenes = [];
let activeSceneId = 'camera-program';
let selectedDevices = { cameraId: '', microphoneId: '' };
async function saveDeviceSelections() {
  try {
    selectedDevices = await window.liturgiaStream.saveDevices(selectedDevices);
  } catch (error) {
    const message = document.getElementById('video-message');
    if (message) message.textContent = `Could not save device selection: ${error.message}`;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    tabs.forEach((item) => item.classList.toggle('active', item === tab));
    pages.forEach((page) => page.classList.toggle('active', page.id === `page-${tab.dataset.page}`));
  });
}

function currentScene() {
  return scenes.find((scene) => scene.id === activeSceneId) || scenes[0] || null;
}

function applyScene() {
  const scene = currentScene();
  if (!scene) return;
  const hasProgram = scene.programVisible && !!programFrame;
  const hasCamera = scene.cameraVisible && !!cameraStream;
  preview.hidden = !hasProgram && !hasCamera;
  sceneCameraPreview.hidden = true;
  previewEmpty.hidden = hasProgram || hasCamera;
  previewState.textContent = scene.name;
  if (!hasProgram && !hasCamera) {
    previewEmpty.querySelector('h2').textContent = scene.programVisible ? 'Connect to Liturgia Worship' : 'Choose a camera';
    previewEmpty.querySelector('p').textContent = scene.programVisible
      ? 'Worship’s Program output will appear here when it’s found on your network.'
      : 'Choose a camera on the Video Devices tab to preview this scene.';
  }
}

function drawContain(source, x, y, width, height) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  previewContext.drawImage(source, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawCover(source, x, y, width, height) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  previewContext.drawImage(source, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
}

function drawPreview() {
  const scene = currentScene();
  previewContext.fillStyle = '#000';
  previewContext.fillRect(0, 0, preview.width, preview.height);
  if (scene) {
    const programActive = scene.programVisible && programFrame;
    const cameraActive = scene.cameraVisible && cameraStream && sceneCameraPreview.readyState >= 2;
    if (programActive) drawContain(programFrame, 0, 0, preview.width, preview.height);
    else if (cameraActive) drawCover(sceneCameraPreview, 0, 0, preview.width, preview.height);
    if (programActive && cameraActive) {
      const width = Math.round(preview.width * 0.32);
      const height = Math.round(width * 9 / 16);
      const x = preview.width - width - Math.round(preview.width * 0.05);
      const y = Math.round(preview.height * 0.05);
      previewContext.save();
      previewContext.shadowColor = 'rgba(0,0,0,.55)';
      previewContext.shadowBlur = 24;
      previewContext.fillStyle = '#fff';
      previewContext.fillRect(x - 4, y - 4, width + 8, height + 8);
      previewContext.restore();
      drawCover(sceneCameraPreview, x, y, width, height);
    }
  }
  requestAnimationFrame(drawPreview);
}

function acceptProgramFrame(blob) {
  pendingProgramFrame = { blob, instanceKey: selectedInstanceKey };
  if (decodingProgramFrame) return;
  decodingProgramFrame = true;
  const decodeLatest = async () => {
    while (pendingProgramFrame) {
      const pending = pendingProgramFrame;
      pendingProgramFrame = null;
      try {
        const nextFrame = await createImageBitmap(pending.blob);
        if (pending.instanceKey !== selectedInstanceKey) {
          nextFrame.close();
          continue;
        }
        const previousFrame = programFrame;
        programFrame = nextFrame;
        if (previousFrame) previousFrame.close();
        applyScene();
      } catch (error) {
        console.warn('Could not decode a Worship Program frame:', error);
      }
    }
    decodingProgramFrame = false;
  };
  void decodeLatest();
}

function renderScenes() {
  sceneList.replaceChildren();
  for (const scene of scenes) {
    const button = document.createElement('button');
    button.className = 'scene-card button secondary';
    button.classList.toggle('active', scene.id === activeSceneId);
    button.setAttribute('aria-pressed', scene.id === activeSceneId ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'scene-name';
    name.textContent = scene.name;
    const sources = document.createElement('span');
    sources.className = 'scene-sources';
    sources.textContent = [
      scene.cameraVisible ? 'Camera' : '',
      scene.programVisible ? 'Liturgia Program' : ''
    ].filter(Boolean).join(' + ') || 'No sources';
    button.append(name, sources);
    button.addEventListener('click', () => selectScene(scene.id));
    sceneList.append(button);
  }
  applyScene();
}

async function selectScene(sceneId) {
  const selected = scenes.find((scene) => scene.id === sceneId);
  if (!selected) return;
  activeSceneId = sceneId;
  renderScenes();
  sceneMessage.textContent = `Previewing “${selected.name}”.`;
  try {
    const saved = await window.liturgiaStream.saveScenes(scenes, activeSceneId);
    scenes = saved.scenes;
    activeSceneId = saved.activeSceneId;
    renderScenes();
  } catch (error) {
    sceneMessage.textContent = `Could not save scene: ${error.message}`;
  }
}

function connectToInstance(key) {
  const instance = instancesByKey.get(key);
  if (!instance) return;
  selectedInstanceKey = key;
  if (programSocket) programSocket.close();
  if (programFrame) programFrame.close();
  programFrame = null;
  applyScene();
  if (!instance.programStreamUrl) return;

  const socket = new WebSocket(instance.programStreamUrl);
  socket.binaryType = 'blob';
  programSocket = socket;
  socket.onmessage = (event) => {
    if (programSocket !== socket) return;
    if (event.data instanceof Blob) acceptProgramFrame(event.data);
    else if (event.data instanceof ArrayBuffer) acceptProgramFrame(new Blob([event.data], { type: 'image/jpeg' }));
  };
  socket.onopen = () => {
    if (programSocket === socket) worshipStatus.textContent = 'Liturgia Program connected';
  };
  socket.onerror = () => {
    if (programSocket === socket) worshipStatus.textContent = 'Connecting to Liturgia Program';
  };
  socket.onclose = () => {
    if (programSocket !== socket || selectedInstanceKey !== key) return;
    programSocket = null;
    worshipStatus.textContent = 'Reconnecting to Liturgia Program…';
    window.setTimeout(() => {
      if (selectedInstanceKey === key && instancesByKey.has(key)) connectToInstance(key);
    }, 1500);
  };
}

function renderInstances(items) {
  instancesByKey.clear();
  for (const item of items) instancesByKey.set(item.key, item);
  const current = selectedInstanceKey;
  const list = [...instancesByKey.values()];
  if (selectedInstanceKey && !instancesByKey.has(selectedInstanceKey)) {
    selectedInstanceKey = '';
    if (programSocket) programSocket.close();
    programSocket = null;
    if (programFrame) programFrame.close();
    programFrame = null;
    applyScene();
  }
  if (!selectedInstanceKey) {
    const program = list.find((instance) => instance.displayId === '0' && instance.programStreamUrl);
    if (program) connectToInstance(program.key);
  }

  headerStatus.classList.toggle('connected', list.length > 0);
  worshipStatus.textContent = list.length
    ? `Found ${list.length} Worship ${list.length === 1 ? 'output' : 'outputs'}`
    : 'Looking for Worship';

  if (!list.length) {
    instanceList.innerHTML = '<p class="muted">No Worship output found yet. Make sure Worship is open and connected to this network.</p>';
    return;
  }

  instanceList.replaceChildren();
  for (const instance of list) {
    const row = document.createElement('div');
    row.className = 'instance-row';
    const title = document.createElement('span');
    title.className = 'instance-title';
    title.textContent = instance.name;
    const meta = document.createElement('span');
    meta.className = 'instance-meta';
    const outputName = instance.displayId === '0' ? 'Program' : (instance.displayId || 'Program');
    meta.textContent = `Output ${outputName} · ${instance.address} · Liturgia ${instance.version || 'Worship'}`;
    const button = document.createElement('button');
    button.className = 'button secondary';
    button.textContent = current === instance.key ? 'Connected' : 'Connect';
    button.addEventListener('click', () => connectToInstance(instance.key));
    row.append(title, meta, button);
    instanceList.append(row);
  }
}

window.liturgiaStream.onWorshipInstances(renderInstances);
document.getElementById('refresh-worship').addEventListener('click', async () => {
  instanceList.innerHTML = '<p class="muted">Searching your local network…</p>';
  renderInstances(await window.liturgiaStream.refreshWorship());
});
window.liturgiaStream.getWorshipInstances().then(renderInstances);

let cameraStream = null;
async function refreshVideoDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  const select = document.getElementById('video-device');
  const previous = select.value || selectedDevices.cameraId || '';
  select.replaceChildren(new Option(cameras.length ? 'Choose a camera' : 'No camera found', ''));
  for (const device of cameras) select.add(new Option(device.label || 'Camera', device.deviceId));
  if (cameras.some((device) => device.deviceId === previous)) select.value = previous;
  document.getElementById('video-message').textContent = cameras.length
    ? `${cameras.length} camera ${cameras.length === 1 ? 'device' : 'devices'} found.`
    : 'No camera found. Connect a webcam or capture card, then refresh.';
}
document.getElementById('refresh-video').addEventListener('click', refreshVideoDevices);
document.getElementById('enable-video').addEventListener('click', async () => {
  try {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    await refreshVideoDevices();
    const video = document.getElementById('camera-preview');
    video.srcObject = cameraStream;
    sceneCameraPreview.srcObject = cameraStream;
    applyScene();
    video.hidden = false;
    document.getElementById('video-message').textContent = 'Camera preview is active. Select your camera above.';
  } catch (error) {
    document.getElementById('video-message').textContent = `Camera access failed: ${error.message}`;
  }
});
document.getElementById('video-device').addEventListener('change', async (event) => {
  selectedDevices.cameraId = event.target.value;
  await saveDeviceSelections();
  if (!event.target.value) return;
  try {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: event.target.value } }, audio: false });
    const video = document.getElementById('camera-preview');
    video.srcObject = cameraStream;
    sceneCameraPreview.srcObject = cameraStream;
    applyScene();
    video.hidden = false;
    document.getElementById('video-message').textContent = 'Camera preview is active.';
  } catch (error) {
    document.getElementById('video-message').textContent = `Could not start this camera: ${error.message}`;
  }
});

let audioStream = null;
let audioContext = null;
let meterFrame = 0;
async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  const select = document.getElementById('audio-device');
  const previous = select.value || selectedDevices.microphoneId || '';
  select.replaceChildren(new Option(microphones.length ? 'Choose a microphone' : 'No microphone found', ''));
  for (const device of microphones) select.add(new Option(device.label || 'Microphone', device.deviceId));
  if (microphones.some((device) => device.deviceId === previous)) select.value = previous;
  document.getElementById('audio-message').textContent = microphones.length
    ? `${microphones.length} microphone ${microphones.length === 1 ? 'device' : 'devices'} found.`
    : 'No microphone found. Connect a microphone, then refresh.';
}
async function startMicrophoneMeter(deviceId) {
  audioStream?.getTracks().forEach((track) => track.stop());
  if (audioContext) await audioContext.close();
  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false
  });
  audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(audioStream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const bar = document.getElementById('audio-level');
  const draw = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    const level = Math.min(100, Math.sqrt(sum / data.length) * 180);
    bar.style.width = `${level}%`;
    meterFrame = requestAnimationFrame(draw);
  };
  cancelAnimationFrame(meterFrame);
  draw();
}
document.getElementById('refresh-audio').addEventListener('click', refreshAudioDevices);
document.getElementById('enable-audio').addEventListener('click', async () => {
  try {
    await startMicrophoneMeter(document.getElementById('audio-device').value);
    await refreshAudioDevices();
    document.getElementById('audio-message').textContent = 'Microphone is active. Speak to check the level meter.';
  } catch (error) {
    document.getElementById('audio-message').textContent = `Microphone access failed: ${error.message}`;
  }
});
document.getElementById('audio-device').addEventListener('change', async (event) => {
  selectedDevices.microphoneId = event.target.value;
  await saveDeviceSelections();
  if (!event.target.value) return;
  try {
    await startMicrophoneMeter(event.target.value);
    document.getElementById('audio-message').textContent = 'Microphone is active. Speak to check the level meter.';
  } catch (error) {
    document.getElementById('audio-message').textContent = `Could not start this microphone: ${error.message}`;
  }
});

const presetOutput = {
  '720p30': { width: 1280, height: 720, fps: 30 },
  '1080p30': { width: 1920, height: 1080, fps: 30 },
  '1080p60': { width: 1920, height: 1080, fps: 60 }
};
const destinationStatus = document.getElementById('destination-status');
const saveDestinationButton = document.getElementById('save-destination');

async function loadEncoderInfo() {
  const infoElement = document.getElementById('encoder-info');
  try {
    const info = await window.liturgiaStream.getEncoderInfo();
    infoElement.textContent = info.available
      ? `Available in FFmpeg: ${info.supported.join(', ')}. Actual device availability is checked when streaming starts.`
      : info.error;
  } catch (error) {
    infoElement.textContent = `Encoder detection failed: ${error.message}`;
  }
}

async function loadStreamConfig() {
  try {
    const config = await window.liturgiaStream.getConfig();
    selectedDevices = config.devices || selectedDevices;
    scenes = Array.isArray(config.scenes) ? config.scenes : [];
    activeSceneId = config.activeSceneId || 'camera-program';
    renderScenes();
    if (config.destination) {
      document.getElementById('destination-name').value = config.destination.name;
      document.getElementById('stream-server').value = config.destination.server;
      document.getElementById('stream-key').placeholder = config.destination.keySaved ? 'Saved securely · leave blank to keep' : 'Enter your stream key';
      destinationStatus.textContent = config.destination.keySaved
        ? 'Destination saved securely on this computer.'
        : 'Your saved key could not be opened. Enter it again to replace it.';
    }
    const output = config.output || {};
    const preset = Object.entries(presetOutput).find(([, value]) =>
      value.width === output.width && value.height === output.height && value.fps === output.fps
    );
    if (preset) document.getElementById('output-preset').value = preset[0];
    if (Number.isFinite(output.videoBitrateKbps)) document.getElementById('video-bitrate').value = output.videoBitrateKbps;
    if (Number.isFinite(output.audioBitrateKbps)) document.getElementById('audio-bitrate').value = output.audioBitrateKbps;
  } catch (error) {
    destinationStatus.textContent = `Could not load saved settings: ${error.message}`;
  }
}

saveDestinationButton.addEventListener('click', async () => {
  saveDestinationButton.disabled = true;
  destinationStatus.textContent = 'Saving securely…';
  const preset = presetOutput[document.getElementById('output-preset').value] || presetOutput['1080p30'];
  try {
    const config = await window.liturgiaStream.saveConfig({
      destination: {
        name: document.getElementById('destination-name').value,
        server: document.getElementById('stream-server').value,
        streamKey: document.getElementById('stream-key').value
      },
      output: {
        ...preset,
        videoBitrateKbps: Number(document.getElementById('video-bitrate').value) || 6000,
        audioBitrateKbps: Number(document.getElementById('audio-bitrate').value) || 160,
        audioSampleRate: 48000
      }
    });
    document.getElementById('stream-key').value = '';
    document.getElementById('stream-key').placeholder = 'Saved securely · leave blank to keep';
    destinationStatus.textContent = `“${config.destination.name}” saved securely on this computer.`;
  } catch (error) {
    destinationStatus.textContent = error.message;
  } finally {
    saveDestinationButton.disabled = false;
  }
});

let outputActive = false;
let userStoppingOutput = false;
let outputAudioContext = null;
let outputCanvasStream = null;
let outputComposedStream = null;
let outputMediaRecorder = null;
let outputReconnectPreparation = Promise.resolve();
let outputPendingWrites = new Set();
let outputStartedAt = 0;
let outputClockTimer = null;
let currentOutputConfig = { width: 1920, height: 1080, fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 160, audioSampleRate: 48000 };
const goLiveButton = document.getElementById('go-live');
const streamStatusLabel = document.getElementById('stream-status-label');
const streamStatusDetail = document.getElementById('stream-status-detail');
const largeStatusDot = document.querySelector('.large-dot');
const streamElapsed = document.getElementById('stream-elapsed');

function updateStreamElapsed() {
  if (!outputStartedAt) return;
  const seconds = Math.floor((Date.now() - outputStartedAt) / 1000);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const remainder = String(seconds % 60).padStart(2, '0');
  streamElapsed.textContent = `Duration ${hours}:${minutes}:${remainder}`;
}

async function ensureCameraReady() {
  if (cameraStream) return;
  if (!selectedDevices.cameraId) throw new Error('Choose a camera on the Video Devices tab first.');
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: selectedDevices.cameraId } },
    audio: false
  });
  document.getElementById('camera-preview').srcObject = cameraStream;
  sceneCameraPreview.srcObject = cameraStream;
  applyScene();
}

async function ensureMicrophoneReady() {
  if (audioStream) return;
  if (!selectedDevices.microphoneId) throw new Error('Choose a microphone on the Audio Devices tab first.');
  await startMicrophoneMeter(selectedDevices.microphoneId);
}

function cleanupOutputCapture() {
  outputComposedStream?.getTracks().forEach((track) => track.stop());
  outputComposedStream = null;
  if (outputCanvasStream) outputCanvasStream.getTracks().forEach((track) => track.stop());
  outputCanvasStream = null;
  if (outputAudioContext) outputAudioContext.close();
  outputAudioContext = null;
  outputMediaRecorder = null;
}

async function stopOutputRecorder() {
  const recorder = outputMediaRecorder;
  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      try { recorder.stop(); } catch (_) { resolve(); }
    });
  }
  await Promise.allSettled([...outputPendingWrites]);
  cleanupOutputCapture();
}

async function startOutputRecorder() {
  if (outputMediaRecorder && outputMediaRecorder.state === 'recording') return;
  const scene = currentScene();
  if (!scene) throw new Error('Choose a scene before going live.');
  if (scene.cameraVisible && !cameraStream) await ensureCameraReady();
  if (scene.programVisible && !programFrame) throw new Error('Waiting for Liturgia Program video. Make sure Worship is presenting.');
  await ensureMicrophoneReady();

  outputCanvasStream = preview.captureStream(currentOutputConfig.fps);
  outputAudioContext = new AudioContext({ sampleRate: currentOutputConfig.audioSampleRate });
  await outputAudioContext.resume();
  const destination = outputAudioContext.createMediaStreamDestination();
  outputAudioContext.createMediaStreamSource(audioStream).connect(destination);
  outputComposedStream = new MediaStream([
    ...outputCanvasStream.getVideoTracks(),
    ...destination.stream.getAudioTracks()
  ]);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm';
  const recorder = new MediaRecorder(outputComposedStream, {
    mimeType,
    videoBitsPerSecond: Math.max(2500000, currentOutputConfig.videoBitrateKbps * 1000),
    audioBitsPerSecond: currentOutputConfig.audioBitrateKbps * 1000
  });
  outputMediaRecorder = recorder;
  recorder.ondataavailable = (event) => {
    if (!event.data || !event.data.size || !outputActive) return;
    const write = event.data.arrayBuffer()
      .then((data) => window.liturgiaStream.sendOutputChunk(data))
      .catch((error) => {
        if (outputActive && !userStoppingOutput) streamStatusDetail.textContent = error.message;
      });
    outputPendingWrites.add(write);
    write.finally(() => outputPendingWrites.delete(write));
  };
  recorder.onerror = (event) => {
    streamStatusDetail.textContent = event.error?.message || 'The local video input stopped.';
  };
  recorder.start(100);
}

async function handleOutputStatus(status) {
  if (status.state === 'awaiting-input') {
    try {
      await outputReconnectPreparation;
      if (outputActive && !userStoppingOutput) await startOutputRecorder();
    } catch (error) {
      streamStatusDetail.textContent = error.message;
      await stopLiveStream();
    }
    streamStatusLabel.textContent = 'Connecting…';
  } else if (status.state === 'live') {
    if (!outputStartedAt) {
      outputStartedAt = Date.now();
      streamElapsed.hidden = false;
      updateStreamElapsed();
      outputClockTimer = window.setInterval(updateStreamElapsed, 1000);
    }
    streamStatusLabel.textContent = 'LIVE';
    largeStatusDot.classList.add('live');
    const fps = Number.isFinite(status.fps) ? `${Math.round(status.fps)} FPS` : 'Sending video';
    const bitrate = status.bitrate ? ` · ${status.bitrate}` : '';
    const dropped = Number.isFinite(status.droppedFrames) ? ` ? ${status.droppedFrames} dropped` : ``;
    const resolution = `${currentOutputConfig.width}?${currentOutputConfig.height}`;
    streamStatusDetail.textContent = `${resolution} ? ${fps}${bitrate}${dropped}`;
  } else if (status.state === 'reconnecting') {
    streamStatusLabel.textContent = 'Connection lost';
    largeStatusDot.classList.remove('live');
    const delay = status.retryInMs ? ` Retrying in ${Math.ceil(status.retryInMs / 1000)} seconds.` : ' Retrying now.';
    streamStatusDetail.textContent = `Reconnecting…${delay}`;
    outputReconnectPreparation = stopOutputRecorder();
  } else if (status.state === 'stopping') {
    streamStatusLabel.textContent = 'Ending stream…';
  } else if (status.state === 'stopped') {
    outputActive = false;
    userStoppingOutput = false;
    outputStartedAt = 0;
    if (outputClockTimer !== null) window.clearInterval(outputClockTimer);
    outputClockTimer = null;
    streamElapsed.hidden = true;
    streamElapsed.textContent = 'Duration 00:00:00';
    largeStatusDot.classList.remove('live');
    streamStatusLabel.textContent = 'Not streaming';
    streamStatusDetail.textContent = 'Your settings are saved for next time.';
    goLiveButton.textContent = 'Go Live';
    goLiveButton.disabled = false;
  } else if (status.state === 'connecting') {
    streamStatusLabel.textContent = 'Starting…';
    streamStatusDetail.textContent = status.message || 'Starting the stream encoder.';
  }
  if (outputActive && status.state !== 'stopped') {
    goLiveButton.textContent = 'End Stream';
    goLiveButton.disabled = false;
  }
}

async function stopLiveStream() {
  if (!outputActive) return;
  userStoppingOutput = true;
  goLiveButton.disabled = true;
  await stopOutputRecorder();
  await window.liturgiaStream.stopOutput();
}

async function startLiveStream() {
  const config = await window.liturgiaStream.getConfig();
  if (!config.destination?.keySaved) throw new Error('Save an RTMP or RTMPS destination and stream key first.');
  const scene = currentScene();
  if (!scene || (!scene.cameraVisible && !scene.programVisible)) throw new Error('Choose a scene with a video source.');
  if (scene.cameraVisible) await ensureCameraReady();
  if (scene.programVisible && !programFrame) throw new Error('Waiting for Liturgia Program video. Make sure Worship is presenting.');
  await ensureMicrophoneReady();
  currentOutputConfig = { ...currentOutputConfig, ...(config.output || {}) };
  outputActive = true;
  goLiveButton.textContent = 'Starting…';
  goLiveButton.disabled = true;
  streamStatusDetail.textContent = 'Connecting to your streaming destination…';
  try {
    await window.liturgiaStream.startOutput();
  } catch (error) {
    outputActive = false;
    goLiveButton.textContent = 'Go Live';
    goLiveButton.disabled = false;
    throw error;
  }
}

goLiveButton.addEventListener('click', async () => {
  if (outputActive) {
    if (!window.confirm('End the current stream?')) return;
    try { await stopLiveStream(); }
    catch (error) { streamStatusDetail.textContent = error.message; }
    return;
  }
  if (!window.confirm('Start streaming now?')) return;
  goLiveButton.disabled = true;
  try {
    await startLiveStream();
  } catch (error) {
    streamStatusLabel.textContent = 'Not streaming';
    streamStatusDetail.textContent = error.message;
    goLiveButton.textContent = 'Go Live';
    goLiveButton.disabled = false;
  }
});
window.liturgiaStream.onOutputStatus((status) => { void handleOutputStatus(status); });

window.addEventListener('beforeunload', () => {
  cameraStream?.getTracks().forEach((track) => track.stop());
  audioStream?.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();
  if (programSocket) programSocket.close();
  if (programFrame) programFrame.close();
});
requestAnimationFrame(drawPreview);
refreshVideoDevices();
refreshAudioDevices();
loadStreamConfig();
loadEncoderInfo();
