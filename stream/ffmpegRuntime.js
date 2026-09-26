'use strict';

const { execFile } = require('child_process');
const path = require('path');

const ENCODER_PREFERENCE = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC' },
  { id: 'h264_qsv', label: 'Intel Quick Sync' },
  { id: 'h264_amf', label: 'AMD AMF' },
  { id: 'libx264', label: 'Software H.264' }
];

function parseAvailableEncoders(output) {
  const encoders = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*[VAS\.D]{6}\s+([\w]+)\s+/);
    if (match) encoders.add(match[1]);
  }
  return encoders;
}

function choosePreferredEncoder(encoders) {
  return ENCODER_PREFERENCE.find((encoder) => encoders.has(encoder.id)) || null;
}

function executableCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const binaryName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  if (options.configuredPath) candidates.push(options.configuredPath);
  if (options.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, 'ffmpeg', binaryName));
    candidates.push(path.join(options.resourcesPath, binaryName));
  }
  if (options.appPath) candidates.push(path.join(options.appPath, 'ffmpeg', binaryName));
  candidates.push(binaryName);
  return [...new Set(candidates)];
}

function runEncoderProbe(executablePath, execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(executablePath, ['-hide_banner', '-encoders'], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 5 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ available: false, executablePath, encoder: null, supported: [], error: error.message });
        return;
      }
      const encoders = parseAvailableEncoders(String(stdout || '') + '\n' + String(stderr || ''));
      const supported = ENCODER_PREFERENCE.filter((encoder) => encoders.has(encoder.id));
      const preferred = choosePreferredEncoder(encoders);
      resolve({
        available: true,
        executablePath,
        encoder: preferred,
        supported: supported.map((item) => ({ ...item })),
        error: preferred ? null : 'This FFmpeg build has no H.264 encoder.'
      });
    });
  });
}

function buildRtmpUrl(server, streamKey) {
  const value = new URL(String(server || ''));
  if (!['rtmp:', 'rtmps:'].includes(value.protocol) || !value.hostname || value.username || value.password || value.search || value.hash) {
    throw new Error('Enter a valid RTMP or RTMPS server without credentials or query parameters.');
  }
  const key = String(streamKey || '').trim();
  if (!key) throw new Error('Enter a stream key.');
  value.pathname = value.pathname.replace(/\/+$/, '') + '/' + encodeURIComponent(key);
  return value.toString();
}

function buildOutputArgs(options) {
  const fps = Number(options.fps) || 30;
  const videoBitrate = Number(options.videoBitrateKbps) || 6000;
  const audioBitrate = Number(options.audioBitrateKbps) || 160;
  const keyframeInterval = Math.max(1, Math.round(fps * 2));
  const encoder = options.encoder || 'libx264';
  const args = [
    '-map', '0:v:0', '-map', '1:a:0',
    '-r', String(fps),
    '-c:v', encoder,
    '-b:v', `${videoBitrate}k`,
    '-minrate', `${videoBitrate}k`,
    '-maxrate', `${videoBitrate}k`,
    '-bufsize', `${videoBitrate * 2}k`,
    '-g', String(keyframeInterval),
    '-keyint_min', String(keyframeInterval),
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${audioBitrate}k`,
    '-ar', String(Number(options.audioSampleRate) || 48000),
    '-ac', '2',
    '-f', 'flv',
    options.outputUrl
  ];
  if (encoder === 'h264_nvenc') args.splice(6, 0, '-preset', 'p4', '-rc', 'cbr', '-zerolatency', '1');
  else if (encoder === 'h264_qsv') args.splice(6, 0, '-preset', 'medium');
  else if (encoder === 'h264_amf') args.splice(6, 0, '-quality', 'speed', '-rc', 'cbr');
  else args.splice(6, 0, '-preset', 'veryfast', '-tune', 'zerolatency');
  return args;
}

function probeFirstAvailable(candidates, execFileImpl = execFile) {
  return new Promise(async (resolve) => {
    for (const candidate of candidates) {
      const result = await runEncoderProbe(candidate, execFileImpl);
      if (result.available && result.encoder) {
        resolve(result);
        return;
      }
    }
    resolve({
      available: false,
      executablePath: null,
      encoder: null,
      supported: [],
      error: 'FFmpeg was not found. Install the FFmpeg runtime or include it with Liturgia Stream.'
    });
  });
}

module.exports = {
  ENCODER_PREFERENCE,
  parseAvailableEncoders,
  choosePreferredEncoder,
  executableCandidates,
  buildRtmpUrl,
  buildOutputArgs,
  runEncoderProbe,
  probeFirstAvailable
};
