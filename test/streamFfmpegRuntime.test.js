const path = require('path');
const {
  parseAvailableEncoders,
  choosePreferredEncoder,
  executableCandidates,
  buildRtmpUrl,
  buildOutputArgs,
  runEncoderProbe,
  probeFirstAvailable
} = require('../stream/ffmpegRuntime');

describe('Liturgia Stream FFmpeg runtime', () => {
  test('detects H.264 encoders and honors hardware preference order', () => {
    const encoders = parseAvailableEncoders([
      ' V....D libx264       H.264 / AVC',
      ' V..... h264_qsv       Intel Quick Sync',
      ' V....D h264_amf       AMD AMF',
      ' V....D h264_nvenc     NVIDIA NVENC'
    ].join('\n'));
    expect([...encoders]).toEqual(['libx264', 'h264_qsv', 'h264_amf', 'h264_nvenc']);
    expect(choosePreferredEncoder(encoders)).toEqual({ id: 'h264_nvenc', label: 'NVIDIA NVENC' });
  });

  test('falls back to software H.264 when hardware encoders are absent', () => {
    expect(choosePreferredEncoder(new Set(['h264_amf', 'libx264']))).toEqual({ id: 'h264_amf', label: 'AMD AMF' });
    expect(choosePreferredEncoder(new Set(['libx264']))).toEqual({ id: 'libx264', label: 'Software H.264' });
    expect(choosePreferredEncoder(new Set())).toBeNull();
  });

  test('checks configured and packaged Windows paths before PATH lookup', () => {
    expect(executableCandidates({
      platform: 'win32',
      configuredPath: 'D:\\tools\\ffmpeg.exe',
      resourcesPath: 'C:\\Liturgia\\resources',
      appPath: 'C:\\Liturgia\\app'
    })).toEqual([
      'D:\\tools\\ffmpeg.exe',
      path.join('C:\\Liturgia\\resources', 'ffmpeg', 'ffmpeg.exe'),
      path.join('C:\\Liturgia\\resources', 'ffmpeg.exe'),
      path.join('C:\\Liturgia\\app', 'ffmpeg', 'ffmpeg.exe'),
      'ffmpeg.exe'
    ]);
  });

  test('reports supported encoders from an FFmpeg probe', async () => {
    const mockExecFile = (_file, _args, _options, callback) => {
      callback(null, ' V....D libx264 H.264\n V....D h264_nvenc NVIDIA encoder', '');
    };
    const result = await runEncoderProbe('ffmpeg.exe', mockExecFile);
    expect(result.available).toBe(true);
    expect(result.encoder).toEqual({ id: 'h264_nvenc', label: 'NVIDIA NVENC' });
    expect(result.supported.map((encoder) => encoder.id)).toEqual(['h264_nvenc', 'libx264']);
  });

  test('continues candidate search when FFmpeg has no supported H.264 encoder', async () => {
    const calls = [];
    const mockExecFile = (file, _args, _options, callback) => {
      calls.push(file);
      if (file === 'no-h264.exe') callback(null, ' V....D mpeg4 MPEG-4', '');
      else callback(null, ' V....D libx264 H.264', '');
    };
    const result = await probeFirstAvailable(['no-h264.exe', 'working.exe'], mockExecFile);
    expect(calls).toEqual(['no-h264.exe', 'working.exe']);
    expect(result.encoder.id).toBe('libx264');
  });

  test('builds RTMP and RTMPS destinations safely', () => {
    expect(buildRtmpUrl('rtmps://stream.example/live/', 'abc/key')).toBe('rtmps://stream.example/live/abc%2Fkey');
    expect(buildRtmpUrl('rtmp://stream.example/live', 'abc123')).toBe('rtmp://stream.example/live/abc123');
    expect(() => buildRtmpUrl('https://stream.example/live', 'abc')).toThrow();
    expect(() => buildRtmpUrl('rtmps://user@stream.example/live', 'abc')).toThrow();
    expect(() => buildRtmpUrl('rtmps://stream.example/live?token=x', 'abc')).toThrow();
    expect(() => buildRtmpUrl('rtmps://stream.example/live', '')).toThrow();
  });

  test('builds default CBR H.264/AAC output arguments', () => {
    const args = buildOutputArgs({
      fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 160,
      audioSampleRate: 48000, encoder: 'libx264', outputUrl: 'rtmps://example/live/key'
    });
    expect(args).toEqual(expect.arrayContaining([
      '-r', '30', '-c:v', 'libx264', '-b:v', '6000k',
      '-minrate', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
      '-g', '60', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-f', 'flv',
      'rtmps://example/live/key'
    ]));
  });
});
