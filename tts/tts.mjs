#!/usr/bin/env node
/**
 * tts.mjs — zero-dependency Chinese TTS for this environment (Node 24 builtins only).
 *
 * Engines (auto-ordered best quality first):
 *   edge   - Microsoft Edge ReadAloud neural voices (zh-CN-YunxiNeural ...), raw TLS + hand-rolled RFC6455
 *   gtts   - Google Translate TTS (zh-CN), <=200 chars per request
 *   baidu  - fanyi.baidu.com/gettts (zh female)
 *
 * API
 *   synthesize(text, { voice, outPath, rate, pitch, volume, engine, timeoutMs })
 *     -> { bytes, durationSec, engine, voice, chunks, warnings, outPath }
 *   mp3Duration(buf) -> { durationSec, frames, sampleRate, bitrateKbps }
 *
 * CLI
 *   node tts.mjs --text "<中文>" --out out.mp3 [--voice zh-CN-YunxiNeural] [--engine auto|edge|gtts|baidu]
 *   node tts.mjs "<中文>" out.mp3 [voice]
 */
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecMsGec, TRUSTED_CLIENT_TOKEN } from './drm.mjs';

const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = '2-' + CHROMIUM_FULL_VERSION;
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export const DEFAULT_VOICE = 'zh-CN-YunxiNeural';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const noDashUuid = () => crypto.randomUUID().replace(/-/g, '');
const isoTs = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/* ================================================================== */
/* Minimal RFC6455 client on top of an upgraded TLS socket             */
/* ================================================================== */
function encodeFrame(opcode, payload, mask = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, body]);
}

class RawWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.frag = null;
    this.onmessage = null;
    this.onclose = null;
    const bump = (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.drain();
    };
    socket.on('data', bump);
    socket.on('close', () => this.shutdown());
    socket.on('end', () => this.shutdown());
    socket.on('error', () => this.shutdown());
  }
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = this.buf.readUInt32BE(2) * 4294967296 + this.buf.readUInt32BE(6);
        off = 10;
      }
      let key = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        key = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (key) {
        const plain = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) plain[i] = payload[i] ^ key[i & 3];
        payload = plain;
      }
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) {
        try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch {}
        try { this.socket.destroy(); } catch {}
        this.shutdown();
        return;
      }
      if (opcode === 0x9) {
        try { this.socket.write(encodeFrame(0xa, payload)); } catch {}
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        if (!this.frag) continue;
        this.frag.parts.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.frag.parts);
          const op = this.frag.opcode;
          this.frag = null;
          this.onmessage?.(op, whole);
        }
        continue;
      }
      if (!fin) {
        this.frag = { opcode, parts: [payload] };
        continue;
      }
      this.onmessage?.(opcode, payload);
    }
  }
  sendText(str) {
    if (!this.closed) this.socket.write(encodeFrame(0x1, Buffer.from(str, 'utf8')));
  }
  close() {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch {}
    try { this.socket.destroy(); } catch {}
    this.shutdown();
  }
}

function openEdgeSocket({ timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(WSS_URL);
    const query =
      '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN +
      '&ConnectionId=' + noDashUuid() +
      '&Sec-MS-GEC=' + generateSecMsGec() +
      '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION;
    const req = https.request({
      host: url.hostname,
      port: 443,
      path: url.pathname + query,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: ORIGIN,
        'User-Agent': EDGE_UA,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        Cookie: 'muid=' + crypto.randomBytes(16).toString('hex').toUpperCase() + ';',
      },
      servername: url.hostname,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch {}
      reject(new Error('edge handshake timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    req.on('upgrade', (res, socket, head) => {
      if (settled) { socket.destroy(); return; }
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      const ws = new RawWebSocket(socket);
      if (head?.length) { ws.buf = Buffer.concat([ws.buf, head]); ws.drain(); }
      resolve(ws);
    });
    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 300) body += c; });
      res.on('end', () => reject(new Error(
        'edge handshake refused: HTTP ' + res.statusCode +
        (res.headers['x-msedge-ref'] ? ' [' + res.headers['x-msedge-ref'] + ']' : '') +
        (body ? ' ' + body : ''))));
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

/* ================================================================== */
/* Edge neural engine                                                  */
/* ================================================================== */
const xmlEscape = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function buildSsml(text, voice, rate, pitch, volume) {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
    "<voice name='" + voice + "'>" +
    "<prosody pitch='" + pitch + "' rate='" + rate + "' volume='" + volume + "'>" +
    xmlEscape(text) + '</prosody></voice></speak>';
}

const SPEECH_CONFIG = JSON.stringify({
  context: {
    synthesis: {
      audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
        outputFormat: OUTPUT_FORMAT,
      },
    },
  },
});

async function edgeSynthChunk(text, { voice, rate, pitch, volume, timeoutMs }) {
  const ws = await openEdgeSocket({ timeoutMs: Math.min(timeoutMs, 20000) });
  const chunks = [];
  let serverError = null;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        'edge synth timeout after ' + timeoutMs + 'ms (partial ' + Buffer.concat(chunks).length + 'B)')), timeoutMs);
      ws.onmessage = (opcode, payload) => {
        if (opcode === 0x1) {
          const s = payload.toString('utf8');
          if (s.includes('Path:turn.end')) { clearTimeout(timer); resolve(); }
          else if (s.includes('Path:error')) serverError = new Error('edge error frame: ' + s.slice(0, 250));
          return;
        }
        if (opcode !== 0x2 || payload.length < 2) return;
        const headerLen = payload.readUInt16BE(0);
        if (payload.length < 2 + headerLen + 2) return;
        const header = payload.subarray(2, 2 + headerLen).toString('utf8');
        if (header.includes('Path:audio')) chunks.push(Buffer.from(payload.subarray(2 + headerLen)));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (Buffer.concat(chunks).length) resolve();
        else reject(serverError || new Error('edge closed before audio'));
      };
      ws.sendText('X-Timestamp:' + isoTs() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + SPEECH_CONFIG);
      ws.sendText('X-RequestId:' + noDashUuid() + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + isoTs() +
        '\r\nPath:ssml\r\n\r\n' + buildSsml(text, voice, rate, pitch, volume));
    });
  } finally {
    ws.close();
  }
  const audio = Buffer.concat(chunks);
  if (!audio.length) throw serverError || new Error('edge returned no audio');
  return audio;
}

async function edgeSynthesize(text, opts, report) {
  const parts = splitForTts(text, 1800);
  const bufs = [];
  for (const part of parts) {
    bufs.push(await edgeSynthChunk(part, opts));
    report.chunks++;
  }
  return Buffer.concat(bufs);
}

/* ================================================================== */
/* HTTP helpers + free fallback engines                                */
/* ================================================================== */
function httpGetBuffer(url, { headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': BROWSER_UA, ...headers } }, (res) => {
      const acc = [];
      res.on('data', (d) => acc.push(d));
      res.on('end', () => {
        const body = Buffer.concat(acc);
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' ' + body.subarray(0, 160).toString('utf8')));
          return;
        }
        resolve(body);
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout ' + timeoutMs + 'ms')));
    req.on('error', reject);
    req.end();
  });
}

async function gttsSynthesize(text, opts, report) {
  const parts = splitForTts(text, 120);
  const bufs = [];
  for (let i = 0; i < parts.length; i++) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
      '&tl=zh-CN&ttsspeed=1&total=' + parts.length + '&idx=' + i +
      '&textlen=' + parts[i].length + '&q=' + encodeURIComponent(parts[i]);
    const body = await httpGetBuffer(url, { headers: { Referer: 'https://translate.google.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    if (body.length < 200) throw new Error('gtts returned only ' + body.length + ' bytes');
    bufs.push(stripId3(body));
    report.chunks++;
  }
  return Buffer.concat(bufs);
}

async function baiduSynthesize(text, opts, report) {
  const parts = splitForTts(text, 200);
  const bufs = [];
  for (const part of parts) {
    const url = 'https://fanyi.baidu.com/gettts?lan=zh&spd=5&source=web&text=' + encodeURIComponent(part);
    const body = await httpGetBuffer(url, { headers: { Referer: 'https://fanyi.baidu.com/' } });
    if (body.length < 200) throw new Error('baidu returned only ' + body.length + ' bytes');
    bufs.push(stripId3(body));
    report.chunks++;
  }
  return Buffer.concat(bufs);
}

function stripId3(b) {
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return b.subarray(10 + size);
  }
  return b;
}

/* ================================================================== */
/* Text chunking (sentence aware)                                      */
/* ================================================================== */
const HARD_BREAK = /[。！？；!?;\n…]/;
const SOFT_BREAK = /[，、,：:—]/;

export function splitForTts(text, maxLen = 1800) {
  const clean = String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const ch of clean) {
    cur += ch;
    if (cur.length >= maxLen && HARD_BREAK.test(ch)) { flush(); continue; }
    if (cur.length >= maxLen * 0.7 && SOFT_BREAK.test(ch)) flush();
  }
  flush();
  const final = [];
  for (const s of out) {
    for (let i = 0; i < s.length; i += maxLen) final.push(s.slice(i, i + maxLen));
  }
  return final.filter(Boolean);
}

/* ================================================================== */
/* MP3 duration from frame headers (no ffmpeg needed)                  */
/* ================================================================== */
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function mp3Duration(buf) {
  let p = 0;
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    p = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  let seconds = 0, frames = 0, sampleRate = 0, bitrateKbps = 0;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) { p++; continue; }
    const verBits = (buf[p + 1] >> 3) & 0x03;
    const layerBits = (buf[p + 1] >> 1) & 0x03;
    const brIdx = (buf[p + 2] >> 4) & 0x0f;
    const srIdx = (buf[p + 2] >> 2) & 0x03;
    if (verBits === 1 || layerBits !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) { p++; continue; }
    const mpeg1 = verBits === 3;
    const br = (mpeg1 ? BITRATE_V1_L3 : BITRATE_V2_L3)[brIdx];
    const sr = SAMPLE_RATES[verBits][srIdx];
    const padding = (buf[p + 2] >> 1) & 0x01;
    const spf = mpeg1 ? 1152 : 576;
    const frameLen = Math.floor((spf / 8) * (br * 1000) / sr) + padding;
    if (frameLen <= 4) break;
    seconds += spf / sr;
    frames++;
    sampleRate = sr;
    bitrateKbps = br;
    p += frameLen;
  }
  return {
    durationSec: Math.round(seconds * 1000) / 1000,
    frames,
    sampleRate,
    bitrateKbps,
  };
}

/* ================================================================== */
/* Public API                                                          */
/* ================================================================== */
const ENGINES = {
  edge: edgeSynthesize,
  gtts: gttsSynthesize,
  baidu: baiduSynthesize,
};

export async function synthesize(text, opts = {}) {
  const {
    voice = DEFAULT_VOICE,
    outPath = null,
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    engine = 'auto',
    timeoutMs = 60000,
  } = opts;

  if (!String(text || '').trim()) throw new Error('synthesize: empty text');

  const order = engine === 'auto' ? ['edge', 'gtts', 'baidu'] : [engine];
  const failures = [];
  let audio = null;
  let used = null;
  let chunks = 0;

  for (const name of order) {
    const fn = ENGINES[name];
    if (!fn) throw new Error('unknown engine: ' + name);
    const report = { chunks: 0 };
    try {
      audio = await fn(text, { voice, rate, pitch, volume, timeoutMs }, report);
      used = name;
      chunks = report.chunks;
      break;
    } catch (err) {
      failures.push(name + ': ' + (err?.message || String(err)));
    }
  }
  if (!audio) {
    const err = new Error('all TTS engines failed -> ' + failures.join(' | '));
    err.failures = failures;
    throw err;
  }

  let writtenTo = outPath;
  if (outPath) {
    writtenTo = path.resolve(outPath);
    fs.mkdirSync(path.dirname(writtenTo), { recursive: true });
    fs.writeFileSync(writtenTo, audio);
  }
  const { durationSec, sampleRate, bitrateKbps } = mp3Duration(audio);
  return {
    bytes: audio.length,
    durationSec,
    engine: used,
    voice: used === 'edge' ? voice : undefined,
    chunks,
    sampleRate,
    bitrateKbps,
    warnings: failures,
    outPath: writtenTo ? path.resolve(writtenTo) : null,
  };
}

export default { synthesize, mp3Duration, splitForTts };

/* ================================================================== */
/* CLI                                                                 */
/* ================================================================== */
const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[++i];
      if (key === 'text') opts.text = val;
      else if (key === 'out') opts.outPath = val;
      else if (key === 'voice') opts.voice = val;
      else if (key === 'engine') opts.engine = val;
      else if (key === 'rate') opts.rate = val;
      else if (key === 'pitch') opts.pitch = val;
      else if (key === 'volume') opts.volume = val;
    } else positional.push(a);
  }
  const text = opts.text ?? positional[0];
  const outPath = opts.outPath ?? positional[1] ?? 'tts_out.mp3';
  const voice = opts.voice ?? positional[2];
  if (!text) {
    console.error('usage: node tts.mjs --text "<中文>" --out out.mp3 [--voice zh-CN-YunxiNeural] [--engine auto|edge|gtts|baidu]');
    process.exit(2);
  }
  synthesize(text, { ...opts, voice: voice || DEFAULT_VOICE, outPath })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('FAILED: ' + e.message);
      process.exit(1);
    });
}
