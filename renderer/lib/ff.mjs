// ffmpeg invocation helpers. Two environment facts are baked in here:
//  1. spawning with piped stdio is denied (EPERM) in this sandbox, so every child gets a
//     real file descriptor for stdout/stderr and the log is read back afterwards;
//  2. the bundled ffmpeg 6.0 essentials build ships NO ffprobe.exe, so probing parses the
//     "ffmpeg -i" banner instead.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function makeRunner(cfg) {
  const ffmpeg = cfg.ffmpeg;
  const cwd = cfg.cwd;
  const logDir = cfg.logDir || cwd;
  const quiet = Boolean(cfg.quiet);
  fs.mkdirSync(logDir, { recursive: true });

  return function run(args, label) {
    const tag = String(label || 'ffmpeg').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const logPath = path.join(logDir, tag + '.log');
    const full = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-y'].concat(args);
    const fd = fs.openSync(logPath, 'w');
    let res;
    try {
      res = spawnSync(ffmpeg, full, { cwd: cwd, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    if (res.error) throw new Error('[' + tag + '] spawn failed: ' + res.error.message);
    if (res.status !== 0) {
      const tail = logText.trim().split('\n').slice(-10).join('\n');
      throw new Error('[' + tag + '] ffmpeg exit ' + res.status + '\n' + tail);
    }
    if (!quiet && logText.trim()) {
      const tail = logText.trim().split('\n').slice(-2).join('\n');
      process.stderr.write('[' + tag + '] ' + tail + '\n');
    }
    return { status: res.status, log: logText };
  };
}

// Escape a path for a filter-option value inside a filter_complex_script.
// Only ":" terminates an option, so it is the one char that must be escaped.
export function fesc(p) {
  return "'" + String(p).replace(/\\/g, '/').replace(/:/g, '\\:') + "'";
}

// Escape a relative path (no drive colon) for a filter-option value.
export function frel(p) {
  return "'" + String(p).replace(/\\/g, '/') + "'";
}

export function probe(cfg) {
  const logPath = path.join(cfg.logDir || cfg.cwd || '.', 'probe.log');
  const fd = fs.openSync(logPath, 'w');
  let res;
  try {
    res = spawnSync(cfg.ffmpeg, ['-hide_banner', '-i', cfg.file], {
      cwd: cfg.cwd, stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const lines = text.split('\n');
  const dm = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  const bm = text.match(/bitrate:\s*(\d+)\s*kb\/s/);
  const videoLine = (lines.find((l) => /Stream #\S+.*: Video:/.test(l)) || '').trim();
  const audioLine = (lines.find((l) => /Stream #\S+.*: Audio:/.test(l)) || '').trim();
  const size = videoLine.match(/(\d{3,5})x(\d{3,5})/);
  const fps = videoLine.match(/([\d.]+)\s*fps/);
  const rate = audioLine.match(/(\d+)\s*Hz,\s*([^,]+)/);
  const abr = audioLine.match(/(\d+)\s*kb\/s/);
  return {
    file: cfg.file,
    probedBy: 'ffmpeg -i (no ffprobe.exe in the bundled build)',
    durationSec: dm ? Math.round(((+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3])) * 1000) / 1000 : null,
    overallBitrateKbps: bm ? +bm[1] : null,
    video: videoLine
      ? {
          codec: (videoLine.match(/Video:\s*([^,\s]+)/) || [])[1] || null,
          width: size ? +size[1] : null,
          height: size ? +size[2] : null,
          fps: fps ? parseFloat(fps[1]) : null,
          line: videoLine,
        }
      : null,
    audio: audioLine
      ? {
          codec: (audioLine.match(/Audio:\s*([^,\s]+)/) || [])[1] || null,
          sampleRate: rate ? +rate[1] : null,
          channels: rate ? rate[2].trim() : null,
          bitrateKbps: abr ? +abr[1] : null,
          line: audioLine,
        }
      : null,
    hasAudio: Boolean(audioLine),
    streamLines: lines.filter((l) => /Duration:|Stream #|Stream mapping/.test(l)).map((l) => l.trim()),
    exitStatus: res.status,
  };
}
