// renderer/lib/firstframe.mjs — 渲染期 P0-0 首帧闸（B28）
//
// **唯一实现是 publisher/lib/p0.mjs**（能阻断发布的那份才算数）。本文件只是渲染期的薄适配层：
//   把 p0() 的结果翻译成 {ok, spread, contentRatio, reasons} + 供 render.mjs 打印/落盘。
// 之前这里曾有一份独立实现，与 p0.mjs 参数一致但属于重复实现 —— 按 PMO 定稿已删除（重复实现就是漂移源）。
// 判据（不变）：spread = YMAX-YMIN >= 40 且 内容像素占比 >= 0.1%（|Y-背景众数|>20）。
// 附加约定：spread 不得踩着 40 过线 —— 探针/成片按 >=80 做交付纪律（本模块只做硬闸，余量由构建方保证）。
import path from 'node:path';
import { p0, RULE } from '../../publisher/lib/p0.mjs';

export const FIRSTFRAME_RULES = RULE;

export function checkFirstFrame(cfg) {
  const video = path.resolve(cfg.video);
  const r = p0(video, String(cfg.at || '0'));
  if (!r.ok) {
    return { ok: false, spread: null, contentRatio: 0, reasons: ['extract-failed:' + (r.err || '')], video, bytes: 0 };
  }
  const reasons = [];
  if (r.spread < RULE.minSpread) reasons.push('spread<' + RULE.minSpread);
  if (r.ratio < RULE.minContentRatio) reasons.push('content<' + (RULE.minContentRatio * 100).toFixed(1) + 'pct');
  if (process.env.FF_GATE_FORCE_FAIL === '1') reasons.push('forced-by-env(test only)');
  return { ok: reasons.length === 0, spread: r.spread, contentRatio: r.ratio, contentPixels: r.content, mode: r.mode, ymin: r.ymin, ymax: r.ymax, reasons, video };
}

export function firstFrameFailLine(r) {
  const c = (r.contentRatio === null || r.contentRatio === undefined) ? 'n/a' : (r.contentRatio * 100).toFixed(3) + '%';
  return 'P0-0 FAIL: spread=' + (r.spread === null ? 'n/a' : r.spread) + ' content=' + c + (r.reasons && r.reasons.length ? ' (' + r.reasons.join('; ') + ')' : '');
}
export function firstFrameOkLine(r) {
  return 'P0-0 OK: spread=' + r.spread + ' content=' + (r.contentRatio * 100).toFixed(3) + '% mode=' + r.mode;
}

/** ASS 字体闸：family 名才放行；字体文件名会被 directwrite 解析成 ArialMT -> 中文豆腐块 */
export function checkAssFont(family, opts) {
  const o = opts || {};
  const v = String(family || '').trim();
  const bad = [];
  if (!v) bad.push('empty');
  if (/\.(ttf|ttc|otf|woff2?)$/i.test(v)) bad.push('looks-like-font-file');
  if (/-VF$/i.test(v) || /VF\./i.test(v)) bad.push('variable-font-filename');
  if (/[\\/]/.test(v)) bad.push('contains-path');
  if (o.requireCjkFamily !== false && !/Noto Sans SC|Source Han Sans|Microsoft YaHei|SimHei|思源|雅黑|黑体/i.test(v)) bad.push('not-a-cjk-family');
  return { ok: bad.length === 0, family: v, reasons: bad };
}
