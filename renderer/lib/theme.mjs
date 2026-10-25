// Palette + typography for the renderer. Override per script via script.json.theme
export const DEFAULT_THEME = {
  bgTop: '#080d19',
  bgMid: '#101a33',
  bgBottom: '#1b2647',
  accent: '#4ea1ff',
  accent2: '#ff5f9e',
  text: '#f2f5ff',
  dim: '#9aa6c4',
  fontRegular: 'C:/Windows/Fonts/msyh.ttc',
  fontBold: 'C:/Windows/Fonts/msyhbd.ttc',
  assFont: 'Microsoft YaHei',
  sizes: { kicker: 34, title: 112, subtitle: 46, quote: 92, sticker: 62, coverTitle: 116, coverSub: 44, ass: 56 },
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function resolveTheme(overrides) {
  const out = { ...DEFAULT_THEME, sizes: { ...DEFAULT_THEME.sizes } };
  for (const k of Object.keys(overrides || {})) {
    const v = overrides[k];
    if (k === 'sizes' && isObj(v)) out.sizes = { ...out.sizes, ...v };
    else out[k] = v;
  }
  return out;
}

export function hexToFF(hex) {
  return '0x' + String(hex).replace('#', '').slice(0, 6).toUpperCase();
}

export function ffColor(hex, alpha) {
  if (alpha === undefined || alpha >= 1) return hexToFF(hex);
  return hexToFF(hex) + '@' + alpha;
}

export function assColor(hex, alpha) {
  const h = String(hex).replace('#', '').padStart(6, '0');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  const a = (alpha || 0).toString(16).toUpperCase().padStart(2, '0');
  return '&H' + a + b + g + r;
}
