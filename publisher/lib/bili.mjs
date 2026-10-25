// Endpoint layer for the bilibili web upload chain.
// Every path/param below is taken from source evidence (see README "端点证据"):
//   biliup/biliup  crates/biliup/src/uploader/{bilibili,line,line/upos,credential}.rs
//   biliup/biliup  crates/stream-gears/biliup/plugins/bili_webup.py
//   SocialSisterYi/bilibili-API-collect (fork mirror) docs/creativecenter/upload.md
//   SocialSisterYi/bilibili-API-collect (fork mirror) docs/login/login_action/QR.md
import { request, parseJson, buildCookieHeader } from "./http.mjs";

export const DEFAULT_HOSTS = {
  member: "https://member.bilibili.com",
  passport: "https://passport.bilibili.com",
  api: "https://api.bilibili.com",
};

export function makeCtx({ cookies, hosts } = {}) {
  return {
    cookies: cookies || {},
    hosts: { ...DEFAULT_HOSTS, ...(hosts || {}) },
    get cookieHeader() {
      return buildCookieHeader(this.cookies);
    },
  };
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.set(k, String(v));
  }
  return u.toString();
}

/** GET /x/web-interface/nav — login check used by bili_webup.py:355-364. */
export async function nav(ctx) {
  const res = await request({
    url: ctx.hosts.api + "/x/web-interface/nav",
    cookies: ctx.cookieHeader,
    step: "nav",
  });
  return { res, json: parseJson(res) };
}

/** GET /x/frontend/finger/spi — buvid3/buvid4 without login (credential.rs:871-889). */
export async function buvidSpi(ctx) {
  const res = await request({ url: ctx.hosts.api + "/x/frontend/finger/spi", step: "buvid3" });
  return { res, json: parseJson(res) };
}

/** GET /x/passport-login/web/qrcode/generate (QR.md). */
export async function qrcodeGenerate(ctx) {
  const url = ctx.hosts.passport + "/x/passport-login/web/qrcode/generate?source=main-fe-header";
  const res = await request({ url, step: "qr/generate" });
  return { res, json: parseJson(res) };
}

/** GET /x/passport-login/web/qrcode/poll?qrcode_key= (QR.md). */
export async function qrcodePoll(ctx, qrcodeKey) {
  const url = ctx.hosts.passport + "/x/passport-login/web/qrcode/poll?" + qs({ qrcode_key: qrcodeKey });
  const res = await request({ url, step: "qr/poll" });
  return { res, json: parseJson(res) };
}

/** GET /preupload?r=probe (line.rs:130) — CDN line probe, optional. */
export async function probeLine(ctx) {
  const res = await request({ url: ctx.hosts.member + "/preupload?r=probe", cookies: ctx.cookieHeader, step: "preupload(probe)" });
  return { res, json: parseJson(res) };
}

/**
 * GET /preupload — line.rs:376-404 (params name/r/profile/ssl/version/build/size).
 * profile=ugcupos/bup avoids the metadata + frame.zip steps of ugcfx/bup.
 */
export async function preupload(ctx, { name, size, lineQuery = "" }) {
  const params = {
    name,
    r: "upos",
    profile: "ugcupos/bup",
    ssl: 0,
    version: "2.14.0",
    build: 2140000,
    size,
  };
  const query = (lineQuery ? lineQuery + "&" : "") + qs(params);
  const res = await request({
    url: ctx.hosts.member + "/preupload?" + query,
    cookies: ctx.cookieHeader,
    step: "preupload",
  });
  const json = parseJson(res);
  if (json && json.code === 601) throw new Error("preupload rate limited (code 601, line.rs:406-420)");
  if (res.status !== 200 || !json) {
    const hint =
      res.status === 403
        ? " - 403 means the edge WAF did not see a login cookie: log in first (node login.mjs) and pass --cookie"
        : "";
    throw new Error("preupload failed: HTTP " + res.status + hint + " body=" + res.text.replace(/\s+/g, " ").slice(0, 160));
  }
  if (json.OK !== 1) throw new Error("preupload rejected: " + JSON.stringify(json).slice(0, 300));
  return { res, json, params };
}

export function uposUrl(ctx, bucket) {
  const scheme = ctx.hosts.insecure ? "http:" : "https:";
  return scheme + bucket.endpoint + "/" + String(bucket.upos_uri).replace("upos://", "");
}

/** POST {upos url}?uploads&output=json with X-Upos-Auth (line/upos.rs:66-84). */
export async function uposCreate(ctx, bucket, size) {
  const params = {
    uploads: "",
    output: "json",
    profile: "ugcupos/bup",
    filesize: size,
    partsize: bucket.chunk_size,
    biz_id: bucket.biz_id,
  };
  const res = await request({
    method: "POST",
    url: uposUrl(ctx, bucket) + "?" + qs(params),
    headers: { "X-Upos-Auth": bucket.auth },
    cookies: ctx.cookieHeader,
    step: "upos/create",
  });
  const json = parseJson(res);
  if (!json || !json.upload_id) throw new Error("upos create failed: " + res.text.slice(0, 300));
  return { res, json, uploadId: json.upload_id };
}

/** PUT one chunk (line/upos.rs:148-183, upload.md "分片上传视频文件"). */
export async function uposPutChunk(ctx, bucket, uploadId, chunk) {
  const params = {
    partNumber: chunk.partNumber,
    uploadId,
    chunk: chunk.index,
    chunks: chunk.chunks,
    size: chunk.size,
    start: chunk.start,
    end: chunk.end,
    total: chunk.total,
  };
  const res = await request({
    method: "PUT",
    url: uposUrl(ctx, bucket) + "?" + qs(params),
    headers: { "X-Upos-Auth": bucket.auth, "Content-Type": "application/octet-stream" },
    cookies: ctx.cookieHeader,
    body: chunk.body,
    step: "upos/put#" + chunk.partNumber,
    timeoutMs: 180000,
  });
  return { res, params };
}

/** POST merge (line/upos.rs:214-240, upload.md "结束上传视频文件"). */
export async function uposMerge(ctx, bucket, uploadId, name, parts) {
  const params = { name, uploadId, biz_id: bucket.biz_id, output: "json", profile: "ugcupos/bup" };
  const body = JSON.stringify({ parts: parts.map((p) => ({ partNumber: p.partNumber, eTag: "etag" })) });
  const res = await request({
    method: "POST",
    url: uposUrl(ctx, bucket) + "?" + qs(params),
    headers: { "X-Upos-Auth": bucket.auth, "Content-Type": "application/json" },
    cookies: ctx.cookieHeader,
    body,
    step: "upos/merge",
    timeoutMs: 180000,
  });
  const json = parseJson(res);
  const ok = res.status === 200 && json && (json.OK === 1 || json.OK === undefined);
  return { res, json, ok, params, body };
}

/** POST /x/vu/web/cover/up — form cover=data:image/jpeg;base64,...&csrf= (bilibili.rs:898-924). */
export async function coverUp(ctx, jpegBuffer) {
  const form = new URLSearchParams();
  form.set("cover", "data:image/jpeg;base64," + jpegBuffer.toString("base64"));
  form.set("csrf", ctx.cookies.bili_jct);
  const res = await request({
    method: "POST",
    url: ctx.hosts.member + "/x/vu/web/cover/up?ts=" + Date.now(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    cookies: ctx.cookieHeader,
    body: form.toString(),
    step: "cover/up",
    timeoutMs: 120000,
  });
  const json = parseJson(res);
  return { res, json, url: json && json.data && json.data.url };
}

/** POST /x/vu/web/add/v3?t=&csrf= — JSON studio body (bilibili.rs:587-614). */
export async function submitArchive(ctx, studio) {
  const url = ctx.hosts.member + "/x/vu/web/add/v3?" + qs({ t: Date.now(), csrf: ctx.cookies.bili_jct });
  const body = JSON.stringify(studio);
  const res = await request({
    method: "POST",
    url,
    headers: { "Content-Type": "application/json" },
    cookies: ctx.cookieHeader,
    body,
    step: "add/v3",
    timeoutMs: 120000,
  });
  return { res, json: parseJson(res), body };
}
