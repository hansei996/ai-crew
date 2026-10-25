#!/usr/bin/env node
// JSON script -> 1920x1080 mp4 (+ cover.png + meta.json). Zero dependencies: node: builtins only.
//
//   node render.mjs demo/script.json [--out out] [--fps 30] [--keep]
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, savePNG } from './lib/png.mjs';
import { writeBgm, writeWav16 } from './lib/audio.mjs';
import { writeAss, buildAss, wrapText } from './lib/ass.mjs';
import { resolveTheme, ffColor } from './lib/theme.mjs';
import { makeRunner, fesc, frel, probe } from './lib/ff.mjs';
import { checkFirstFrame, firstFrameFailLine, firstFrameOkLine, checkAssFont } from './lib/firstframe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDTH = 1920;
const HEIGHT = 1080;

const SCENE_TYPES = new Set(['hook', 'title', 'screen', 'quote', 'sticker', 'fx', 'term']);

function parseArgs(argv) {
  const opts = {
    script: null, out: 'out', fps: 30, crf: 20, preset: 'veryfast',
    ffmpeg: null, keep: false, quiet: false, frames: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') opts.out = next();
    else if (a === '--fps') opts.fps = Number(next());
    else if (a === '--crf') opts.crf = Number(next());
    else if (a === '--preset') opts.preset = next();
    else if (a === '--ffmpeg') opts.ffmpeg = next();
    else if (a === '--frames') opts.frames = Number(next());
    else if (a === '--keep') opts.keep = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('--') && !opts.script) opts.script = a;
    else throw new Error('unknown argument: ' + a);
  }
  return opts;
}

function resolveFfmpeg(explicit) {
  const candidates = [explicit, process.env.FFMPEG, path.join(HERE, '..', '_tooling', 'ffmpeg.exe'), path.join(HERE, '..', '_tooling', 'ffmpeg')];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'ffmpeg';
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// ---------------------------------------------------------------- backgrounds
function buildBackgrounds(workDir, theme) {
  const mk = (file, opts) => {
    const cv = new Canvas(WIDTH, HEIGHT);
    cv.verticalGradient([[0, opts.top], [0.55, opts.mid], [1, opts.bottom]]);
    cv.radialGlow(opts.glowX, opts.glowY, 1100, opts.glow, opts.glowStrength);
    // faint diagonal texture
    for (let i = -HEIGHT; i < WIDTH; i += 96) {
      for (let y = 0; y < HEIGHT; y++) {
        const x = i + y;
        if (x < 0 || x >= WIDTH) continue;
        const idx = (y * WIDTH + x) * 4;
        cv.data[idx] = Math.min(255, cv.data[idx] + 3);
        cv.data[idx + 1] = Math.min(255, cv.data[idx + 1] + 4);
        cv.data[idx + 2] = Math.min(255, cv.data[idx + 2] + 7);
      }
    }
    // vignette
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const d = Math.hypot((x - cx) / cx, (y - cy) / cy);
        const k = Math.max(0, Math.min(1, (d - 0.55) / 0.75));
        if (k <= 0) continue;
        const idx = (y * WIDTH + x) * 4;
        cv.data[idx] = cv.data[idx] * (1 - k * 0.55);
        cv.data[idx + 1] = cv.data[idx + 1] * (1 - k * 0.55);
        cv.data[idx + 2] = cv.data[idx + 2] * (1 - k * 0.55);
      }
    }
    cv.grain(4, opts.seed || 11);
    savePNG(file, WIDTH, HEIGHT, cv.data);
    return file;
  };
  const main = mk(path.join(workDir, 'bg_main.png'), {
    top: theme.bgTop, mid: theme.bgMid, bottom: theme.bgBottom,
    glow: theme.accent, glowX: WIDTH * 0.80, glowY: HEIGHT * 0.18, glowStrength: 0.30, seed: 11,
  });
  const deep = mk(path.join(workDir, 'bg_deep.png'), {
    top: '#05080f', mid: '#0a1122', bottom: '#111b33',
    glow: theme.accent2, glowX: WIDTH * 0.18, glowY: HEIGHT * 0.82, glowStrength: 0.22, seed: 29,
  });
  const cover = mk(path.join(workDir, 'bg_cover.png'), {
    top: theme.bgTop, mid: theme.bgMid, bottom: theme.bgBottom,
    glow: theme.accent, glowX: WIDTH * 0.86, glowY: HEIGHT * 0.30, glowStrength: 0.38, seed: 43,
  });
  return { main, deep, cover };
}

// ---------------------------------------------------------------- drawtext helpers
function dt(o) {
  const p = [];
  p.push('fontfile=' + fesc(o.font));
  if (o.textFile) p.push('textfile=' + frel(o.textFile));
  p.push('fontsize=' + Math.round(o.fontSize));
  p.push('fontcolor=' + o.color);
  if (o.lineSpacing) p.push('line_spacing=' + o.lineSpacing);
  // any expression that can contain a comma has to be single-quoted, otherwise the
  // filtergraph parser splits it into a different option.
  const q = (v) => (typeof v === 'number' ? String(Math.round(v)) : "'" + v + "'");
  p.push('x=' + q(o.x));
  p.push('y=' + q(o.y));
  if (o.alpha) p.push('alpha=' + q(o.alpha));
  if (o.borderw) p.push('borderw=' + o.borderw);
  if (o.bordercolor) p.push('bordercolor=' + o.bordercolor);
  if (o.shadowx || o.shadowy) {
    p.push('shadowx=' + (o.shadowx || 0));
    p.push('shadowy=' + (o.shadowy || 0));
    p.push('shadowcolor=' + (o.shadowcolor || '0x000000@0.6'));
  }
  if (o.fixBounds === false) p.push('fix_bounds=0');
  return 'drawtext=' + p.join(':');
}

// drawtext never wraps: pre-wrap every card text to the safe width.
function wrapL(text, fontSize, maxWidth) {
  return wrapText(text, { fontSize: fontSize, maxWidth: maxWidth || WIDTH - 300 }).join('\n');
}

// drawtext cannot centre the individual lines of a wrapped textfile, so a text block is
// emitted as one drawtext per line, each centred on its own width.
function pushTextBlock(chain, fromLabel, ctx, tag, text, o) {
  const lines = wrapText(text, { fontSize: o.fontSize, maxWidth: o.maxWidth || WIDTH - 300 });
  const lh = Math.round(o.fontSize * (o.lineHeightFactor || 1.3));
  const y0 = Math.round(o.centerY - ((lines.length - 1) * lh) / 2);
  let cur = fromLabel;
  lines.forEach((ln, i) => {
    const file = ctx.textFile(tag + '_' + i, ln);
    const next = o.prefix + (i + 1);
    const y = o.slide ? y0 + i * lh + '-' + o.slide + '*(1-min(t/0.75,1))' : y0 + i * lh;
    chain.push('[' + cur + ']' + dt({
      font: o.font, textFile: file, fontSize: o.fontSize, color: o.color,
      x: '(w-text_w)/2', y: y, alpha: o.alpha,
      shadowx: o.shadowx, shadowy: o.shadowy, shadowcolor: o.shadowcolor,
    }) + '[' + next + ']');
    cur = next;
  });
  return cur;
}

function box(x, y, w, h, color, thickness) {
  return 'drawbox=x=' + Math.round(x) + ':y=' + Math.round(y) + ':w=' + Math.round(w) + ':h=' + Math.round(h) +
    ':color=' + color + ':t=' + (thickness === undefined ? 'fill' : thickness);
}

// ---------------------------------------------------------------- scene filters
function sceneInputs(scene, ctx) {
  if (scene.type === 'hook' || scene.type === 'title') return ['-loop', '1', '-i', ctx.bg.main];
  if (scene.type === 'quote') return ['-loop', '1', '-i', ctx.bg.deep];
  if (scene.type === 'screen') return ['-loop', '1', '-i', ctx.bg.main, '-loop', '1', '-i', ctx.absImage(scene)];
  if (scene.type === 'term') return ['-loop', '1', '-i', ctx.bg.deep];
  if (scene.type === 'fx') {
    const base = ['-loop', '1', '-i', ctx.bg.deep];
    const names = Array.isArray(scene.fx) ? scene.fx : [];
    if (names.includes('particles')) {
      return base.concat(['-f', 'lavfi', '-i',
        'life=s=' + WIDTH + 'x' + HEIGHT + ':mold=10:r=30:ratio=0.1:death_color=#101820:life_color=#4ea1ff']);
    }
    return base;
  }
  return ['-loop', '1', '-i', ctx.bg.deep, '-loop', '1', '-i', ctx.absImage(scene)];
}

// P0-0：首帧黑板。fade=t=in 在 t=0 时 alpha=0，整卡全黑；且与 xfade 叠加会双重压暗。
// 修法：第 0 个 clip 不做 fade-in（入场动效由卡内文字层承担），其余 clip 保持 0.28s 淡入。
let __clipIndex = 0;
export function __resetClipIndex() { __clipIndex = 0; }
function clipTail(dur, isLast) {
  const isFirst = __clipIndex++ === 0;
  const parts = isFirst ? [] : ['fade=t=in:st=0:d=0.28'];
  if (isLast) {
    const d = Math.min(0.6, dur * 0.2);
    parts.push('fade=t=out:st=' + (dur - d).toFixed(3) + ':d=' + d.toFixed(3));
  }
  return parts.length ? parts.join(',') : 'null';
}

function termFilter(scene, ctx, idx, isLast) {
  const t = ctx.theme;
  const dur = scene.durationSec;
  const lines = Array.isArray(scene.lines) ? scene.lines : [];
  const chain = [];
  let n = 0;
  let cur = 'b0';
  const add = (filter) => {
    const nx = 't' + (n++);
    chain.push('[' + cur + ']' + filter + '[' + nx + ']');
    cur = nx;
  };
  chain.push('[0:v]scale=' + WIDTH + ':' + HEIGHT + ',setsar=1,fps=' + ctx.fps + ',format=yuv420p[b0]');
  add('drawbox=x=384:y=153:w=1151:h=773:color=0x05080f@0.85:t=fill');
  add('drawbox=x=384:y=153:w=1151:h=4:color=' + t.accent.replace('#', '0x') + '@0.9:t=fill');
  const titleF = ctx.textFile('term_title_' + idx, scene.label || 'RUN LOG');
  add('drawtext=fontfile=' + fesc(t.fontBold) + ':textfile=' + frel(titleF) + ':fontsize=42:fontcolor=' + ffColor(t.accent, 0.95) + ':x=190:y=206');
  lines.forEach((ln, i) => {
    const f = ctx.textFile('term_line_' + idx + '_' + i, ln);
    const at = (0.25 + i * 0.95).toFixed(2);
    add('drawtext=fontfile=' + fesc(t.fontRegular) + ':textfile=' + frel(f) + ':fontsize=34:fontcolor=' + ffColor(t.text, 0.94) +
      ':x=190:y=' + (290 + i * 58) + ":enable='gte(t," + at + ")'");
  });
  // progress bar: 1 step every dur/8 seconds
  const barY = 290 + lines.length * 58 + 26;
  const barW = Math.round(1151 * 0.72);
  const steps = 8;
  add('drawbox=x=420:y=' + barY + ':w=' + barW + ':h=16:color=0x1b2430@0.9:t=fill');
  for (let s = 1; s <= steps; s++) {
    const at = ((s - 1) * (dur / steps)).toFixed(2);
    add("drawbox=x=420:y=" + barY + ':w=' + Math.round((barW * s) / steps) + ':h=16:color=' + t.accent.replace('#', '0x') +
      "@0.9:t=fill:enable='gte(t," + at + ")'");
  }
  // rolling number: 8 档换档（textfile + enable），不用 %{eif} 表达式——冒号在 filtergraph
  // 文本里会被切分，之前渲染成 "d} / 42"。档位写在 scene.rollFrom/rollTo，默认 0 → 42。
  const rollFrom = Number(scene.rollFrom === undefined ? 0 : scene.rollFrom);
  const rollTo = Number(scene.rollTo === undefined ? 42 : scene.rollTo);
  const rollSteps = 8;
  for (let s = 1; s <= rollSteps; s++) {
    const val = Math.round(rollFrom + ((rollTo - rollFrom) * s) / rollSteps);
    const f = ctx.textFile('term_roll_' + idx + '_' + s, val + ' / ' + rollTo);
    const at = 1.2 + (s - 1) * 0.35;
    const to = at + 0.35;
    const win = s < rollSteps
      ? "between(t," + at.toFixed(2) + "," + to.toFixed(2) + ")"
      : "gte(t," + at.toFixed(2) + ")";
    add('drawtext=fontfile=' + fesc(t.fontBold) + ':textfile=' + frel(f) + ':fontsize=86:fontcolor=' + ffColor(t.accent, 0.98) +
      ':x=420:y=' + (barY + 60) + ":enable='" + win + "'");
  }
  const capF = scene.caption ? ctx.textFile('term_cap_' + idx, scene.caption) : null;
  if (capF) {
    add('drawtext=fontfile=' + fesc(t.fontRegular) + ':textfile=' + frel(capF) + ':fontsize=34:fontcolor=' + ffColor(t.dim, 0.95) +
      ':x=190:y=' + (barY + 170) + ":enable='gte(t,2.0)'");
  }
  chain.push('[' + cur + ']' + clipTail(dur, isLast) + ',format=yuv420p[vout]');
  return chain.join(';\n');
}

function fxFilter(scene, ctx, idx, isLast) {
  const dur = scene.durationSec;
  const names = Array.isArray(scene.fx) ? scene.fx : ['noise'];
  const chain = [];
  const hasParticles = names.includes('particles');
  chain.push('[0:v]scale=' + WIDTH + ':' + HEIGHT + ',setsar=1,fps=' + ctx.fps + '[b0]');
  let cur = 'b0';
  if (hasParticles) {
    chain.push('[b0][1:v]blend=all_mode=screen:shortest=1[b1]');
    cur = 'b1';
  }
  let n = 0;
  const step = (filter) => {
    const next = 'f' + (n++);
    chain.push('[' + cur + ']' + filter + '[' + next + ']');
    cur = next;
  };
  if (names.includes('scanline')) {
    step("geq=lum='lum(X,Y)*(0.85+0.15*sin((Y+T*180)/9))':cb='cb(X,Y)':cr='cr(X,Y)'");
  }
  if (names.includes('noise')) step('noise=alls=10:allf=t,drawgrid=w=iw:h=4:t=1:c=black@0.18');
  if (names.includes('glitch')) {
    step("rgbashift=rh=6:bh=-6:enable='lt(mod(t,0.5),0.12)',chromashift=cbh=4:enable='lt(mod(t,0.4),0.1)'");
  }
  step('vignette=PI/5');
  chain.push('[' + cur + ']' + clipTail(dur, isLast) + ',format=yuv420p[vout]');
  return chain.join(';\n');
}

function hookFilter(scene, ctx, idx, isLast) {
  const t = ctx.theme;
  const S = t.sizes;
  const dur = scene.durationSec;
  const kicker = scene.kicker || ctx.script.subtitle || '';
  const titleText = scene.text || ctx.script.title || '';
  const kickF = kicker ? ctx.textFile('hook_kicker_' + idx, kicker) : null;
  const subF = scene.subtitle ? ctx.textFile('hook_sub_' + idx, wrapL(scene.subtitle, S.subtitle)) : null;

  const chain = [];
  chain.push('[0:v]scale=' + WIDTH + ':' + HEIGHT + ',setsar=1,fps=' + ctx.fps + '[base]');
  let cur = 'base';
  if (kickF) {
    chain.push('[' + cur + ']' + dt({
      font: t.fontRegular, textFile: kickF, fontSize: S.kicker, color: ffColor(t.dim, 0.95),
      x: '(w-text_w)/2', y: Math.round(HEIGHT * 0.175), alpha: 'max(0.7,min(t/0.5,1))',
    }) + '[v1]');
    cur = 'v1';
  }
  chain.push('[' + cur + ']' + box((WIDTH - 150) / 2, HEIGHT * 0.292, 150, 6, ffColor(t.accent, 0.95)) + '[v2]');
  cur = pushTextBlock(chain, 'v2', ctx, 'hook_title_' + idx, titleText, {
    font: t.fontBold, fontSize: S.title, color: ffColor(t.text), centerY: HEIGHT * 0.42,
    alpha: 'max(0.7,min(t/0.45,1))', slide: 26,
    shadowx: 0, shadowy: 6, shadowcolor: '0x000000@0.45', prefix: 'ht',
  });
  if (subF) {
    chain.push('[' + cur + ']' + dt({
      font: t.fontRegular, textFile: subF, fontSize: S.subtitle, color: ffColor(t.dim),
      x: '(w-text_w)/2', y: Math.round(HEIGHT * 0.60), lineSpacing: 12,
      alpha: 'max(0.7,min(t/0.9,1))',
    }) + '[v4]');
    cur = 'v4';
  }
  chain.push('[' + cur + ']' + clipTail(dur, isLast) + '[vout]');
  return chain.join(';\n');
}

function quoteFilter(scene, ctx, idx, isLast) {
  const t = ctx.theme;
  const S = t.sizes;
  const bodyText = scene.text || '';
  const chain = [];
  chain.push('[0:v]scale=' + WIDTH + ':' + HEIGHT + ',setsar=1,fps=' + ctx.fps + '[base]');
  chain.push('[base]' + box((WIDTH - 170) / 2, HEIGHT * 0.285, 170, 6, ffColor(t.accent, 0.9)) + '[q0]');
  const last = pushTextBlock(chain, 'q0', ctx, 'quote_' + idx, bodyText, {
    font: t.fontBold, fontSize: S.quote, color: ffColor(t.text), centerY: HEIGHT * 0.47,
    alpha: 'min(t/0.8,1)', slide: 30,
    shadowx: 0, shadowy: 8, shadowcolor: '0x000000@0.4', prefix: 'qt',
  });
  chain.push('[' + last + ']' + clipTail(scene.durationSec, isLast) + '[vout]');
  return chain.join(';\n');
}

function screenFilter(scene, ctx, idx, isLast) {
  const t = ctx.theme;
  const N = scene.frames;
  const innerW = 1151;
  const innerH = scene.card === 'text' ? 773 : 651;
  const ox = Math.round((WIDTH - innerW) / 2);
  const oy = Math.round((HEIGHT - innerH) / 2);
  const chain = [];
  chain.push('[1:v]scale=' + innerW + ':' + innerH + ':force_original_aspect_ratio=increase,crop=' + innerW + ':' + innerH +
    ',zoompan=z=\'min(1+0.0009*on,1.10)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=' + N + ':s=' + innerW + 'x' + innerH + ':fps=' + ctx.fps + '[scr]');
  chain.push('[0:v]scale=' + WIDTH + ':' + HEIGHT + ',setsar=1,fps=' + ctx.fps + '[base]');
  chain.push('[base]' + box(ox - 24, oy - 24, innerW + 48, innerH + 48, '0x1b2647@1', 24) + '[frame]');
  chain.push('[frame][scr]overlay=' + ox + ':' + oy + '[ov]');
  let cur = 'ov';
  if (scene.label) {
    const labF = ctx.textFile('screen_label_' + idx, scene.label);
    chain.push('[' + cur + ']' + dt({
      font: t.fontRegular, textFile: labF, fontSize: 34, color: ffColor(t.accent, 0.95),
      x: ox, y: oy - 56, alpha: 'min(t/0.6,1)',
    }) + '[lv]');
    cur = 'lv';
  }
  chain.push('[' + cur + ']' + clipTail(scene.durationSec, isLast) + '[vout]');
  return chain.join(';\n');
}

function stickerFilter(scene, ctx, idx, isLast) {
  const t = ctx.theme;
  const S = t.sizes;
  const labelText = scene.text || '';
  const capF = scene.caption ? ctx.textFile('sticker_cap_' + idx, wrapL(scene.caption, 38)) : null;
  const chain = [];
  chain.push('[1:v]scale=500:-1:force_original_aspect_ratio=decrease[st]');
  chain.push('[0:v]scale=' + WIDTH + ':' + HEIGHT + ',setsar=1,fps=' + ctx.fps + '[base]');
  chain.push('[base][st]overlay=x=(W-w)/2:y=\'H*0.12+70*abs(sin(2.4*t))\':eval=frame[b1]');
  let cur = 'b1';
  cur = pushTextBlock(chain, cur, ctx, 'sticker_' + idx, labelText, {
    font: t.fontBold, fontSize: S.sticker, color: ffColor(t.text), centerY: HEIGHT * 0.75,
    alpha: 'max(0.7,min(t/0.5,1))', shadowx: 0, shadowy: 6, shadowcolor: '0x000000@0.45', prefix: 'sl',
  });
  if (capF) {
    chain.push('[' + cur + ']' + dt({
      font: t.fontRegular, textFile: capF, fontSize: 38, color: ffColor(t.dim),
      x: '(w-text_w)/2', y: Math.round(HEIGHT * 0.848), alpha: 'min(t/0.8,0.95)',
    }) + '[b3]');
    cur = 'b3';
  }
  chain.push('[' + cur + ']' + clipTail(scene.durationSec, isLast) + '[vout]');
  return chain.join(';\n');
}

// ---------------------------------------------------------------- subtitles
function splitSentences(text) {
  const parts = String(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[\u3002\uff01\uff1f!?\u2026])/))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(text || '').trim()];
}

function buildCues(scenes, starts, overlap) {
  const cues = [];
  scenes.forEach((sc, i) => {
    const cueSrc = sc.cueText != null ? sc.cueText
      : (sc.subtitle === false || sc.type === 'hook' || sc.type === 'title') ? null : sc.text;
    if (cueSrc == null || cueSrc === '') return;
    const start = Math.max(0, starts[i]);
    const end = start + sc.durationSec;
    const pad = Math.min(0.18, sc.durationSec * 0.05);
    const from = start + pad;
    const to = end - pad;
    const pieces = splitSentences(cueSrc || '');
    const totalChars = pieces.reduce((a, p) => a + p.length, 0) || 1;
    let cursor = from;
    pieces.forEach((p, k) => {
      const span = ((to - from) * p.length) / totalChars;
      const isLast = k === pieces.length - 1;
      // starts[]/durations are seconds; ASS wants milliseconds
      cues.push({ startMs: cursor * 1000, endMs: (isLast ? to : cursor + span) * 1000, text: p });
      cursor += span;
    });
  });
  return cues;
}

// ---------------------------------------------------------------- cover + meta
function renderCover(ctx, outDir, script) {
  const t = ctx.theme;
  const S = t.sizes;
  const titleF = ctx.textFile('cover_title', wrapL(script.title || '', S.coverTitle, 1420));
  const subF = ctx.textFile('cover_sub', wrapL(script.subtitle || script.desc || '', S.coverSub, 1420));
  const badgeF = ctx.textFile('cover_badge', script.episode || 'EP.01');
  const chF = script.channel ? ctx.textFile('cover_channel', script.channel) : null;
  const chain = [];
  chain.push('[0:v]scale=' + WIDTH + ':' + HEIGHT + '[base]');
  chain.push('[base]' + box(0, 0, WIDTH, HEIGHT, '0x05080F@0.22') + '[d0]');
  chain.push('[d0]' + box(120, 292, 96, 8, ffColor(t.accent, 1)) + '[d1]');
  chain.push('[d1]' + dt({
    font: t.fontBold, textFile: titleF, fontSize: S.coverTitle, color: ffColor(t.text),
    x: 120, y: 336, lineSpacing: 22, shadowx: 0, shadowy: 8, shadowcolor: '0x000000@0.5',
  }) + '[d2]');
  chain.push('[d2]' + dt({
    font: t.fontRegular, textFile: subF, fontSize: S.coverSub, color: ffColor(t.dim),
    x: 120, y: Math.round(HEIGHT - 250), lineSpacing: 14,
  }) + '[d3]');
  chain.push('[d3]' + box(1420, 104, 380, 96, '0x05080F@0.55') + '[d4]');
  chain.push('[d4]' + box(1420, 104, 380, 96, ffColor(t.accent, 0.85), 4) + '[d5]');
  chain.push('[d5]' + dt({
    font: t.fontBold, textFile: badgeF, fontSize: 46, color: ffColor(t.accent),
    x: '1420+(380-text_w)/2', y: '104+(96-text_h)/2',
  }) + '[d6]');
  let cur = 'd6';
  if (chF) {
    chain.push('[' + cur + ']' + dt({
      font: t.fontRegular, textFile: chF, fontSize: 34, color: ffColor(t.dim, 0.85),
      x: 120, y: Math.round(HEIGHT - 132),
    }) + '[d7]');
    cur = 'd7';
  }
  const scriptFile = path.join(ctx.workDir, 'cover_filter.txt');
  fs.writeFileSync(scriptFile, chain.join(';\n'), 'utf8');
  const out = path.join(outDir, 'cover.png');
  ctx.run(['-loop', '1', '-i', ctx.bg.cover, '-filter_complex_script', scriptFile, '-map', '[' + cur + ']',
    '-frames:v', '1', '-pix_fmt', 'rgb24', out], 'cover');
  return out;
}

// ---------------------------------------------------------------- main
// ---- P0-0b 首帧自检（不依赖 ffprobe）----
// 闸门：① t=0 帧体积 > MIN_BYTES（默认 300 KB，踩平场会小到 6 KB）
//       ② |YAVG(t=0) − YAVG(t=+0.5s)| <= MAX_DELTA（默认 10）—— 不用「背景+8」是因为背景亮度随卡片
//          变化极大（同一支片 t=30s 暗场卡 YAVG 只有 7），绝对阈值会误杀暗色设计。
// 阈值可用环境变量覆盖，便于自测失败分支：FF_GATE_MIN_BYTES / FF_GATE_MAX_DELTA
function firstFrameGate(cfg) {
  const r = checkFirstFrame({ ffmpeg: cfg.ffmpeg, video: cfg.video, workDir: cfg.dir, tag: 'out' });
  fs.writeFileSync(path.join(cfg.outDir, 'firstframe.json'), JSON.stringify(r, null, 2) + String.fromCharCode(10), 'utf8');
  const line = r.ok ? firstFrameOkLine(r) : firstFrameFailLine(r);
  process.stderr.write(line + String.fromCharCode(10));
  return r;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.script) {
    console.log('usage: node render.mjs <script.json> [--out dir] [--fps 30] [--crf 20] [--preset veryfast] [--keep] [--ffmpeg path]');
    process.exit(opts.help ? 0 : 1);
  }
  const scriptPath = path.resolve(opts.script);
  const scriptDir = path.dirname(scriptPath);
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  if (!Array.isArray(script.scenes) || script.scenes.length === 0) throw new Error('script.scenes must be a non-empty array');

  const theme = resolveTheme(script.theme);
  const outDir = ensureDir(path.resolve(opts.out));
  const workDir = ensureDir(path.join(outDir, '.work'));
  rmrf(workDir);
  ensureDir(workDir);
  const ffmpeg = resolveFfmpeg(opts.ffmpeg);
  const fps = opts.fps;
  const run = makeRunner({ ffmpeg: ffmpeg, cwd: workDir, quiet: opts.quiet });

  const bg = buildBackgrounds(workDir, theme);
  const textCount = new Map();
  const textFile = (tag, content) => {
    const n = (textCount.get(tag) || 0) + 1;
    textCount.set(tag, n);
    const name = 'txt_' + tag + '_' + n + '.txt';
    fs.writeFileSync(path.join(workDir, name), String(content) + '\n', 'utf8');
    return name;
  };
  const absImage = (scene) => {
    if (!scene.imagePath) throw new Error('scene of type ' + scene.type + ' needs imagePath');
    const p = path.isAbsolute(scene.imagePath) ? scene.imagePath : path.resolve(scriptDir, scene.imagePath);
    if (!fs.existsSync(p)) throw new Error('image not found: ' + p);
    return p;
  };

  // ---- timeline (frame accurate)
  const scenes = script.scenes.map((s, i) => {
    const type = s.type === 'title' ? 'hook' : s.type;
    if (!SCENE_TYPES.has(s.type)) throw new Error('scene ' + i + ': unknown type "' + s.type + '"');
    const frames = Math.max(1, Math.round(Number(s.durationSec || 0) * fps));
    return { ...s, type: type, frames: frames, durationSec: frames / fps };
  });
  const rawOverlap = Number(script.transitionSec === undefined ? 0.4 : script.transitionSec);
  const minDur = Math.min(...scenes.map((s) => s.durationSec));
  const overlap = rawOverlap > 0 ? Math.min(rawOverlap, minDur / 3) : 0;
  const starts = [];
  const clipDur = scenes.map((s) => Math.round(s.durationSec * fps) / fps);
  let acc = 0;
  scenes.forEach((s, i) => {
    starts.push(acc - i * overlap);
    acc += clipDur[i];
  });
  const totalSec = Math.round((acc - Math.max(0, scenes.length - 1) * overlap) * 1000) / 1000;
  const totalFrames = Math.round(totalSec * fps);

  const ctx = {
    fps, theme, bg, workDir, script, run, textFile, absImage,
  };

  // ---- per-scene clips
  const clips = [];
  const log = [];
  __resetClipIndex();
  scenes.forEach((scene, i) => {
    const isLast = i === scenes.length - 1;
    const filterFile = path.join(workDir, 'clip_' + String(i).padStart(3, '0') + '.txt');
    let filter;
    if (scene.type === 'hook') filter = hookFilter(scene, ctx, i, isLast);
    else if (scene.type === 'quote') filter = quoteFilter(scene, ctx, i, isLast);
    else if (scene.type === 'screen') filter = screenFilter(scene, ctx, i, isLast);
    else if (scene.type === 'sticker') filter = stickerFilter(scene, ctx, i, isLast);
    else if (scene.type === 'fx') filter = fxFilter(scene, ctx, i, isLast);
    else if (scene.type === 'term') filter = termFilter(scene, ctx, i, isLast);
    else throw new Error('unhandled scene type ' + scene.type);
    fs.writeFileSync(filterFile, filter, 'utf8');
    const clip = path.join(workDir, 'clip_' + String(i).padStart(3, '0') + '.mp4');
    run(sceneInputs(scene, ctx).concat([
      '-filter_complex_script', filterFile, '-map', '[vout]',
      '-frames:v', String(scene.frames), '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-an', '-video_track_timescale', '90000', clip,
    ]), 'clip' + i + ':' + scene.type);
    clips.push(clip);
    log.push({ index: i, type: scene.type, startSec: Math.round(starts[i] * 1000) / 1000, durationSec: scene.durationSec, frames: scene.frames });
  });

  // ---- subtitles
  const cues = buildCues(scenes, starts, overlap);
  scenes.forEach((s, i) => {
    if (!s.anim) return;
    const a = starts[i];
    const b = starts[i] + s.durationSec;
    cues.forEach((c) => {
      if (c.endMs / 1000 > a && c.startMs / 1000 < b) c.anim = s.anim;
    });
  });
  const assFile = 'subs.ass';
  writeAss(path.join(workDir, assFile), cues, {
    width: WIDTH, height: HEIGHT, font: theme.assFont, fontSize: theme.sizes.ass,
    primary: theme.text, outline: '#05080f', marginV: 86, marginLR: 130,
    outlineWidth: 4, shadow: 2, maxCharsPerLine: 21,
  });

  // ---- audio: procedural BGM + optional narration
  const hasVoice = scenes.some((s) => s.voicePath);
  const bgmFile = 'bgm.wav';
  if (script.bgm === false) {
    const n = Math.ceil(totalSec * 48000);
    writeWav16(path.join(workDir, bgmFile), new Float32Array(n), new Float32Array(n), 48000);
  } else {
    writeBgm(path.join(workDir, bgmFile), { durationSec: totalSec, sr: 48000 });
  }
  const bgmVolume = hasVoice ? 0.0794 : 0.22; // -22dB when narration is present

  // ---- final assembly: xfade chain + burned subtitles + audio mix
  const chain = [];
  clips.forEach((_, i) => {
    chain.push('[' + i + ':v]settb=AVTB,fps=' + fps + ',format=yuv420p[v' + i + ']');
  });
  let cur = 'v0';
  let transIdx = 0;
  const transitions = Array.isArray(script.transitions) && script.transitions.length
    ? script.transitions
    : ['fade', 'slideleft', 'circleopen', 'slideup', 'fade', 'slideleft'];
  for (let i = 1; i < clips.length; i++) {
    const next = 'x' + i;
    const offset = Math.max(0, starts[i]);
    const trans = overlap > 0 ? transitions[transIdx++ % transitions.length] : 'fade';
    if (overlap > 0) {
      chain.push('[' + cur + '][v' + i + ']xfade=transition=' + trans + ':duration=' + overlap.toFixed(3) + ':offset=' + offset.toFixed(3) + '[' + next + ']');
    } else {
      chain.push('[' + cur + '][v' + i + ']concat=n=2:v=1:a=0[' + next + ']');
    }
    cur = next;
  }
  chain.push('[' + cur + ']ass=' + frel(assFile) + '[vout]');

  const bgmIdx = clips.length;
  const audioParts = [];
  chain.push('[' + bgmIdx + ':a]volume=' + bgmVolume + ',atrim=0:' + totalSec.toFixed(3) + ',asetpts=N/SR/TB[bg]');
  audioParts.push('[bg]');
  let mixIdx = 1;
  scenes.forEach((s, i) => {
    if (!s.voicePath) return;
    const p = path.isAbsolute(s.voicePath) ? s.voicePath : path.resolve(scriptDir, s.voicePath);
    if (!fs.existsSync(p)) throw new Error('voice not found: ' + p);
    const idx = bgmIdx + mixIdx;
    const delayMs = Math.max(0, Math.round(Math.max(0, starts[i]) * 1000));
    chain.push('[' + idx + ':a]adelay=delays=' + delayMs + ':all=1,asetpts=N/SR/TB[vc' + mixIdx + ']');
    audioParts.push('[vc' + mixIdx + ']');
    mixIdx++;
  });
  if (audioParts.length > 1) {
    chain.push(audioParts.join('') + 'amix=inputs=' + audioParts.length + ':duration=longest:normalize=0:dropout_transition=0[mx]');
    chain.push('[mx]apad,atrim=0:' + totalSec.toFixed(3) + ',asetpts=N/SR/TB[aout]');
  } else {
    chain.push('[bg]apad,atrim=0:' + totalSec.toFixed(3) + ',asetpts=N/SR/TB[aout]');
  }

  const finalFilter = path.join(workDir, 'final_filter.txt');
  fs.writeFileSync(finalFilter, chain.join(';\n'), 'utf8');
  const videoPath = path.join(outDir, (script.slug || 'video') + '.mp4');
  const inputArgs = [];
  clips.forEach((c) => inputArgs.push('-i', c));
  inputArgs.push('-i', path.join(workDir, bgmFile));
  scenes.forEach((s) => {
    if (!s.voicePath) return;
    const p = path.isAbsolute(s.voicePath) ? s.voicePath : path.resolve(scriptDir, s.voicePath);
    inputArgs.push('-i', p);
  });
  run(inputArgs.concat([
    '-filter_complex_script', finalFilter, '-map', '[vout]', '-map', '[aout]',
    '-t', String(totalSec), '-r', String(fps),
    '-c:v', 'libx264', '-preset', opts.preset, '-crf', String(opts.crf), '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', videoPath,
  ]), 'final');

  // ---- cover / meta / probe / preview frames
  const coverPath = renderCover(ctx, outDir, script);
  const info = probe({ ffmpeg: ffmpeg, file: videoPath, cwd: workDir });

  const framesDir = ensureDir(path.join(outDir, 'frames'));
  const framePicks = [];
  const count = Math.max(1, opts.frames);
  for (let k = 0; k < count; k++) {
    const frac = k === 0 ? 0.12 : k === count - 1 ? 0.82 : 0.45;
    const at = Math.min(totalSec - 0.2, Math.max(0, totalSec * frac));
    const f = path.join(framesDir, 'frame_' + String(k + 1).padStart(2, '0') + '.png');
    run(['-ss', at.toFixed(3), '-i', videoPath, '-frames:v', '1', '-pix_fmt', 'rgb24', f], 'frame' + k);
    framePicks.push({ file: f, atSec: Math.round(at * 1000) / 1000 });
  }

  const firstFrame = firstFrameGate({ ffmpeg: ffmpeg, video: videoPath, dir: workDir, outDir: outDir });
  if (!firstFrame.ok) process.exitCode = 3;
  const assFont = checkAssFont(theme.assFont);
  if (!assFont.ok) {
    process.stderr.write('ASS-FONT FAIL: family=' + assFont.family + ' (' + assFont.reasons.join('; ') + ')' + String.fromCharCode(10));
    process.exitCode = 3;
  }

  const meta = {
    title: script.title || '',
    desc: script.desc || [script.title, script.subtitle].filter(Boolean).join(' | '),
    tags: script.tags || [],
    cover: path.basename(coverPath),
    durationSec: info.durationSec,
    episode: script.episode || null,
    video: path.basename(videoPath),
    resolution: WIDTH + 'x' + HEIGHT,
    fps: fps,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify({
    totalSec, fps, overlap, cueCount: cues.length,
    scenes: log,
    cues: cues.map((c) => ({ startSec: Math.round(c.startMs) / 1000, endSec: Math.round(c.endMs) / 1000, text: c.text })),
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');

  if (!opts.keep) rmrf(workDir);

  const summary = {
    video: videoPath, cover: coverPath, meta: path.join(outDir, 'meta.json'),
    durationSec: info.durationSec, resolution: info.video ? info.video.width + 'x' + info.video.height : null,
    fps: info.video ? info.video.fps : null, bitrateKbps: info.overallBitrateKbps,
    audio: info.audio, frames: framePicks, scenes: log.length, cues: cues.length,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('render failed: ' + err.message);
  process.exit(1);
});