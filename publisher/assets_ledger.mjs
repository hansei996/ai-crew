#!/usr/bin/env node
// assets_ledger.mjs — 素材台账：扫描素材目录，自动补 sha256/size，人工字段（来源/许可/证据）保留不覆盖。
// 铁律（lead 定）：没有台账的素材，渲染链路不得使用。
// 用法：
//   node assets_ledger.mjs                # 增量更新 ../assets/LEDGER.json（幂等）
//   node assets_ledger.mjs --check        # 只校验：有未登记/变更的素材就 exit 1（CI 用）
//   node assets_ledger.mjs --all          # 连非媒体文件（txt/json/html）也登记
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");            // bili_run/
export const LEDGER = path.join(ROOT, "assets", "LEDGER.json");
export const REPO_ROOT = ROOT;

const MEDIA = /\.(png|jpe?g|webp|gif|bmp|mp4|mov|mkv|webm|mp3|wav|m4a|flac|ogg|ass|ttf|otf|json|txt|md|html|csv|log)$/i;
// 台账自身与证据文档不算素材（否则每次写入都会自我 drift）
const EXCLUDE = new Set(["assets/LEDGER.json", "assets/LEDGER-EVIDENCE.md"]);
// 逐文件覆盖：文件落在某个根下但性质与该根不同（例：assets 根混了自产日志）
const FILE_POLICY = {
  "assets/tts_0330.log": { source: "自产：本项目 TTS 调试日志", license: "可商用", sourced: true, basis: "自产运行日志，无第三方内容", note: "资产根下唯一的自产文件；其余 4 张 png 仍为来源不明" },
};

// 默认范围＝媒体 + 会以文本/数据形式进片的证据文件（json/txt/md/html/csv/log）。
// 理由：证据文件也会被渲染成卡片（如 raw_contract.json 当终端输出展示），同样需要台账与许可结论。
// 目录级策略：自动判定只继承根策略，人工字段仍可逐个覆盖。
// license 取值：可商用 / 仅自用 / 未声明 / 禁用；sourced=false 表示找不到来源证据。
export const ROOTS = [
  {
    id: "assets-root", dir: "assets", recursive: false,
    source: "", license: "禁用", sourced: false,
    basis: "来源不明：全仓 grep 0 命中，无作者/仓库/采集记录，无授权证据 → 在补齐来源与许可前禁用",
    note: "大肥鱼形象相关 4 张（fish persona），归属 DeepSeek；三仓库均未声明二创授权",
  },
  {
    id: "assets-c01", dir: "assets/C01", recursive: true,
    source: "自产：lab 在 bili_run/lab/ 实测 C01(kajisho5/ffmpeg-skill) 时的截图与原始输出",
    license: "可商用", sourced: true,
    basis: "自产证据（截图/日志），无第三方版权内容；仓库 C01 本体为 MIT",
    note: "内容为终端截图与命令输出，非第三方素材",
  },
  {
    id: "sticker-pack", dir: "research/5V1A-afk__dsh-sticker-pack", recursive: true,
    source: "github: 5V1A-afk/dsh-sticker-pack", license: "未声明", sourced: true,
    basis: "API license=null + 仓内无 LICENSE/COPYING/NOTICE + README grep 0 命中 → 并未声明任何许可（非\"自称 MIT\"），按禁用处理",
    note: "拿到 LICENSE 原文或作者书面授权才可升级；证据见 assets/LEDGER-EVIDENCE.md",
  },
  {
    id: "memes-assets", dir: "research/memes-assets", recursive: true,
    source: "liceses/dsh-memes-reply（API license=null）；index.json 记录实际来源为本地目录 D:\\Pictures\\image_ACG\\蓝色大肥鱼表情包", license: "禁用", sourced: true,
    basis: "已判定：无 LICENSE、API license=null、来源是本地收藏目录而非开源 release → 禁用（1 张也不进成片）",
    note: "thumb/ 下为同名缩略图，derivativeOf 指向主文件",
  },
];

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
function walk(dir, recurse, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (recurse) walk(fp, recurse, out); }
    else out.push(fp);
  }
  return out;
}

export function loadLedger() {
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return null; }
}

/** 计算台账与磁盘的 drift（未登记 / sha256 变更 / 已消失），供 lib/assets.mjs 复用。 */
export function computeDrift() {
  const prev = loadLedger();
  if (!prev) return [{ path: LEDGER, kind: "ledger-missing" }];
  const known = new Map((prev.entries || []).map((e) => [e.path, e]));
  const drift = [];
  const seen = new Set();
  for (const r of ROOTS) {
    const abs = path.join(ROOT, r.dir);
    if (!existsSync(abs)) { drift.push({ path: r.dir, kind: "root-missing" }); continue; }
    for (const f of walk(abs, r.recursive, []).filter((x) => MEDIA.test(x) && !EXCLUDE.has(rel(x)))) {
      const key = rel(f);
      seen.add(key);
      const old = known.get(key);
      if (!old) drift.push({ path: key, kind: "new" });
      else if (old.sha256 !== sha256(f)) drift.push({ path: key, kind: "changed" });
    }
  }
  for (const k of known.keys()) if (!seen.has(k)) drift.push({ path: k, kind: "missing" });
  return drift;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const all = argv.includes("--all");
  const refreshPolicy = argv.includes("--refresh-policy"); // 用 ROOTS 策略覆盖已有条目的 license/basis/source
  const prev = loadLedger();
  const prevByPath = new Map(((prev && prev.entries) || []).map((e) => [e.path, e]));
  const now = new Date().toISOString();
  const entries = [];
  const missingRoots = [];

  for (const r of ROOTS) {
    const abs = path.join(ROOT, r.dir);
    if (!existsSync(abs)) { missingRoots.push(r.dir); continue; }
    const files = walk(abs, r.recursive, []).filter((f) => (all ? true : MEDIA.test(f)) && !EXCLUDE.has(rel(f)));
    for (const f of files) {
      const key = rel(f);
      const old = prevByPath.get(key);
      const fp = FILE_POLICY[key] || null;
      const st = statSync(f);
      const entry = {
        path: key,
        sha256: sha256(f),
        size: st.size,
        ext: path.extname(f).toLowerCase(),
        root: r.id,
        source: !refreshPolicy && old && old.source ? old.source : (fp && fp.source) || r.source,
        license: !refreshPolicy && old && old.license ? old.license : (fp && fp.license) || r.license,
        sourced: !refreshPolicy && old && old.sourced !== undefined ? old.sourced : (fp && fp.sourced !== undefined ? fp.sourced : r.sourced),
        basis: !refreshPolicy && old && old.basis ? old.basis : (fp && fp.basis) || r.basis,
        note: !refreshPolicy && old && old.note ? old.note : (fp && fp.note) || r.note,
        collectedAt: old && old.collectedAt ? old.collectedAt : (old ? now : now),
        evidence: old && old.evidence ? old.evidence : (r.id === "assets-root" ? "无（全仓 grep 0 命中）" : "research/" + r.dir.split("/").slice(1).join("/") + " 目录快照"),
        allowedForRender: (!refreshPolicy && old && old.allowedForRender !== undefined)
          ? old.allowedForRender
          : (((fp && fp.license) || r.license) === "可商用"),
      };
      entries.push(entry);
    }
  }

  // thumb 派生存量关系
  const byDir = new Map();
  for (const e of entries) byDir.set(e.path, e);
  for (const e of entries) {
    if (!e.path.includes("/thumb/")) continue;
    const main = e.path.replace("/thumb/", "/");
    if (byDir.has(main)) e.derivativeOf = main;
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const count = (pred) => entries.filter(pred).length;
  const summary = {
    total: entries.length,
    byLicense: {
      可商用: count((e) => e.license === "可商用"),
      仅自用: count((e) => e.license === "仅自用"),
      未声明: count((e) => e.license === "未声明"),
      禁用: count((e) => e.license === "禁用"),
    },
    sourceUnknown: count((e) => e.sourced === false),
    allowedForRender: count((e) => e.allowedForRender === true),
    byRoot: Object.fromEntries(ROOTS.map((r) => [r.id, count((e) => e.root === r.id)])),
  };

  const drift = [];
  for (const e of entries) {
    const old = prevByPath.get(e.path);
    if (!old) drift.push({ path: e.path, kind: "new" });
    else if (old.sha256 !== e.sha256) drift.push({ path: e.path, kind: "changed" });
  }
  const prevPaths = new Set(((prev && prev.entries) || []).map((e) => e.path));
  for (const e of entries) prevPaths.delete(e.path);
  for (const gone of prevPaths) drift.push({ path: gone, kind: "missing" });

  const doc = {
    schemaVersion: 1,
    generatedAt: now,
    policy: "没有台账的素材，渲染链路一律不得使用（lead 2026-10-25 定）。allowedForRender 只有 license=可商用 才为 true；仅自用/未声明/禁用 一律 false。",
    rules: {
      可商用: "有书面许可证据（LICENSE 原文/作者书面授权），可用于成片与封面",
      仅自用: "仓库自称某许可但仓内无 LICENSE 文件，或授权范围不明 → 不进公开发布的成片",
      未声明: "无任何许可声明 → 按禁用处理，直到补齐证据",
      禁用: "明确不可用（无授权/已判定侵权风险）",
    },
    roots: ROOTS.map((r) => ({ id: r.id, dir: r.dir, license: r.license, basis: r.basis })),
    missingRoots,
    summary,
    drift,
    entries,
  };

  console.log("assets_ledger " + (check ? "[CHECK]" : "[UPDATE]") + " total=" + summary.total +
    " 可商用=" + summary.byLicense.可商用 + " 仅自用=" + summary.byLicense.仅自用 +
    " 未声明=" + summary.byLicense.未声明 + " 禁用=" + summary.byLicense.禁用 +
    " 来源不明=" + summary.sourceUnknown + " allowedForRender=" + summary.allowedForRender);
  console.log("byRoot=" + JSON.stringify(summary.byRoot) + (missingRoots.length ? " missingRoots=" + missingRoots.join(",") : ""));
  if (drift.length) {
    const kinds = drift.reduce((m, d) => { m[d.kind] = (m[d.kind] || 0) + 1; return m; }, {});
    console.log("drift=" + JSON.stringify(kinds) + " 例:" + drift.slice(0, 5).map((d) => d.kind + ":" + d.path).join(" | "));
  } else console.log("drift=none（台账与磁盘一致）");

  if (check) {
    if (drift.length) { console.log("CHECK FAIL：有未登记或已变更的素材，请先把它们补进台账再渲染/发布。"); return 1; }
    console.log("CHECK OK");
    return 0;
  }
  if (prev && drift.length === 0 && !refreshPolicy) {
    console.log("unchanged —— 台账与磁盘一致，不重写文件（幂等：内容与 mtime 均不变）");
    return 0;
  }
  writeFileSync(LEDGER, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log("written " + LEDGER);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
