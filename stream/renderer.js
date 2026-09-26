const tabs = [...document.querySelectorAll('.tab')];
const pages = [...document.querySelectorAll('.page')];
const instanceList = document.getElementById('instance-list');
const worshipStatus = document.getElementById('worship-status');
const headerStatus = document.querySelector('.header-status');
const preview = document.getElementById('program-preview');
const previewEmpty = document.getElementById('preview-empty');
const previewState = document.getElementById('preview-state');
const instancesByKey = new Map();

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    tabs.forEach((item) => item.classList.toggle('active', item === tab));
    pages.forEach((page) => page.classList.toggle('active', page.id === `page-${tab.dataset.page}`));
  });
}

function connectToInstance(key) {
  const instance = instancesByKey.get(key);
  if (!instance) return;
  preview.src = instance.url;
  preview.hidden = false;
  previewEmpty.hidden = true;
  previewState.textContent = instance.name;
}

function renderInstances(items) {
  instancesByKey.clear();
  for (const item of items) instancesByKey.set(item.key, item);
  const current = preview.src;
  const list = [...instancesByKey.values()];

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
    button.textContent = current === instance.url ? 'Connected' : 'Connect';
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
  const previous = select.value || localStorage.getItem('liturgiaStream.cameraId') || '';
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
    video.hidden = false;
    document.getElementById('video-message').textContent = 'Camera preview is active. Select your camera above.';
  } catch (error) {
    document.getElementById('video-message').textContent = `Camera access failed: ${error.message}`;
  }
});
document.getElementById('video-device').addEventListener('change', async (event) => {
  localStorage.setItem('liturgiaStream.cameraId', event.target.value);
  if (!event.target.value) return;
  try {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: event.target.value } }, audio: false });
    const video = document.getElementById('camera-preview');
    video.srcObject = cameraStream;
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
  const previous = select.value || localStorage.getItem('liturgiaStream.microphoneId') || '';
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
  localStorage.setItem('liturgiaStream.microphoneId', event.target.value);
  if (!event.target.value) return;
  try {
    await startMicrophoneMeter(event.target.value);
    document.getElementById('audio-message').textContent = 'Microphone is active. Speak to check the level meter.';
  } catch (error) {
    document.getElementById('audio-message').textContent = `Could not start this microphone: ${error.message}`;
  }
});

window.addEventListener('beforeunload', () => {
  cameraStream?.getTracks().forEach((track) => track.stop());
  audioStream?.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();
});
refreshVideoDevices();
refreshAudioDevices();
