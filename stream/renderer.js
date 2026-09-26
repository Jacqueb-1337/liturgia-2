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
const customEditor = document.getElementById('custom-scene-editor');
const editorCanvas = document.getElementById('scene-editor-preview');
const editorContext = editorCanvas.getContext('2d');
const editorInteraction = document.getElementById('editor-interaction');
const editorSelection = document.getElementById('editor-selection');
const layerList = document.getElementById('layer-list');
const layerProperties = document.getElementById('layer-properties');
const imageCache = new Map();
const programReceivers = new Map();
const programReceiverHost = document.getElementById('program-receivers');
let selectedLayerId = '';
let sceneSaveQueue = Promise.resolve();
const instancesByKey = new Map();
const worshipStyleTarget = document.getElementById('worship-style-target');
const worshipStyleStatus = document.getElementById('worship-style-status');
const worshipStyleCss = document.getElementById('worship-style-css');
const worshipStyleColor = document.getElementById('worship-style-color');
const worshipStyleSize = document.getElementById('worship-style-size');
const worshipStyleFont = document.getElementById('worship-style-font');
let worshipStyles = null;
let worshipStyleInstanceKey = '';
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

function sceneHasSource(scene, type) {
  return scene?.custom ? scene.layers.some((layer) => layer.type === type && layer.visible) :
    type === 'program' ? !!scene?.programVisible : type === 'camera' ? !!scene?.cameraVisible : false;
}

function sendProgramSourceStyles(layer) {
  const receiver = programReceivers.get(layer.id);
  if (receiver?.ready) receiver.iframe.contentWindow.postMessage({
    type: 'liturgia-stream-styles', layerId: layer.id, styles: layer.sourceStyles || {}
  }, receiver.origin);
}

function updateProgramReceivers() {
  const scene = currentScene();
  const instance = instancesByKey.get(selectedInstanceKey);
  const requested = scene?.custom && instance?.url
    ? scene.layers.filter((layer) => layer.type === 'program' && layer.visible) : [];
  const keep = new Set(requested.map((layer) => layer.id));
  for (const [id, receiver] of programReceivers) {
    const layer = requested.find((item) => item.id === id);
    if (keep.has(id) && receiver.key === selectedInstanceKey && receiver.transparent === !!layer.transparent) continue;
    receiver.frame?.close();
    receiver.iframe.remove();
    programReceivers.delete(id);
  }
  if (!instance) return;
  const origin = new URL(instance.url).origin;
  for (const layer of requested) {
    if (programReceivers.has(layer.id)) {
      sendProgramSourceStyles(layer);
      continue;
    }
    const iframe = document.createElement('iframe');
    iframe.title = `Worship source ${layer.name}`;
    iframe.setAttribute('aria-hidden', 'true');
    const receiver = { iframe, origin, key: selectedInstanceKey, transparent: !!layer.transparent, ready: false, frame: null };
    programReceivers.set(layer.id, receiver);
    programReceiverHost.append(iframe);
    const options = new URLSearchParams({ stream: '1', layer: layer.id });
    if (layer.transparent) { options.set('t', '1'); options.set('c', '1'); }
    iframe.src = `${instance.url}?${options}`;
  }
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !['liturgia-stream-ready', 'liturgia-stream-frame', 'liturgia-stream-error'].includes(data.type)) return;
  const receiver = programReceivers.get(data.layerId);
  if (!receiver || event.source !== receiver.iframe.contentWindow || event.origin !== receiver.origin) {
    data.frame?.close?.();
    return;
  }
  if (data.type === 'liturgia-stream-ready') {
    receiver.ready = true;
    const layer = currentScene()?.layers?.find((item) => item.id === data.layerId);
    if (layer) sendProgramSourceStyles(layer);
  } else if (data.type === 'liturgia-stream-frame' && data.frame instanceof ImageBitmap) {
    receiver.frame?.close();
    receiver.frame = data.frame;
    applyScene();
  } else if (data.type === 'liturgia-stream-error') {
    sceneMessage.textContent = `Worship source: ${data.message}`;
  }
});

function selectedLayer() {
  return currentScene()?.layers?.find((layer) => layer.id === selectedLayerId) || null;
}

function applyScene() {
  const scene = currentScene();
  if (!scene) return;
  const hasProgram = sceneHasSource(scene, 'program') && (scene.custom
    ? scene.layers.some((layer) => layer.visible && layer.type === 'program' && programReceivers.get(layer.id)?.frame)
    : !!programFrame);
  const hasCamera = sceneHasSource(scene, 'camera') && !!cameraStream;
  const hasOther = scene.custom && scene.layers.some((layer) => layer.visible && (layer.type === 'text' || (layer.type === 'image' && imageCache.get(layer.imagePath)?.complete)));
  preview.hidden = !hasProgram && !hasCamera && !hasOther;
  sceneCameraPreview.hidden = true;
  previewEmpty.hidden = hasProgram || hasCamera || hasOther;
  previewState.textContent = scene.name;
  if (!hasProgram && !hasCamera && !hasOther) {
    const needsProgram = sceneHasSource(scene, 'program');
    previewEmpty.querySelector('h2').textContent = needsProgram ? 'Connect to Liturgia Worship' : sceneHasSource(scene, 'camera') ? 'Choose a camera' : 'Add a layer';
    previewEmpty.querySelector('p').textContent = needsProgram
      ? 'Worship’s Program output will appear here when it’s found on your network.'
      : sceneHasSource(scene, 'camera') ? 'Choose a camera on the Video Devices tab to preview this scene.' : 'Add a layer on the Scenes tab.';
  }
}

function drawContain(ctx, source, x, y, width, height) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(source, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawCover(ctx, source, x, y, width, height) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  ctx.drawImage(source, (sourceWidth - cropWidth) / 2, (sourceHeight - cropHeight) / 2, cropWidth, cropHeight, x, y, width, height);
}

function drawCustomLayer(ctx, layer) {
  if (!layer.visible) return;
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.filter = `brightness(${layer.brightness ?? 100}%) contrast(${layer.contrast ?? 100}%) saturate(${layer.saturation ?? 100}%) hue-rotate(${layer.hue ?? 0}deg)`;
  ctx.beginPath();
  ctx.rect(layer.x, layer.y, layer.width, layer.height);
  ctx.clip();
  if (layer.type === 'text') {
    ctx.fillStyle = layer.color;
    ctx.font = `600 ${layer.fontSize}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'top';
    const lines = layer.text.split('\n');
    lines.forEach((line, index) => ctx.fillText(line, layer.x + 12 - layer.panX * 5, layer.y + 12 - layer.panY * 5 + index * layer.fontSize * 1.2));
  } else {
    const source = layer.type === 'program' ? programReceivers.get(layer.id)?.frame : layer.type === 'camera' ?
      (cameraStream && sceneCameraPreview.readyState >= 2 ? sceneCameraPreview : null) : imageCache.get(layer.imagePath);
    if (source && (layer.type !== 'image' || source.complete)) {
      const sourceWidth = source.videoWidth || source.width;
      const sourceHeight = source.videoHeight || source.height;
      const left = Math.min(layer.cropLeft, .99 - layer.cropRight);
      const top = Math.min(layer.cropTop, .99 - layer.cropBottom);
      const remainingWidth = Math.max(1, sourceWidth * (1 - left - layer.cropRight));
      const remainingHeight = Math.max(1, sourceHeight * (1 - top - layer.cropBottom));
      const sampleWidth = Math.max(1, remainingWidth / layer.zoom);
      const sampleHeight = Math.max(1, remainingHeight / layer.zoom);
      const sampleX = sourceWidth * left + (remainingWidth - sampleWidth) * (.5 + layer.panX / 200);
      const sampleY = sourceHeight * top + (remainingHeight - sampleHeight) * (.5 + layer.panY / 200);
      ctx.drawImage(source, sampleX, sampleY, sampleWidth, sampleHeight, layer.x, layer.y, layer.width, layer.height);
    }
  }
  ctx.restore();
}

function paintScene(ctx, scene) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1920, 1080);
  if (!scene) return;
  if (scene.custom) {
    for (const layer of scene.layers) drawCustomLayer(ctx, layer);
    return;
  }
  const programActive = scene.programVisible && programFrame;
  const cameraActive = scene.cameraVisible && cameraStream && sceneCameraPreview.readyState >= 2;
  if (programActive) drawContain(ctx, programFrame, 0, 0, 1920, 1080);
  else if (cameraActive) drawCover(ctx, sceneCameraPreview, 0, 0, 1920, 1080);
  if (programActive && cameraActive) {
    const width = Math.round(1920 * .32);
    const height = Math.round(width * 9 / 16);
    const x = 1920 - width - 96;
    const y = 54;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 4, y - 4, width + 8, height + 8);
    ctx.restore();
    drawCover(ctx, sceneCameraPreview, x, y, width, height);
  }
}

function drawPreview() {
  const scene = currentScene();
  paintScene(previewContext, scene);
  if (scene?.custom && !customEditor.hidden) paintScene(editorContext, scene);
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
    sources.textContent = scene.custom
      ? `${scene.layers.length} layer${scene.layers.length === 1 ? '' : 's'} · Custom`
      : [scene.cameraVisible ? 'Camera' : '', scene.programVisible ? 'Liturgia Program' : ''].filter(Boolean).join(' + ') || 'No sources';
    button.append(name, sources);
    button.addEventListener('click', () => selectScene(scene.id));
    sceneList.append(button);
  }
  applyScene();
  renderCustomEditor();
  updateProgramReceivers();
}

async function selectScene(sceneId) {
  const selected = scenes.find((scene) => scene.id === sceneId);
  if (!selected) return;
  activeSceneId = sceneId;
  renderScenes();
  sceneMessage.textContent = `Previewing “${selected.name}”.`;
  await persistScenes();
}

function newLayer(type) {
  const base = { id: crypto.randomUUID(), type, name: { program: 'Liturgia Program', camera: 'Camera', image: 'Image', text: 'Text' }[type],
    x: 0, y: 0, width: 1920, height: 1080, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0,
    panX: 0, panY: 0, zoom: 1, opacity: 1, brightness: 100, contrast: 100, saturation: 100, hue: 0, visible: true, locked: false,
    text: type === 'text' ? 'Your text' : '', fontSize: 72, color: '#ffffff', imagePath: '', transparent: false, sourceStyles: {} };
  if (type === 'camera') Object.assign(base, { x: 1150, y: 60, width: 640, height: 360 });
  if (type === 'text') Object.assign(base, { x: 160, y: 820, width: 1600, height: 150 });
  return base;
}

function persistScenes() {
  // Serialize edits so an earlier disk write cannot overwrite a newer drag or field change.
  const snapshot = JSON.parse(JSON.stringify(scenes));
  const sceneId = activeSceneId;
  sceneSaveQueue = sceneSaveQueue.catch(() => {}).then(async () => {
    await window.liturgiaStream.saveScenes(snapshot, sceneId);
    sceneMessage.textContent = 'Scene saved.';
  }).catch((error) => { sceneMessage.textContent = `Could not save scene: ${error.message}`; });
  return sceneSaveQueue;
}

function loadLayerImage(imagePath) {
  if (!imagePath || imageCache.has(imagePath)) return;
  const image = new Image();
  imageCache.set(imagePath, image);
  window.liturgiaStream.readLayerImage(imagePath).then((url) => { image.src = url; image.onload = applyScene; })
    .catch((error) => { imageCache.delete(imagePath); sceneMessage.textContent = `Could not load image: ${error.message}`; });
}

function updateSelectionOutline() {
  const layer = selectedLayer();
  editorSelection.hidden = !layer || !layer.visible;
  if (!layer || !layer.visible) return;
  const scaleX = 100 / 1920, scaleY = 100 / 1080;
  Object.assign(editorSelection.style, {
    left: `${layer.x * scaleX}%`, top: `${layer.y * scaleY}%`,
    width: `${layer.width * scaleX}%`, height: `${layer.height * scaleY}%`
  });
}

function renderCustomEditor() {
  const scene = currentScene();
  customEditor.hidden = !scene?.custom;
  if (!scene?.custom) return;
  document.getElementById('custom-scene-name').value = scene.name;
  if (!scene.layers.some((layer) => layer.id === selectedLayerId)) selectedLayerId = scene.layers.at(-1)?.id || '';
  layerList.replaceChildren();
  for (let index = scene.layers.length - 1; index >= 0; index--) {
    const layer = scene.layers[index];
    if (layer.type === 'image') loadLayerImage(layer.imagePath);
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.classList.toggle('selected', layer.id === selectedLayerId);
    const select = document.createElement('button');
    select.className = 'button secondary layer-select';
    select.textContent = `${layer.visible ? '◉' : '○'} ${layer.name}`;
    select.title = 'Select layer';
    select.addEventListener('click', () => { selectedLayerId = layer.id; renderCustomEditor(); });
    select.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      selectedLayerId = layer.id;
      renderCustomEditor();
      showLayerMenu(event);
    });
    const control = (caption, title, callback) => {
      const button = document.createElement('button');
      button.className = 'button secondary';
      button.textContent = caption;
      button.title = title;
      button.setAttribute('aria-label', `${title} ${layer.name}`);
      button.onclick = callback;
      row.append(button);
    };
    row.append(select);
    control(layer.visible ? '◉' : '○', 'Show or hide', () => {
      layer.visible = !layer.visible; renderCustomEditor(); applyScene(); persistScenes();
    });
    control(layer.locked ? '🔒' : '◇', 'Lock or unlock', () => {
      layer.locked = !layer.locked; renderCustomEditor(); persistScenes();
    });
    control('↑', 'Move forward', () => {
      if (index === scene.layers.length - 1) return;
      [scene.layers[index], scene.layers[index + 1]] = [scene.layers[index + 1], scene.layers[index]];
      renderCustomEditor(); persistScenes();
    });
    control('↓', 'Move backward', () => {
      if (index === 0) return;
      [scene.layers[index], scene.layers[index - 1]] = [scene.layers[index - 1], scene.layers[index]];
      renderCustomEditor(); persistScenes();
    });
    layerList.append(row);
  }
  const layer = selectedLayer();
  layerProperties.hidden = !layer;
  if (layer) {
    document.getElementById('layer-name').value = layer.name;
    document.getElementById('layer-text').value = layer.text;
    for (const id of ['layer-text', 'layer-text-label', 'layer-font-size-label', 'layer-color-label']) document.getElementById(id).hidden = layer.type !== 'text';
    document.getElementById('layer-color').value = layer.color;
    document.getElementById('choose-layer-image').hidden = layer.type !== 'image';
    for (const id of ['layer-appearance-heading', 'layer-appearance-note', 'layer-appearance-fields']) {
      document.getElementById(id).hidden = layer.type === 'text';
    }
    const defaults = document.getElementById('worship-defaults');
    document.getElementById('layer-transparent-label').hidden = layer.type !== 'program';
    document.getElementById('layer-transparent').checked = layer.transparent === true;
    defaults.hidden = layer.type !== 'program';
    if (layer.type === 'program') showWorshipStyle();
    if (layer.type !== 'program') defaults.open = false;
    for (const input of layerProperties.querySelectorAll('[data-layer-field]')) {
      const key = input.dataset.layerField;
      const fallback = { brightness: 100, contrast: 100, saturation: 100, hue: 0 };
      const value = layer[key] ?? fallback[key];
      input.value = ['cropLeft', 'cropTop', 'cropRight', 'cropBottom', 'opacity'].includes(key) ? Math.round(value * 100) : value;
    }
  }
  updateSelectionOutline();
}

document.getElementById('create-custom-scene').addEventListener('click', () => {
  if (scenes.length >= 20) { sceneMessage.textContent = 'Maximum of 20 scenes reached.'; return; }
  const scene = { id: crypto.randomUUID(), name: `Custom Scene ${scenes.filter((item) => item.custom).length + 1}`,
    custom: true, cameraVisible: false, programVisible: false, layers: [newLayer('program')] };
  scenes.push(scene);
  activeSceneId = scene.id;
  selectedLayerId = scene.layers[0].id;
  renderScenes();
  persistScenes();
});
document.getElementById('remove-custom-scene').addEventListener('click', () => {
  const scene = currentScene();
  if (!scene?.custom || !window.confirm(`Delete “${scene.name}”?`)) return;
  scenes = scenes.filter((item) => item !== scene);
  activeSceneId = scenes[0].id;
  selectedLayerId = '';
  renderScenes();
  persistScenes();
});
document.getElementById('custom-scene-name').addEventListener('change', (event) => {
  const scene = currentScene();
  if (!scene?.custom) return;
  scene.name = event.target.value.trim().slice(0, 48) || scene.name;
  renderScenes(); persistScenes();
});
document.getElementById('add-layer').addEventListener('click', () => {
  const scene = currentScene();
  if (!scene?.custom || scene.layers.length >= 20) { sceneMessage.textContent = 'Maximum of 20 layers reached.'; return; }
  const layer = newLayer(document.getElementById('add-layer-type').value);
  scene.layers.push(layer);
  selectedLayerId = layer.id;
  renderScenes(); persistScenes();
});
document.getElementById('layer-transparent').addEventListener('change', (event) => {
  const layer = selectedLayer();
  if (layer?.type !== 'program') return;
  layer.transparent = event.target.checked;
  updateProgramReceivers();
  applyScene();
  persistScenes();
});
document.getElementById('layer-name').addEventListener('change', (event) => {
  const layer = selectedLayer();
  if (!layer) return;
  layer.name = event.target.value.trim().slice(0, 48) || layer.name;
  renderCustomEditor(); persistScenes();
});
document.getElementById('layer-text').addEventListener('change', (event) => {
  const layer = selectedLayer();
  if (layer) { layer.text = event.target.value; persistScenes(); }
});
document.getElementById('layer-color').addEventListener('input', (event) => {
  const layer = selectedLayer();
  if (layer) { layer.color = event.target.value; persistScenes(); }
});
for (const input of layerProperties.querySelectorAll('[data-layer-field]')) {
  input.addEventListener('change', () => {
    const layer = selectedLayer();
    if (!layer) return;
    const field = input.dataset.layerField;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    const bounds = {
      x: [-1920, 3840], y: [-1080, 2160], width: [20, 3840], height: [20, 2160],
      cropLeft: [0, .95], cropTop: [0, .95], cropRight: [0, .95], cropBottom: [0, .95],
      panX: [-100, 100], panY: [-100, 100], zoom: [1, 5], opacity: [0, 1], fontSize: [8, 300],
      brightness: [0, 200], contrast: [0, 200], saturation: [0, 200], hue: [-180, 180]
    };
    const measured = ['cropLeft', 'cropTop', 'cropRight', 'cropBottom', 'opacity'].includes(field) ? value / 100 : value;
    layer[field] = Math.max(bounds[field][0], Math.min(bounds[field][1], measured));
    renderCustomEditor(); persistScenes();
  });
}
document.getElementById('layer-fit').onclick = () => {
  const layer = selectedLayer(); if (!layer) return;
  Object.assign(layer, { x: 0, y: 0, width: 1920, height: 1080 });
  renderCustomEditor(); persistScenes();
};
document.getElementById('layer-center').onclick = () => {
  const layer = selectedLayer(); if (!layer) return;
  layer.x = Math.round((1920 - layer.width) / 2);
  layer.y = Math.round((1080 - layer.height) / 2);
  renderCustomEditor(); persistScenes();
};
function duplicateSelectedLayer() {
  const scene = currentScene(), layer = selectedLayer();
  if (!scene?.custom || !layer) return;
  if (scene.layers.length >= 20) { sceneMessage.textContent = 'Maximum of 20 layers reached.'; return; }
  const copy = { ...layer, id: crypto.randomUUID(), name: `${layer.name} copy`.slice(0, 48),
    x: Math.min(3840, layer.x + 40), y: Math.min(2160, layer.y + 40) };
  scene.layers.splice(scene.layers.indexOf(layer) + 1, 0, copy);
  selectedLayerId = copy.id;
  renderScenes(); persistScenes();
}
document.getElementById('layer-duplicate').onclick = duplicateSelectedLayer;
document.getElementById('layer-remove').onclick = () => {
  const scene = currentScene(); if (!scene?.custom) return;
  scene.layers = scene.layers.filter((layer) => layer.id !== selectedLayerId);
  selectedLayerId = scene.layers.at(-1)?.id || '';
  renderScenes(); persistScenes();
};
document.getElementById('choose-layer-image').onclick = async () => {
  const layer = selectedLayer(); if (!layer || layer.type !== 'image') return;
  const imagePath = await window.liturgiaStream.chooseLayerImage();
  if (!imagePath) return;
  layer.imagePath = imagePath;
  loadLayerImage(imagePath);
  persistScenes();
};

let pointerDrag = null;
function pointerCanvasPosition(event) {
  const rect = editorInteraction.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * 1920 / rect.width, y: (event.clientY - rect.top) * 1080 / rect.height };
}
editorInteraction.addEventListener('pointerdown', (event) => {
  const scene = currentScene();
  if (!scene?.custom || event.button !== 0) return;
  const { x, y } = pointerCanvasPosition(event);
  const hit = (item) => item.visible && !item.locked &&
    x >= item.x && y >= item.y && x <= item.x + item.width && y <= item.y + item.height;
  const layer = (selectedLayer() && hit(selectedLayer()) ? selectedLayer() : null) ||
    [...scene.layers].reverse().find(hit);
  if (!layer) { selectedLayerId = ''; renderCustomEditor(); return; }
  selectedLayerId = layer.id;
  renderCustomEditor();
  const resize = x >= layer.x + layer.width - 30 && y >= layer.y + layer.height - 30;
  pointerDrag = { id: layer.id, x, y, original: { x: layer.x, y: layer.y, width: layer.width, height: layer.height }, resize };
  editorInteraction.setPointerCapture(event.pointerId);
});
editorInteraction.addEventListener('pointermove', (event) => {
  if (!pointerDrag) return;
  const layer = selectedLayer();
  if (!layer || layer.id !== pointerDrag.id) return;
  const { x, y } = pointerCanvasPosition(event);
  const dx = Math.round(x - pointerDrag.x), dy = Math.round(y - pointerDrag.y);
  if (pointerDrag.resize) {
    layer.width = Math.max(20, Math.min(3840, pointerDrag.original.width + dx));
    layer.height = Math.max(20, Math.min(2160, pointerDrag.original.height + dy));
  } else {
    layer.x = Math.max(-1920, Math.min(3840, pointerDrag.original.x + dx));
    layer.y = Math.max(-1080, Math.min(2160, pointerDrag.original.y + dy));
  }
  updateSelectionOutline();
});
function finishPointerDrag() {
  if (!pointerDrag) return;
  pointerDrag = null;
  renderCustomEditor();
  persistScenes();
}
editorInteraction.addEventListener('pointerup', finishPointerDrag);
editorInteraction.addEventListener('pointercancel', finishPointerDrag);
editorInteraction.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const scene = currentScene(); if (!scene?.custom) return;
  const { x, y } = pointerCanvasPosition(event);
  const layer = [...scene.layers].reverse().find((item) => item.visible && x >= item.x && y >= item.y && x <= item.x + item.width && y <= item.y + item.height);
  if (!layer) return;
  selectedLayerId = layer.id;
  renderCustomEditor();
  showLayerMenu(event);
});

const layerMenu = document.getElementById('layer-context-menu');
function showLayerMenu(event) {
  layerMenu.hidden = false;
  layerMenu.style.left = `${Math.min(event.clientX, window.innerWidth - layerMenu.offsetWidth - 8)}px`;
  layerMenu.style.top = `${Math.min(event.clientY, window.innerHeight - layerMenu.offsetHeight - 8)}px`;
  layerMenu.querySelector('[data-menu-action="edit"]').focus();
}
layerMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-menu-action]')?.dataset.menuAction;
  layerMenu.hidden = true;
  if (action === 'edit') layerProperties.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (action === 'duplicate') duplicateSelectedLayer();
  if (action === 'fit') document.getElementById('layer-fit').click();
  if (action === 'remove') document.getElementById('layer-remove').click();
});
document.addEventListener('pointerdown', (event) => {
  if (!layerMenu.contains(event.target)) layerMenu.hidden = true;
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') layerMenu.hidden = true; });

function showWorshipStyle() {
  const css = selectedLayer()?.sourceStyles?.[worshipStyleTarget.value] ?? worshipStyles?.[worshipStyleTarget.value] ?? '';
  worshipStyleCss.value = css;
  const style = document.createElement('div').style;
  style.cssText = css;
  const color = style.getPropertyValue('color').trim();
  worshipStyleColor.value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff';
  const size = style.getPropertyValue('font-size').trim().match(/^(\d+)px$/);
  worshipStyleSize.value = size ? size[1] : '';
  const font = style.getPropertyValue('font-family').replaceAll('"', '').trim();
  worshipStyleFont.value = [...worshipStyleFont.options].some((option) => option.value === font) ? font : '';
}

async function loadWorshipStyles(key) {
  const instance = instancesByKey.get(key);
  if (!instance?.styleAvailable) {
    worshipStyles = null;
    worshipStyleStatus.textContent = 'Source CSS is available when Worship connects.';
    return;
  }
  worshipStyleInstanceKey = key;
  worshipStyleStatus.textContent = 'Loading Worship styles…';
  try {
    const styles = await window.liturgiaStream.getWorshipStyles(key);
    if (worshipStyleInstanceKey !== key) return;
    worshipStyles = styles;
    showWorshipStyle();
    worshipStyleStatus.textContent = 'Worship defaults loaded. Your edits apply only to the selected source.';
  } catch (error) {
    worshipStyleStatus.textContent = `Could not load Worship styles: ${error.message}`;
  }
}

function updateWorshipStyleCss() {
  const update = (css, property, value) => {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|;)\\s*${escaped}\\s*:\\s*[^;]*;?`, 'i');
    if (!value) return css.replace(pattern, '$1').replace(/;\s*;/g, ';').trim();
    if (pattern.test(css)) return css.replace(pattern, (_, prefix) => `${prefix}${property}: ${value};`);
    const trimmed = css.trim();
    const separator = trimmed && !trimmed.endsWith(';') ? '; ' : trimmed ? ' ' : '';
    return `${trimmed}${separator}${property}: ${value};`;
  };
  let css = worshipStyleCss.value;
  css = update(css, 'color', worshipStyleColor.value);
  css = update(css, 'font-size', worshipStyleSize.value ? `${worshipStyleSize.value}px` : '');
  css = update(css, 'font-family', worshipStyleFont.value);
  worshipStyleCss.value = css;
}

worshipStyleTarget.addEventListener('change', showWorshipStyle);
for (const control of [worshipStyleColor, worshipStyleSize, worshipStyleFont]) {
  control.addEventListener('change', updateWorshipStyleCss);
}
function saveWorshipStyle(css) {
  const layer = selectedLayer();
  if (layer?.type !== 'program') {
    worshipStyleStatus.textContent = 'Select a Liturgia Program layer first.';
    return;
  }
  if (css.length > 8192) {
    worshipStyleStatus.textContent = 'Keep source CSS under 8192 characters.';
    return;
  }
  layer.sourceStyles ||= {};
  if (css.trim()) layer.sourceStyles[worshipStyleTarget.value] = css;
  else delete layer.sourceStyles[worshipStyleTarget.value];
  sendProgramSourceStyles(layer);
  showWorshipStyle();
  persistScenes();
  worshipStyleStatus.textContent = 'Style saved for this source only.';
}
document.getElementById('save-worship-style').addEventListener('click', () => {
  void saveWorshipStyle(worshipStyleCss.value);
});
document.getElementById('reset-worship-style').addEventListener('click', () => {
  void saveWorshipStyle('');
});

function connectToInstance(key) {
  const instance = instancesByKey.get(key);
  if (!instance) return;
  selectedInstanceKey = key;
  if (worshipStyleInstanceKey !== key) void loadWorshipStyles(key);
  headerStatus.classList.remove('connected');
  worshipStatus.textContent = 'Connecting to Liturgia Program';
  if (programSocket) programSocket.close();
  if (programFrame) programFrame.close();
  programFrame = null;
  updateProgramReceivers();
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
    if (programSocket === socket) renderInstances([...instancesByKey.values()]);
  };
  socket.onerror = () => {
    if (programSocket === socket) worshipStatus.textContent = 'Connecting to Liturgia Program';
  };
  socket.onclose = () => {
    if (programSocket !== socket || selectedInstanceKey !== key) return;
    programSocket = null;
    headerStatus.classList.remove('connected');
    worshipStatus.textContent = 'Reconnecting to Liturgia Program…';
    window.setTimeout(() => {
      if (selectedInstanceKey === key && instancesByKey.has(key)) connectToInstance(key);
    }, 1500);
  };
}

function renderInstances(items) {
  instancesByKey.clear();
  for (const item of items) instancesByKey.set(item.key, item);
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

  const programConnected = !!selectedInstanceKey && programSocket?.readyState === WebSocket.OPEN;
  headerStatus.classList.toggle('connected', programConnected);
  worshipStatus.textContent = programConnected
    ? 'Liturgia Program connected'
    : list.length
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
    button.textContent = selectedInstanceKey === instance.key && programSocket?.readyState === WebSocket.OPEN
      ? 'Connected' : 'Connect';
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
let outputSilentSource = null;
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
  if (outputSilentSource) outputSilentSource.stop();
  outputSilentSource = null;
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
  if (sceneHasSource(scene, 'camera') && !cameraStream) await ensureCameraReady();
  if (sceneHasSource(scene, 'program') && (scene.custom
    ? !scene.layers.some((layer) => layer.type === 'program' && layer.visible && programReceivers.get(layer.id)?.frame)
    : !programFrame)) throw new Error('Waiting for Liturgia Program video. Make sure Worship is presenting.');
  if (selectedDevices.microphoneId) await ensureMicrophoneReady();

  outputCanvasStream = preview.captureStream(currentOutputConfig.fps);
  outputAudioContext = new AudioContext({ sampleRate: currentOutputConfig.audioSampleRate });
  await outputAudioContext.resume();
  const destination = outputAudioContext.createMediaStreamDestination();
  if (audioStream) {
    outputAudioContext.createMediaStreamSource(audioStream).connect(destination);
  } else {
    outputSilentSource = outputAudioContext.createConstantSource();
    const silence = outputAudioContext.createGain();
    silence.gain.value = 0;
    outputSilentSource.connect(silence).connect(destination);
    outputSilentSource.start();
  }
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
    const rejected = /Error opening output|Error opening output files|IO error: End of file/i.test(status.error || '');
    if (rejected) streamStatusLabel.textContent = 'Destination disconnected';
    streamStatusDetail.textContent = rejected
      ? `The streaming service closed the connection. Check that your stream key and broadcast session are current.${delay}`
      : `Reconnecting…${delay}`;
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

async function checkLiveReadiness() {
  const config = await window.liturgiaStream.getConfig();
  if (!config.destination?.keySaved) throw new Error('Save an RTMP or RTMPS destination and stream key first.');
  const scene = currentScene();
  if (!scene || (scene.custom ? !scene.layers.some((layer) => layer.visible) : !scene.cameraVisible && !scene.programVisible)) throw new Error('Choose a scene with a visible source.');
  if (sceneHasSource(scene, 'camera') && !selectedDevices.cameraId) {
    throw new Error('This scene needs a camera. Select one on Video Devices, or choose Liturgia Fullscreen on Scenes.');
  }
  if (sceneHasSource(scene, 'program') && (scene.custom
    ? !scene.layers.some((layer) => layer.type === 'program' && layer.visible && programReceivers.get(layer.id)?.frame)
    : !programFrame)) throw new Error('Waiting for Liturgia Program video. Make sure Worship is presenting.');
  return config;
}

async function startLiveStream(config) {
  const scene = currentScene();
  if (sceneHasSource(scene, 'camera')) await ensureCameraReady();
  if (selectedDevices.microphoneId) await ensureMicrophoneReady();
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
  let config;
  try {
    config = await checkLiveReadiness();
  } catch (error) {
    streamStatusDetail.textContent = error.message;
    return;
  }
  if (!window.confirm('Start streaming now?')) return;
  goLiveButton.disabled = true;
  try {
    await startLiveStream(config);
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
