// Zero-dependency PNG encoder + tiny raster helpers (node: builtins only)
import zlib from 'node:zlib';
import fs from 'node:fs';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length >>> 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function savePNG(file, w, h, rgba) {
  fs.writeFileSync(file, encodePNG(w, h, rgba));
}

export function parseColor(c) {
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] === undefined ? 255 : c[3] | 0];
  const h = String(c).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = Buffer.alloc(w * h * 4);
  }

  _blend(x, y, rgb, cov) {
    if (cov <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const sa = clamp01(cov) * (rgb[3] / 255);
    if (sa <= 0) return;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[i] = Math.round((rgb[0] * sa + d[i] * da * (1 - sa)) / oa);
    d[i + 1] = Math.round((rgb[1] * sa + d[i + 1] * da * (1 - sa)) / oa);
    d[i + 2] = Math.round((rgb[2] * sa + d[i + 2] * da * (1 - sa)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }

  fillRect(x, y, w, h, color) {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      const covY = Math.min(y1, y + h) - Math.max(py, y);
      for (let px = x0; px < x1; px++) {
        const covX = Math.min(x1, x + w) - Math.max(px, x);
        this._blend(px, py, c, clamp01(covX) * clamp01(covY));
      }
    }
  }

  fillRoundRect(x, y, w, h, r, color) {
    const c = parseColor(color);
    const rr = Math.min(r, w / 2, h / 2);
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      const cy = py + 0.5;
      for (let px = x0; px < x1; px++) {
        const cx = px + 0.5;
        const dx = Math.max(0, Math.max(x + rr - cx, cx - (x + w - rr)));
        const dy = Math.max(0, Math.max(y + rr - cy, cy - (y + h - rr)));
        const dist = Math.sqrt(dx * dx + dy * dy) - rr;
        const cov = clamp01(0.5 - dist);
        if (cov > 0) this._blend(px, py, c, cov);
      }
    }
  }

  fillCircle(cx, cy, r, color) {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.floor(cx - r - 1)), y0 = Math.max(0, Math.floor(cy - r - 1));
    const x1 = Math.min(this.w, Math.ceil(cx + r + 1)), y1 = Math.min(this.h, Math.ceil(cy + r + 1));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - r;
        const cov = clamp01(0.5 - d);
        if (cov > 0) this._blend(px, py, c, cov);
      }
    }
  }

  fillStar(cx, cy, R, points, inner, color) {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.floor(cx - R - 2)), y0 = Math.max(0, Math.floor(cy - R - 2));
    const x1 = Math.min(this.w, Math.ceil(cx + R + 2)), y1 = Math.min(this.h, Math.ceil(cy + R + 2));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        const th = Math.atan2(dy, dx);
        const edge = R * (inner + (1 - inner) * Math.abs(Math.cos((points / 2) * th)));
        const cov = clamp01((edge - d) * 0.8 + 0.5);
        if (cov > 0) this._blend(px, py, c, cov);
      }
    }
  }

  verticalGradient(stops) {
    const parsed = stops.map((s) => [s[0], parseColor(s[1])]);
    for (let y = 0; y < this.h; y++) {
      const t = this.h <= 1 ? 0 : y / (this.h - 1);
      let a = parsed[0];
      let b = parsed[parsed.length - 1];
      for (let k = 0; k < parsed.length - 1; k++) {
        if (t >= parsed[k][0] && t <= parsed[k + 1][0]) {
          a = parsed[k];
          b = parsed[k + 1];
          break;
        }
      }
      const span = b[0] - a[0] || 1;
      const f = clamp01((t - a[0]) / span);
      const r = a[1][0] + (b[1][0] - a[1][0]) * f;
      const g = a[1][1] + (b[1][1] - a[1][1]) * f;
      const bl = a[1][2] + (b[1][2] - a[1][2]) * f;
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = bl;
        this.data[i + 3] = 255;
      }
    }
  }

  radialGlow(cx, cy, r, color, strength = 1) {
    const c = parseColor(color);
    const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.w, Math.ceil(cx + r)), y1 = Math.min(this.h, Math.ceil(cy + r));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d = Math.hypot(px - cx, py - cy) / r;
        if (d >= 1) continue;
        const f = (1 - d) * (1 - d) * strength;
        this._blend(px, py, c, f);
      }
    }
  }

  grain(amount = 6, seed = 7) {
    const rnd = mulberry32(seed);
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * amount;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
  }
}
