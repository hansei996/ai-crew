// ASS subtitle builder (rendered by libass) with CJK-aware wrapping
import fs from 'node:fs';

export function assTime(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const cs = Math.round(clamped / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (v, n) => String(v).padStart(n, '0');
  return h + ':' + pad(m, 2) + ':' + pad(s, 2) + '.' + pad(c, 2);
}

function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp <= 0x2e7f) {
    if (ch === ' ') return 0.3;
    if (/[iIl.,:;'!|]/.test(ch)) return 0.3;
    if (/[A-Z]/.test(ch)) return 0.64;
    return 0.55;
  }
  return 1;
}

export function wrapText(text, opts) {
  const fontSize = opts.fontSize;
  const limit = opts.maxChars > 0 ? opts.maxChars : Math.max(6, Math.floor(opts.maxWidth / fontSize));
  const lines = [];
  for (const raw of String(text).split('\n')) {
    let cur = '';
    let used = 0;
    for (const ch of raw) {
      const w = charWidth(ch);
      if (used + w > limit && cur) {
        lines.push(cur);
        cur = '';
        used = 0;
      }
      cur += ch;
      used += w;
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [''];
}

function assBGR(hex) {
  const h = String(hex).replace('#', '').padStart(6, '0');
  return '&H00' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}

export function buildAss(cues, opts) {
  const width = opts.width === undefined ? 1920 : opts.width;
  const height = opts.height === undefined ? 1080 : opts.height;
  const font = opts.font === undefined ? 'Microsoft YaHei' : opts.font;
  const fontSize = opts.fontSize === undefined ? 56 : opts.fontSize;
  const primary = opts.primary === undefined ? '#f2f5ff' : opts.primary;
  const outline = opts.outline === undefined ? '#0a0f1c' : opts.outline;
  const marginV = opts.marginV === undefined ? 86 : opts.marginV;
  const marginLR = opts.marginLR === undefined ? 120 : opts.marginLR;
  const outlineWidth = opts.outlineWidth === undefined ? 4 : opts.outlineWidth;
  const shadow = opts.shadow === undefined ? 2 : opts.shadow;
  const maxCharsPerLine = opts.maxCharsPerLine === undefined ? 22 : opts.maxCharsPerLine;
  const bold = opts.bold === undefined ? 0 : opts.bold;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: ' + width,
    'PlayResY: ' + height,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,' + font + ',' + fontSize + ',' + assBGR(primary) + ',&H000000FF,' + assBGR(outline) +
      ',&H80000000,' + bold + ',0,0,0,100,100,0,0,1,' + outlineWidth + ',' + shadow + ',2,' + marginLR + ',' + marginLR + ',' + marginV + ',1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = [];
  cues
    .filter((c) => c.endMs > c.startMs && String(c.text || '').trim())
    .forEach((c) => {
      const lines = wrapText(c.text, { fontSize: fontSize, maxWidth: width - marginLR * 2, maxChars: maxCharsPerLine });
      if (!c.anim) {
        const body = lines.join('\\N').replace(/[{}]/g, '');
        events.push('Dialogue: 0,' + assTime(c.startMs) + ',' + assTime(c.endMs) + ',Default,,0,0,0,,' + body);
        return;
      }
      // per-character animation: 'typewriter' (appear in place) or 'rise' (float up into place)
      const chars = [...lines.join('')];
      const adv = fontSize * 0.92;
      const startX = Math.round((width - chars.length * adv) / 2);
      const yBase = height - marginV - 44;
      const stagger = c.anim === 'typewriter' ? 55 : 40;
      chars.forEach((ch, i) => {
        if (ch === ' ') return;
        const t0 = Math.round(c.startMs + i * stagger);
        if (t0 >= c.endMs) return;
        const x = Math.round(startX + i * adv);
        const tag = c.anim === 'rise'
          ? '{\\pos(' + x + ',' + (yBase + 28) + ')\\move(' + x + ',' + (yBase + 28) + ',' + x + ',' + yBase + ',0,240)\\fad(60,0)}'
          : '{\\pos(' + x + ',' + yBase + ')\\fad(70,0)}';
        events.push('Dialogue: 0,' + assTime(t0) + ',' + assTime(c.endMs) + ',Default,,0,0,0,,' + tag + String(ch).replace(/[{}]/g, ''));
      });
    });

  return header.concat(events).join('\n') + '\n';
}

export function writeAss(file, cues, opts) {
  fs.writeFileSync(file, buildAss(cues, opts), 'utf8');
}
