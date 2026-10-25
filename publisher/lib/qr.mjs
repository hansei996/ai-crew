import zlib from "node:zlib";
// Zero-dependency QR Code encoder (byte mode, EC level M, versions 1..10) + PNG renderer.
// Structural reference: ISO/IEC 18004 tables. Used only to render the bilibili login QR locally.

const SPEC = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsEcc(data, ecLen) {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

function dataCodewordCount(version) {
  const s = SPEC[version];
  return s.groups.reduce((acc, [cnt, len]) => acc + cnt * len, 0);
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const bits = dataCodewordCount(v) * 8;
    const cc = v < 10 ? 8 : 16;
    if (4 + cc + byteLen * 8 <= bits) return v;
  }
  throw new Error("payload too large for QR versions 1-10 at ECC M");
}

function buildCodewords(bytes, version) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = dataCodewordCount(version) * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dc = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dc.push(v);
  }
  const pad = [0xec, 0x11];
  let k = 0;
  while (dc.length < dataCodewordCount(version)) dc.push(pad[k++ % 2]);
  return dc;
}

function interleave(dc, version) {
  const { ec, groups } = SPEC[version];
  const blocks = [];
  let offset = 0;
  for (const [cnt, len] of groups) {
    for (let i = 0; i < cnt; i++) {
      const d = dc.slice(offset, offset + len);
      offset += len;
      blocks.push({ data: d, ecc: rsEcc(d, ec) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

function newMatrix(size) {
  const m = [];
  for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
  return m;
}

function placeFunctionPatterns(m, version) {
  const size = m.length;
  const setF = (r, c, v) => { m[r][c] = v; };

  for (let i = 0; i < size; i++) {
    setF(6, i, i % 2 === 0 ? 1 : 0);
    setF(i, 6, i % 2 === 0 ? 1 : 0);
  }

  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        let v = 0;
        if (inRing) {
          const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          v = ring === 2 ? 0 : 1;
        }
        setF(r, c, v);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  const al = ALIGN[version];
  for (const r of al) {
    for (const c of al) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setF(r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  // Reserve format areas (filled later by applyFormatInfo).
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = size - 8; i < size; i++) {
    m[8][i] = 0;
    m[i][8] = 0;
  }
  m[size - 8][8] = 1;
}

function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1f25);
  return (version << 12) | rem;
}

function placeVersionInfo(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

function formatBits(mask) {
  // EC level M = 0b00
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function applyFormatInfo(m, mask) {
  const size = m.length;
  const bits = formatBits(mask);
  const bit = (i) => (bits >> (14 - i)) & 1;
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = bit(i);
  m[size - 8][8] = 1;
}

function placeData(m, codewords) {
  const size = m.length;
  let bitIdx = 0;
  let dir = -1;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = dir < 0 ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (m[row][c] !== null) continue;
        const byte = codewords[bitIdx >> 3] ?? 0;
        m[row][c] = (byte >> (7 - (bitIdx & 7))) & 1;
        bitIdx++;
      }
    }
    dir = -dir;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  const fn = MASKS[mask];
  const out = m.map((row) => row.slice());
  for (let r = 0; r < out.length; r++) {
    for (let c = 0; c < out.length; c++) {
      if (isFunctionModule(r, c, out.length)) continue;
      if (fn(r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

let FUNC_CACHE = new Map();
function isFunctionModule(r, c, size) {
  const key = size;
  let map = FUNC_CACHE.get(key);
  if (!map) {
    const template = newMatrix(size);
    placeFunctionPatterns(template, (size - 17) / 4);
    placeVersionInfo(template, (size - 17) / 4);
    map = template.map((row) => row.map((v) => v !== null));
    FUNC_CACHE.set(key, map);
  }
  return map[r][c];
}

function penalty(m) {
  const size = m.length;
  let p = 0;
  const runs = (get) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) {
          run++;
        } else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
  };
  runs((r, c) => m[r][c]);
  runs((c, r) => m[r][c]);

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
  }

  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patRev = pat.slice().reverse();
  const matchAt = (arr, i, patt) => patt.every((v, k) => arr[i + k] === v);
  for (let i = 0; i < size; i++) {
    const row = m[i];
    const col = m.map((r2) => r2[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (matchAt(row, j, pat) || matchAt(row, j, patRev)) p += 40;
      if (matchAt(col, j, pat) || matchAt(col, j, patRev)) p += 40;
    }
  }

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const ratio = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(ratio - 50) / 5);
  p += k * 10;
  return p;
}

export function encodeQr(text, opts = {}) {
  const bytes = [...Buffer.from(text, "utf8")];
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = interleave(buildCodewords(bytes, version), version);
  const base = newMatrix(size);
  placeFunctionPatterns(base, version);
  placeVersionInfo(base, version);
  placeData(base, codewords);

  if (opts.forceMask !== undefined) {
    const forced = applyMask(base, opts.forceMask);
    applyFormatInfo(forced, opts.forceMask);
    return { version, size, mask: opts.forceMask, penalty: penalty(forced), modules: forced };
  }
  let best = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const cand = applyMask(base, mask);
    applyFormatInfo(cand, mask);
    const p = penalty(cand);
    if (p < bestPenalty) {
      bestPenalty = p;
      best = { matrix: cand, mask, penalty: p };
    }
  }
  return { version, size, mask: best.mask, penalty: bestPenalty, modules: best.matrix };
}

// ---------- PNG output ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function qrToPng(qr, { scale = 8, border = 4, dark = [0, 0, 0], light = [255, 255, 255] } = {}) {
  const dim = (qr.size + border * 2) * scale;
  const raw = Buffer.alloc((dim * 3 + 1) * dim);
  let o = 0;
  for (let y = 0; y < dim; y++) {
    raw[o++] = 0;
    const my = Math.floor(y / scale) - border;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - border;
      const on = my >= 0 && mx >= 0 && my < qr.size && mx < qr.size ? qr.modules[my][mx] : 0;
      const rgb = on ? dark : light;
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function qrToTerminal(qr) {
  const pad = 2;
  const lines = [];
  const get = (y, x) =>
    y >= 0 && x >= 0 && y < qr.size && x < qr.size ? qr.modules[y][x] === 1 : false;
  for (let y = -pad; y < qr.size + pad; y += 2) {
    let line = "";
    for (let x = -pad; x < qr.size + pad; x++) {
      const top = get(y, x);
      const bottom = get(y + 1, x);
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

