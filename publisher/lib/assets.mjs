// lib/assets.mjs — 素材准入闸（渲染链路唯一入口）。
// 规则（lead 2026-10-25 定）：没有台账的素材一律不得使用；只允许 allowedForRender===true 进链路。
// 用法：
//   import { assertAllowed, assertLedgerClean } from "./lib/assets.mjs";
//   const e = assertAllowed("assets/C01/c01-01.png");   // 不通过直接 throw
// CLI：node lib/assets.mjs <路径...>      # 逐个打印 ALLOW / DENY
//      node lib/assets.mjs --check       # 台账与磁盘是否一致（等价 assets_ledger.mjs --check）
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LEDGER, REPO_ROOT, loadLedger, computeDrift } from "../assets_ledger.mjs";

export const EVIDENCE_DOC = path.join(REPO_ROOT, "assets", "LEDGER-EVIDENCE.md");

export class AssetNotAllowedError extends Error {
  constructor(detail) {
    super(AssetNotAllowedError.format(detail));
    this.name = "AssetNotAllowedError";
    this.detail = detail;
  }
  // 三段式：路径 / 许可结论 / 证据文件——缺一段 debug 的人就不知道去哪申诉
  static format(d) {
    return [
      "素材未获准入: " + d.path,
      "  许可结论: " + d.license + (d.basis ? "（" + d.basis + "）" : ""),
      "  证据文件: " + d.evidence,
      d.hint ? "  处理办法: " + d.hint : null,
    ].filter(Boolean).join("\n");
  }
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function toRepoRel(p) {
  const rel = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join("/");
  if (path.isAbsolute(p)) return rel(p);
  // 相对路径：先按调用者 cwd 解释（CLI 常见），落空再按仓库根解释（lib 常见）
  const fromCwd = path.resolve(process.cwd(), p);
  if (existsSync(fromCwd)) return rel(fromCwd);
  return rel(path.join(REPO_ROOT, p));
}

/** 台账与磁盘不一致（有未登记/变更/消失的素材）就 throw。渲染前第一句调用。 */
export function assertLedgerClean() {
  const drift = computeDrift();
  if (!drift.length) return { ok: true, drift: [] };
  const head = drift.slice(0, 5).map((d) => d.kind + ":" + d.path).join(" | ");
  throw new AssetNotAllowedError({
    path: drift.length + " 处素材与台账不一致",
    license: "台账未同步（按未授权处理）",
    basis: "示例 " + head + (drift.length > 5 ? " …" : ""),
    evidence: LEDGER + " 与 " + EVIDENCE_DOC,
    hint: "先跑 node publisher/assets_ledger.mjs（必要时 --refresh-policy），再重试",
  });
}

/** 单个素材准入判定。通过返回台账条目；不通过 throw AssetNotAllowedError。 */
export function assertAllowed(p, opts = {}) {
  const key = toRepoRel(p);
  const abs = path.join(REPO_ROOT, key);
  const ledger = loadLedger();
  if (!ledger) {
    throw new AssetNotAllowedError({ path: key, license: "无台账（按禁用处理）", basis: "assets/LEDGER.json 不存在", evidence: LEDGER, hint: "先跑 node publisher/assets_ledger.mjs 建台账" });
  }
  const entry = (ledger.entries || []).find((e) => e.path === key);
  if (!entry) {
    throw new AssetNotAllowedError({ path: key, license: "未登记（按禁用处理）", basis: "台账里没有这条素材，等于没有授权记录", evidence: LEDGER + " 与 " + EVIDENCE_DOC, hint: "先登记来源与许可再使用：node publisher/assets_ledger.mjs" });
  }
  if (entry.allowedForRender !== true) {
    throw new AssetNotAllowedError({ path: key, license: entry.license, basis: entry.basis, evidence: (entry.evidence || "无") + " ｜ " + EVIDENCE_DOC, hint: "补齐书面授权后改台账 license 并 --refresh-policy；或换用 allowedForRender=true 的自产素材" });
  }
  if (opts.verifyHash !== false) {
    let now = null;
    try { now = sha256(abs); } catch { throw new AssetNotAllowedError({ path: key, license: entry.license, basis: "文件不存在或不可读", evidence: LEDGER, hint: "检查路径；若已删除请重跑台账" }); }
    if (now !== entry.sha256) {
      throw new AssetNotAllowedError({ path: key, license: entry.license, basis: "文件内容与台账 sha256 不一致（被替换或改动过）", evidence: LEDGER, hint: "确认这是同一个素材后重跑 node publisher/assets_ledger.mjs 更新台账" });
    }
  }
  return entry;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) { console.log("node lib/assets.mjs <路径...> | --check"); return 2; }
  if (argv.includes("--check")) {
    const drift = computeDrift();
    console.log(drift.length ? ("CHECK FAIL drift=" + drift.length + " 例:" + drift.slice(0, 5).map((d) => d.kind + ":" + d.path).join(" | ")) : "CHECK OK（台账与磁盘一致）");
    return drift.length ? 1 : 0;
  }
  let bad = 0;
  for (const a of argv) {
    try { const e = assertAllowed(a); console.log("ALLOW " + e.path + "  license=" + e.license); }
    catch (err) { bad++; console.log("DENY\n" + err.message); }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
