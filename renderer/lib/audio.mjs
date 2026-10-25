// Procedural BGM + WAV writer (node: builtins only, no audio libraries, no downloads)
import fs from 'node:fs';

export function writeWav16(file, L, R, sr) {
  const n = L.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    const r = Math.max(-1, Math.min(1, R[i]));
    data.writeInt16LE(Math.round(l * 32767), i * 4);
    data.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

// one note: additive partials, linear attack, exponential release, constant-power pan
function addTone(L, R, sr, startSec, totalSec, freq, lenSec, o) {
  const start = Math.floor(startSec * sr);
  const len = Math.floor(lenSec * sr);
  const attack = Math.max(0.001, o.attack || 0.01) * sr;
  const release = Math.max(0.001, o.release || 0.2) * sr;
  const amp = o.amp === undefined ? 0.1 : o.amp;
  const harm = o.harm || [1];
  const detune = o.detune || 0;
  const pan = o.pan || 0;
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  const w = 2 * Math.PI / sr;
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= L.length) continue;
    const t = i / sr;
    let env = 1;
    if (i < attack) env = i / attack;
    const tailStart = len - release;
    if (i > tailStart) env *= Math.max(0, (len - i) / release);
    if (env <= 0) continue;
    let s = 0;
    for (let h = 0; h < harm.length; h++) {
      const f = freq * (h + 1) * (h === 0 ? 1 : 1 + detune);
      s += harm[h] * Math.sin(w * f * t + h * 0.7);
    }
    const v = s * env * amp;
    L[idx] += v * gl;
    R[idx] += v * gr;
  }
}

export function synthBgm(cfg) {
  const sr = cfg.sr || 48000;
  const dur = cfg.durationSec;
  const n = Math.max(1, Math.ceil(dur * sr));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const chords = [
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
    [261.63, 329.63, 392.0],
    [196.0, 246.94, 293.66],
  ];
  const bar = 3.2;
  const bars = Math.ceil(dur / bar) + 1;
  const pattern = [0, 1, 2, 1, 0, 2, 1, 2];

  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    if (t0 >= dur) break;
    const ch = chords[b % 4];
    for (let k = 0; k < 3; k++) {
      addTone(L, R, sr, t0, dur, ch[k] * (k === 0 ? 0.5 : 1), bar + 0.5, {
        attack: 0.65, release: 1.0, amp: 0.055, harm: [1, 0.32, 0.12], detune: 0.0016,
        pan: (k - 1) * 0.22,
      });
    }
    addTone(L, R, sr, t0, dur, ch[0] / 4, bar + 0.3, { attack: 0.5, release: 0.8, amp: 0.09, harm: [1, 0.2], pan: 0 });
    for (let s = 0; s < 8; s++) {
      const st = t0 + s * 0.4;
      if (st >= dur) break;
      const f = ch[pattern[s] % 3] * 2;
      addTone(L, R, sr, st, dur, f, 0.62, {
        attack: 0.008, release: 0.5, amp: 0.05, harm: [1, 0.18], pan: s % 2 === 0 ? -0.35 : 0.35,
      });
    }
  }

  // airy noise wash, one-pole smoothed
  let st = 0x9e3779b9;
  const rnd = () => {
    st ^= st << 13; st >>>= 0;
    st ^= st >>> 17;
    st ^= st << 5; st >>>= 0;
    return (st / 4294967296) * 2 - 1;
  };
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.012 * (rnd() - lp);
    const t = i / sr;
    const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.06 * t);
    const v = lp * 0.05 * (0.4 + 0.6 * lfo);
    L[i] += v;
    R[i] += v * 0.85;
  }

  // gentle master lowpass + normalize + fades
  const cut = 1 - Math.exp((-2 * Math.PI * 5200) / sr);
  let lpL = 0;
  let lpR = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    lpL += cut * (L[i] - lpL);
    lpR += cut * (R[i] - lpR);
    L[i] = lpL;
    R[i] = lpR;
    const m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (m > peak) peak = m;
  }
  const gain = peak > 0 ? 0.55 / peak : 1;
  const fadeIn = Math.min(1.2 * sr, n * 0.1);
  const fadeOut = Math.min(2.2 * sr, n * 0.2);
  for (let i = 0; i < n; i++) {
    let e = gain;
    if (i < fadeIn) e *= i / fadeIn;
    const tail = n - i;
    if (tail < fadeOut) e *= tail / fadeOut;
    L[i] *= e;
    R[i] *= e;
  }

  let finalPeak = 0;
  for (let i = 0; i < n; i++) finalPeak = Math.max(finalPeak, Math.abs(L[i]), Math.abs(R[i]));
  return { L: L, R: R, sr: sr, peak: finalPeak };
}

export function writeBgm(file, cfg) {
  const res = synthBgm(cfg);
  writeWav16(file, res.L, res.R, res.sr);
  return { file: file, peak: res.peak, durationSec: cfg.durationSec };
}
