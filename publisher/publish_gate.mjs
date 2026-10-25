#!/usr/bin/env node
// publish_gate.mjs — 发布前置硬闸。upload.mjs 之前必须先跑它；不通过一律非零退出。
// 参数由 lead 2026-10-25 裁决写死（不许改成"仅提示"）：
//   1 条/日 · 投稿间隔 >=24h · 分片并发 1 · 分片 4MB · 请求间 3–8s 抖动 · 稿件编辑 <=2 次/日
//   601 -> 停手 + 报 lead + 24h 内不走任何投稿 API
// 自检：时长 45–90s / 1920x1080 / 有人声音轨(非静音) / 封面 JPEG / daily.json closedToday / AI 声明 / 不带 neutral_mark
//
// 用法：
//   node publish_gate.mjs --file ..\episodes\ep03\out\ep03.mp4 --meta ..\episodes\ep03\out\publish.json
//   node publish_gate.mjs --kind edit ...        # 计"稿件编辑"配额
//   node publish_gate.mjs --risk-601 [--bvid BV]  # 记录一次 601 事件并开 24h 冷却
// 退出码：0 通过 / 1 拦下 / 3 处在 601 冷却期
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { p0 as p0check } from "./lib/p0.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const STATE = path.join(ROOT, "state");
const FFMPEG = path.join(ROOT, "_tooling", "ffmpeg.exe");

export const RULES = {
  maxPerDay: 1,
  minIntervalHours: 24,
  uploadConcurrency: 1,
  chunkSizeMB: 4,
  jitterMs: [3000, 8000],
  maxEditsPerDay: 2,
  risk601CooldownHours: 24,
  minDurationSec: 45,
  maxDurationSec: 90,
  expectedWidth: 1920,
  expectedHeight: 1080,
  minMeanVolumeDb: -45,
};

let DAILY_PATH = path.join(STATE, "daily.json");
let LOG_PATH = path.join(STATE, "publish_log.json");
let RISK601_PATH = path.join(STATE, "publish_601.json");

const shNow = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace("Z", "+08:00");
const shDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const loadJson = (p, f) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return f; } };
const hours = (ms) => ms / 3600e3;

function probe(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const out = String(r.stderr || "") + String(r.stdout || "");
  const dm = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSec = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : null;
  const vm = out.match(/Stream #\S+.*?Video:.*?(\d{2,5})x(\d{2,5})/);
  const hasAudio = /Stream #\S+.*?Audio:/.test(out);
  return { durationSec, width: vm ? Number(vm[1]) : null, height: vm ? Number(vm[2]) : null, hasAudio, raw: out.slice(0, 4000) };
}

// P0-0 首帧：体积(>300KB) + YAVG(≥ 背景 YAVG+8)。背景 YAVG 按 BT.601 限幅换算。
const PROBE_BG = { A: "#000000", B: "#0A0A0C", C: "#06101C", D: "#F5F1E6" };
export function hexToYAvg(hex) {
  const h = String(hex).replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 16 + (0.299 * r + 0.587 * g + 0.114 * b) * (219 / 255);
}
function firstFrame(file) {
  const scratch = path.join(HERE, "_scratch");
  try { mkdirSync(scratch, { recursive: true }); } catch {}
  const out = path.join(scratch, "gate_t0.png");
  spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-y", "-loglevel", "error", "-ss", "0", "-i", file, "-frames:v", "1", out], { encoding: "utf8" });
  let bytes = null;
  try { bytes = statSync(out).size; } catch { bytes = null; }
  const st = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-ss", "0", "-i", file, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const txt = String(st.stderr || "") + String(st.stdout || "");
  const m = txt.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  return { bytes, yavg: m ? Number(m[1]) : null };
}
function meanVolume(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-map", "a:0", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const out = String(r.stderr || "");
  const m = out.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return m ? Number(m[1]) : null;
}

function isJpeg(p) {
  try {
    const b = readFileSync(p).subarray(0, 3);
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  } catch { return false; }
}

function parseArgs(argv) {
  const a = { kind: "submit" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--file") { a.file = path.resolve(v); i++; }
    else if (k === "--meta") { a.meta = path.resolve(v); i++; }
    else if (k === "--cover") { a.cover = path.resolve(v); i++; }
    else if (k === "--kind") { a.kind = v; i++; }
    else if (k === "--bvid") { a.bvid = v; i++; }
    else if (k === "--daily") { a.daily = path.resolve(v); i++; }
    else if (k === "--log") { a.log = path.resolve(v); i++; }
    else if (k === "--risk601") { a.risk601 = path.resolve(v); i++; }
    else if (k === "--no-log") a.noLog = true;
    else if (k === "--mark-601") a.mark601 = true;
    else if (k === "--probe") { a.probe = String(v).toUpperCase(); i++; }
    else if (k === "--bg") { a.bg = v; i++; }
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.daily) DAILY_PATH = args.daily;
  if (args.log) LOG_PATH = args.log;
  if (args.risk601) RISK601_PATH = args.risk601;
  if (args.help) { console.log("node publish_gate.mjs --file <mp4> --meta <publish.json> [--cover jpg] [--kind submit|edit] [--no-log]"); return 0; }

  const nowMs = Date.now();
  const today = shDate(nowMs);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: String(detail) });

  // --- 0. 记录一次 601 事件（不校验媒体） ---
  if (args.mark601) {
    const rec = loadJson(RISK601_PATH, []);
    const list = Array.isArray(rec) ? rec : [];
    list.push({ ts: new Date(nowMs).toISOString(), tsLocal: shNow(nowMs), code: 601, bvid: args.bvid || null, note: "上传返回 601：立即停手、不重试、24h 内不走投稿 API" });
    writeFileSync(RISK601_PATH, JSON.stringify(list, null, 2) + "\n", "utf8");
    console.log("已记录 601 事件 -> " + RISK601_PATH + "（冷却 " + RULES.risk601CooldownHours + "h）");
    return 3;
  }

  // --- 1. 601 冷却 ---
  const risk = loadJson(RISK601_PATH, []);
  const lastRisk = (Array.isArray(risk) ? risk : []).filter((x) => x && x.ts).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  if (lastRisk) {
    const h = hours(nowMs - Date.parse(lastRisk.ts));
    add("risk601-cooldown", h >= RULES.risk601CooldownHours, h >= RULES.risk601CooldownHours
      ? "上次 601 在 " + lastRisk.tsLocal + "，已过 " + h.toFixed(1) + "h"
      : "上次 601 在 " + lastRisk.tsLocal + "，仅过 " + h.toFixed(1) + "h（<" + RULES.risk601CooldownHours + "h）");
  }

  // --- 2. 日上限 / closedToday ---
  const daily = loadJson(DAILY_PATH, null);
  if (!daily) add("daily-json", false, "读不到 " + DAILY_PATH);
  else {
    const isToday = daily.date === today || !daily.date;
    add("daily-closed", !(isToday && daily.closedToday === true), isToday && daily.closedToday === true ? "daily.json closedToday=true（今日封盘）" : "closedToday 未置位");
    const pubToday = (daily.publishedToday || []).filter((x) => !x.date || String(x.at || x.date || "").startsWith(today) || isToday);
    add("daily-cap", pubToday.length < RULES.maxPerDay, "今日已发 " + pubToday.length + "/" + RULES.maxPerDay + " 条");
  }

  // --- 3. 投稿间隔 >=24h（取 publish_log 里最近一次成功提交/编辑） ---
  const log = loadJson(LOG_PATH, []);
  const list = Array.isArray(log) ? log : [];
  const submits = list.filter((x) => x && x.result === "pass" && (x.kind === "submit") && x.ts).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (args.kind === "submit") {
    if (!submits.length) add("interval-24h", true, "无历史成功提交，间隔检查跳过");
    else {
      const h = hours(nowMs - Date.parse(submits[0].ts));
      add("interval-24h", h >= RULES.minIntervalHours, "距上次提交 " + h.toFixed(1) + "h（需 >=" + RULES.minIntervalHours + "h，上次 " + (submits[0].tsLocal || submits[0].ts) + "）");
    }
  } else {
    const editsToday = list.filter((x) => x && x.kind === "edit" && x.result === "pass" && (x.date || (x.ts && shDate(Date.parse(x.ts)))) === today).length;
    add("edit-budget", editsToday < RULES.maxEditsPerDay, "今日编辑 " + editsToday + "/" + RULES.maxEditsPerDay + " 次");
  }

  // --- 4. 媒体自检 ---
  if (!args.file) add("file", false, "缺少 --file");
  else if (!existsSync(args.file)) add("file", false, "文件不存在 " + args.file);
  else {
    const st = statSync(args.file);
    add("file", st.size > 1024 * 1024, "大小 " + (st.size / 1048576).toFixed(1) + "MB");
    const p = probe(args.file);
    const d = p.durationSec;
    add("duration", d !== null && d >= RULES.minDurationSec && d <= RULES.maxDurationSec,
      d === null ? "解析不到时长" : d.toFixed(1) + "s（要求 " + RULES.minDurationSec + "–" + RULES.maxDurationSec + "s）");
    add("resolution", p.width === RULES.expectedWidth && p.height === RULES.expectedHeight,
      (p.width || "?") + "x" + (p.height || "?") + "（要求 " + RULES.expectedWidth + "x" + RULES.expectedHeight + "）");
    add("audio-stream", p.hasAudio, p.hasAudio ? "存在音频流" : "无音频流");
    if (p.hasAudio) {
      const mv = meanVolume(args.file);
      const p0r = p0check(args.file, "0");   // PMO 定稿：spread≥40 且 内容占比≥0.1%（体积/YAVG 已退出）
      add("p0-0-spread", p0r.ok && p0r.spread >= 40, p0r.ok ? "spread(YMAX-YMIN)=" + p0r.spread + "（要求 ≥40）" : "抽帧失败");
      add("p0-0-content", p0r.ok && p0r.ratio >= 0.001, p0r.ok ? "内容 " + p0r.content + " px = " + (p0r.ratio * 100).toFixed(3) + "%（要求 ≥0.100%）" : "抽帧失败");
      add("voice-level", mv !== null && mv >= RULES.minMeanVolumeDb,
        mv === null ? "volumedetect 取不到 mean_volume" : "mean_volume " + mv + " dB（需 >=" + RULES.minMeanVolumeDb + " dB，防静音/无人声）");
    }
  }

  // --- 5. 封面 JPEG ---
  const meta = args.meta ? loadJson(args.meta, null) : null;
  if (args.meta && !meta) add("meta-json", false, "读不到 meta " + args.meta);
  const coverPath = args.cover || (meta && meta.cover) || null;
  if (!coverPath) add("cover", false, "未提供封面（--cover 或 meta.cover）");
  else {
    const extOk = /\.(jpe?g)$/i.test(coverPath);
    add("cover-jpeg", extOk && existsSync(coverPath) && isJpeg(coverPath), (existsSync(coverPath) ? coverPath : "不存在 " + coverPath) + (extOk ? "" : " 扩展名非 jpg/jpeg"));
  }

  // --- 6. meta 合规 ---
  if (meta) {
    add("meta-title", typeof meta.title === "string" && meta.title.trim().length > 0, meta.title ? "标题 " + meta.title.length + " 字" : "标题为空");
    const desc = String(meta.desc || "");
    const forbidden = /(1\.26\s*秒|1\.7\s*秒|1\.72\s*秒|1\.723)/;
    const titleHit = forbidden.test(String(meta.title || ""));
    add("meta-no-volatile-number", !titleHit, titleHit
      ? "标题含易变耗时数字（1.26/1.7/1.723 秒）：不同机器实测 0.62/1.06/1.72s 波动 2.8 倍，禁止出现在标题与角标"
      : "标题未含易变耗时数字");
    add("meta-ai-disclosure", /AI/.test(desc) && /(AI|合成|自动)/.test(desc), /AI/.test(desc) ? "简介含 AI 相关声明" : "简介缺「含 AI 生成内容」声明");
    const nm = meta.neutral_mark;
    add("meta-no-neutral-mark", nm === undefined || nm === null || nm === "", nm === undefined ? "未携带 neutral_mark" : "携带 neutral_mark=" + JSON.stringify(nm) + "（21517 会拒）");
  }

  const fails = checks.filter((c) => !c.ok);
  const failIds = fails.map((c) => c.id);
  const code = failIds.includes("risk601-cooldown") ? 3 : fails.length ? 1 : 0;

  console.log("publish_gate · kind=" + args.kind + " · " + shNow(nowMs));
  console.log("params: " + RULES.maxPerDay + "条/日 · 间隔>=" + RULES.minIntervalHours + "h · 并发" + RULES.uploadConcurrency + " · 分片" + RULES.chunkSizeMB + "MB · 抖动" + RULES.jitterMs[0] + "-" + RULES.jitterMs[1] + "ms · 编辑<=" + RULES.maxEditsPerDay + "/日 · 601冷却" + RULES.risk601CooldownHours + "h");
  for (const c of checks) console.log((c.ok ? "  PASS " : "  FAIL ") + c.id + " — " + c.detail);

  if (!args.noLog) {
    const out = loadJson(LOG_PATH, []);
    const arr = Array.isArray(out) ? out : [];
    arr.push({
      ts: new Date(nowMs).toISOString(), tsLocal: shNow(nowMs), date: today, kind: args.kind,
      result: code === 0 ? "pass" : "fail", file: args.file || null, bvid: args.bvid || null,
      durationSec: (checks.find((c) => c.id === "duration") || {}).detail || null,
      resolution: (checks.find((c) => c.id === "resolution") || {}).detail || null,
      checks: checks.map((c) => ({ id: c.id, ok: c.ok })), fails: failIds, by: "publish_gate.mjs",
    });
    writeFileSync(LOG_PATH, JSON.stringify(arr, null, 2) + "\n", "utf8");
  }

  if (code === 0) { console.log("RESULT: PASS —— 允许发布（仍需符合 upload 侧分片参数）"); return 0; }
  if (code === 3) { console.log("RESULT: BLOCKED —— 处在 601 冷却期，24h 内禁止任何投稿 API 调用"); return 3; }
  console.log("RESULT: FAIL —— 拦下，禁止上传。失败项: " + failIds.join(", "));
  return 1;
}

process.exit(main());
