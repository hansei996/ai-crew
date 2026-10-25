// lib/p0.mjs — P0-0 首帧判据（PMO 2026-10-25 定稿口径）。
// 抽 t=0 → -pix_fmt gray 原始帧，逐像素判：
//   ① spread = YMAX − YMIN ≥ 40
//   ② 内容像素占比 = |Y − 背景众数| > 20 的像素数 ÷ 2,073,600 ≥ 0.001（即 ≥2,074 px）
// 体积与 YAVG 阈值已退出判据（体积误杀 C 这类小体积但有内容的版式；YAVG 对亮底恒过）。
// ---------------------------------------------------------------------------
// 实现陷阱（由 lab 在写离线版自检时踩到，2026-10-25 实测；本文件是唯一实现，故把坑记在这里）
//
// 1) 带逗号的表达式进 filtergraph 必须用单引号包住。
//    lab 错误写法: -vf "lutyuv=y=if(gte(val\,64)\,255\,0)"  -> 掩码恒为全黑，内容像素恒 0。
//    正确写法:     -vf "geq=lum='if(gt(lum(X,Y),64),255,0)'" -> 结果正确。
//    本文件走的是 -f rawvideo -pix_fmt gray 自己数像素，不经过 filter 表达式，天然避开这个坑——**别为了省事改回滤镜实现**。
//
// 2) PowerShell 里调 ffmpeg 时必须 $ErrorActionPreference='Continue'。ffmpeg 把统计与进度写 stderr，
//    设成 Stop 会被当成致命错误抛出，脚本还没开始判断就中断。
//
// 3) 阈值不能跨底色复用。lab 那版用 Y>64 只对深底（#000000 / #06101C）成立；浅底片整帧都会被判成内容。
//    本文件用「离背景众数 > 20」（RULE.contentDelta），才是普适写法，改阈值请只改 RULE 常量。
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FFMPEG = path.join(HERE, "..", "..", "_tooling", "ffmpeg.exe");
export const RULE = { minSpread: 40, minContentRatio: 0.001, contentDelta: 20, width: 1920, height: 1080 };
// 探针严格档（PMO 2026-10-25）：spread 不得踩线，一律 ≥80；踩线过线＝上线后随机 FAIL，最难查。
export const STRICT = { ...RULE, minSpread: 80 };
export const PIXELS = RULE.width * RULE.height;   // 2,073,600

/** 抽取 t=0 灰度原始帧（Buffer，长度应为 2,073,600）。 */
export function grayFrame0(file, at = "0") {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-loglevel", "error", "-ss", at, "-i", file,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const buf = r.stdout;
  if (!buf || buf.length < PIXELS) return { ok: false, bytes: buf ? buf.length : 0, err: String(r.stderr || "").slice(0, 200) };
  return { ok: true, buf: buf.subarray(0, PIXELS), bytes: buf.length };
}

/** 对灰度 Buffer 逐像素统计。 */
export function stats(buf, rule = RULE) {
  const hist = new Uint32Array(256);
  let ymin = 255, ymax = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    hist[v]++;
    if (v < ymin) ymin = v;
    if (v > ymax) ymax = v;
  }
  let mode = 0;
  for (let i = 1; i < 256; i++) if (hist[i] > hist[mode]) mode = i;
  let content = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i] - mode) > RULE.contentDelta) content++;
  const ratio = content / buf.length;
  const spread = ymax - ymin;
  return { pixels: buf.length, ymin, ymax, spread, mode, modeCount: hist[mode], content, ratio,
    pass: spread >= rule.minSpread && ratio >= rule.minContentRatio };
}

/** 一步到位：文件 → P0-0 判定。 */
export function p0(file, at = "0", rule = RULE) {
  const f = grayFrame0(file, at);
  if (!f.ok) return { ok: false, err: f.err, pass: false };
  const s = stats(f.buf, rule);
  return { ok: true, ...s, rule, needContent: Math.ceil(PIXELS * rule.minContentRatio) };
}

export function formatP0(label, r) {
  if (!r.ok) return label + ": 抽帧失败 " + (r.err || "");
  const R = r.rule || RULE;
  return label + ": spread=" + r.spread + (r.spread >= R.minSpread ? " ✓" : " ✗") +
    " / 内容 " + r.content + " px = " + (r.ratio * 100).toFixed(3) + "%" + (r.ratio >= R.minContentRatio ? " ✓" : " ✗") +
    "（门槛 spread≥" + R.minSpread + "，内容≥" + r.needContent + " px / " + (R.minContentRatio * 100).toFixed(1) + "%）" +
    " → " + (r.pass ? "PASS" : "FAIL");
}

// CLI：node lib/p0.mjs <file...> [--at 0.05]
function main() {
  const a = process.argv.slice(2);
  const ai = a.indexOf("--at");
  const at = ai >= 0 ? a[ai + 1] : "0";
  const strict = a.includes("--strict");
  const rule = strict ? STRICT : RULE;
  const files = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1] === "--at"));
  if (!files.length) { console.log("node lib/p0.mjs <file.mp4...> [--at 0] [--strict]"); return 2; }
  let bad = 0;
  for (const f of files) {
    const r = p0(path.resolve(f), at, rule);
    if (!r.pass) bad++;
    console.log(formatP0(path.basename(f), r));
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
