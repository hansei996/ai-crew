#!/usr/bin/env node
// probe_conform.mjs — 风格探针/成片的发布侧一致性检查（4 版必须同规格才可并排）。
// 检查项：①规格 8.00s±0.05 / 1920x1080 / 30fps ②首帧 P0-0（PNG >300KB 且 YAVG ≥ 背景YAVG+8）
//        ③竖版死区活跃度（x0-420 与 x1500-1920 是否承载内容）④响度 I/TP/LRA
// 用法：node probe_conform.mjs <file.mp4 ...> [--json out.json]
// 退出码：0 全部通过 / 1 有不合格项
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { p0 as p0check, STRICT as P0_STRICT } from "./lib/p0.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = path.join(HERE, "..", "_tooling", "ffmpeg.exe");
const TMPDIR = path.join(HERE, "_scratch", "conform-tmp");

export const RULES = {
  durationSec: 8.0, durationTol: 0.05, width: 1920, height: 1080, fps: 30, fpsTol: 0.2,
  p0MinSpread: 40, p0MinContentRatio: 0.001,   // PMO 2026-10-25 定稿；体积与 YAVG 已退出判据
  loudness: { iTarget: -14, iTol: 1.0, tpMax: -1.0, lraMax: 7.0 },
  mainZone: { x0: 420, x1: 1500 },      // 竖版主食区（见 visual/publish-visual.md §3）
  deadZones: [{ x0: 0, x1: 420 }, { x0: 1500, x1: 1920 }],
};

// 探针调色板（VISUAL.md §15）：背景色 → BT.601 limited-range 亮度（Y 16..235 映射）
const PALETTE = {
  A: "#000000", B: "#0A0A0C", C: "#06101C", D: "#F5F1E6",
};

export function hexToYAvg(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;   // BT.601 full-range luma
  return 16 + y * (219 / 255);                    // 映射到 limited range（16..235）
}

export function probeOf(file) {
  const base = path.basename(file).toUpperCase();
  for (const k of Object.keys(PALETTE)) if (new RegExp("(^|[^A-Z])" + k + "([^A-Z]|$)").test(base)) return k;
  return null;
}

function run(args) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats"].concat(args), { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return String(r.stderr || "") + String(r.stdout || "");
}

function probeMeta(file) {
  const out = run(["-i", file]);
  const d = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dur = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const dim = out.match(/(\d{3,5})x(\d{3,5})\s*[\[,\s]/);
  const fp = out.match(/([0-9.]+)\s*fps/);
  const hasAudio = /Stream #\S+.*?Audio:/.test(out);
  return { duration: dur, width: dim ? Number(dim[1]) : null, height: dim ? Number(dim[2]) : null, fps: fp ? Number(fp[1]) : null, hasAudio };
}

function ystats(file, ss, crop) {
  const vf = (crop ? "crop=" + crop + "," : "") + "signalstats,metadata=print:file=-";
  const out = run(["-ss", String(ss), "-i", file, "-frames:v", "1", "-vf", vf, "-f", "null", "-"]);
  const y = out.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  const s = out.match(/lavfi\.signalstats\.YSTD=([\d.]+)/);
  return { yavg: y ? Number(y[1]) : null, ystd: s ? Number(s[1]) : null };
}

function firstFramePng(file, dir) {
  const p = path.join(dir, "t0_" + path.basename(file, path.extname(file)) + ".png");
  const out = run(["-y", "-loglevel", "error", "-ss", "0", "-i", file, "-frames:v", "1", p]);
  if (!existsSync(p)) { console.log("  [warn] 首帧抽取失败: " + out.split("\n").slice(0, 3).join(" / ")); return null; }
  return statSync(p).size;
}

function loudness(file) {
  const out = run(["-i", file, "-af", "loudnorm=I=-14:TP=-1.0:LRA=7:print_format=json", "-f", "null", "-"]);
  const flat = out.replace(/"/g, "");
  const grab = (k) => { const m = flat.match(new RegExp(k + "\\s*:\\s*(-?[0-9.]+)")); return m ? Number(m[1]) : null; };
  return { i: grab("input_i"), tp: grab("input_tp"), lra: grab("input_lra") };
}

export function check(file, probeOverride) {
  mkdirSync(TMPDIR, { recursive: true });
  const tmp = TMPDIR;
  try {
    const meta = probeMeta(file);
    const pid = probeOverride || probeOf(file);
    const bgHex = pid ? PALETTE[pid] : null;
    const bgY = bgHex ? hexToYAvg(bgHex) : null;
    const pngBytes = firstFramePng(file, tmp);   // 仅供人工目视留档，不再参与判据
    const p0r = p0check(file, "0", P0_STRICT);       // 探针严格档：spread ≥80
    const samples = [0.5, 2, 4, 6].filter((t) => !meta.duration || t < meta.duration);
    const dead = RULES.deadZones.map((z) => {
      const w = z.x1 - z.x0;
      const vals = samples.map((t) => ystats(file, t, w + ":1080:" + z.x0 + ":0"));
      return { zone: z, yavgMax: Math.max(...vals.map((v) => v.yavg || 0)), ystdMax: Math.max(...vals.map((v) => v.ystd || 0)) };
    });
    const mainVals = samples.map((t) => ystats(file, t, "1080:1080:" + RULES.mainZone.x0 + ":0"));
    const mainYavg = Math.max(...mainVals.map((v) => v.yavg || 0));
    const lu = loudness(file);

    const checks = [];
    const C = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
    C("duration", meta.duration !== null && Math.abs(meta.duration - RULES.durationSec) <= RULES.durationTol,
      (meta.duration === null ? "读不到时长" : meta.duration.toFixed(2) + "s（要求 " + RULES.durationSec + "±" + RULES.durationTol + "s）"));
    C("resolution", meta.width === RULES.width && meta.height === RULES.height, (meta.width || "?") + "x" + (meta.height || "?"));
    C("fps", meta.fps !== null && Math.abs(meta.fps - RULES.fps) <= RULES.fpsTol, (meta.fps === null ? "?" : meta.fps) + " fps（要求 " + RULES.fps + "）");
    C("p0-0-spread", p0r.ok && p0r.spread >= P0_STRICT.minSpread, p0r.ok ? "spread(YMAX-YMIN)=" + p0r.spread + "（探针要求 ≥" + P0_STRICT.minSpread + "）" : "抽帧失败");
    C("p0-0-content", p0r.ok && p0r.ratio >= 0.001, p0r.ok ? "内容 " + p0r.content + " px = " + (p0r.ratio * 100).toFixed(3) + "%（要求 ≥0.100% / " + p0r.needContent + " px）" : "抽帧失败");
    const worstDead = dead.reduce((a, b) => (b.ystdMax > a.ystdMax ? b : a), dead[0]);
    C("dead-zone-clean", worstDead.ystdMax <= 6 && worstDead.yavgMax <= mainYavg + 8,
      "死区 YSTD max=" + worstDead.ystdMax.toFixed(2) + " / YAVG max=" + worstDead.yavgMax.toFixed(1) + "；主食区 YAVG max=" + mainYavg.toFixed(1) + "（死区承载内容则竖版会丢信息）");
    const L = RULES.loudness;
    if (!meta.hasAudio) C("loudness", true, "无音轨（视觉探针可接受；正式 EP 必须过 I=" + L.iTarget + "±" + L.iTol + " / TP≤" + L.tpMax + "）");
    else C("loudness", lu.i !== null && Math.abs(lu.i - L.iTarget) <= L.iTol && (lu.tp === null || lu.tp <= L.tpMax),
      "I=" + lu.i + " LUFS（目标 " + L.iTarget + "±" + L.iTol + "）/ TP=" + lu.tp + " dBTP（≤" + L.tpMax + "）/ LRA=" + lu.lra);
    return { file, probe: pid, meta, pngBytes, p0: p0r, dead, mainYavg, loudness: lu, checks, ok: checks.every((c) => c.ok) };
  } finally { /* 保留 _scratch/conform-tmp 下的 t0_*.png 供人工复核 */ }
}

function main() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--probe"));
  if (!files.length) { console.log("node probe_conform.mjs <file.mp4 ...> [--json out.json]"); return 2; }
  const pi = argv.indexOf("--probe");
  const po = pi >= 0 ? String(argv[pi + 1]).toUpperCase() : null;
  const results = files.map((f) => check(path.resolve(f), po));
  for (const r of results) {
    console.log("=== " + path.basename(r.file) + (r.probe ? " （探针 " + r.probe + "）" : ""));
    for (const c of r.checks) console.log((c.ok ? "  PASS " : "  FAIL ") + c.id + " — " + c.detail);
    console.log("  => " + (r.ok ? "CONFORM OK" : "CONFORM FAIL"));
  }
  const ji = argv.indexOf("--json");
  if (ji >= 0 && argv[ji + 1]) { writeFileSync(path.resolve(argv[ji + 1]), JSON.stringify(results, null, 2) + "\n", "utf8"); console.log("json=" + argv[ji + 1]); }
  return results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
