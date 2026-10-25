// Minimal HTTP + logging layer. No third-party deps.
import { readFileSync as nodeReadFile, writeFileSync as nodeWriteFile } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const SECRET_PARAMS = /^(csrf|t|qrcode_key|access_key|sign|auth|SESSDATA|bili_jct|buvid3|buvid4|refresh_token|code)$/i;
export const SECRET_COOKIES = new Set([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
  "buvid3",
  "buvid4",
  "bili_ticket",
]);

export function redactValue(v) {
  if (v === undefined || v === null) return v;
  const s = String(v);
  if (s.length <= 6) return "***";
  return s.slice(0, 3) + "***(" + s.length + " chars)";
}

export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    for (const [k, v] of [...u.searchParams]) {
      if (SECRET_PARAMS.test(k)) u.searchParams.set(k, redactValue(v));
    }
    return u.origin + u.pathname + (u.search ? u.search : "");
  } catch {
    return "<unparsable url>";
  }
}

export function redactCookieHeader(header) {
  return header
    .split(/;\s*/)
    .map((kv) => {
      const i = kv.indexOf("=");
      if (i < 0) return kv;
      const k = kv.slice(0, i);
      return SECRET_COOKIES.has(k) ? k + "=" + redactValue(kv.slice(i + 1)) : kv;
    })
    .join("; ");
}

export function log(msg) {
  console.log(msg);
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One HTTP request. Always resolves (network errors become status 0) so the
 * caller can print a status code for every step, as the acceptance requires.
 */
export async function request({ method = "GET", url, headers = {}, body, cookies, step, timeoutMs = 60000 }) {
  const h = { "User-Agent": UA, Referer: "https://member.bilibili.com/", ...headers };
  if (cookies) h.Cookie = cookies;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers: h, body, signal: ac.signal, redirect: "manual" });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - started;
    log(
      "[" + (step ?? "-") + "] " + method + " " + redactUrl(url) + " -> HTTP " + res.status +
        (res.statusText ? " " + res.statusText : "") + " (" + ms + "ms, " + buf.length + "B)"
    );
    return { status: res.status, headers: res.headers, text: buf.toString("utf8"), buffer: buf, ok: res.ok };
  } catch (e) {
    const ms = Date.now() - started;
    log("[" + (step ?? "-") + "] " + method + " " + redactUrl(url) + " -> NETWORK ERROR " + e.name + ": " + e.message + " (" + ms + "ms)");
    return { status: 0, headers: new Headers(), text: "", buffer: Buffer.alloc(0), ok: false, error: e };
  } finally {
    clearTimeout(timer);
  }
}

export function parseJson(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

export function buildCookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => k + "=" + v)
    .join("; ");
}

export function setCookies(res) {
  const out = {};
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const first = line.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return out;
}

export function readJsonFile(path) {
  return JSON.parse(nodeReadFile(path));
}

export function writeJsonPrivate(path, obj) {
  nodeWriteFile(path, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return path;
}
