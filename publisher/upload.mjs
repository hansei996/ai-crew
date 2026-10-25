#!/usr/bin/env node
// bilibili web upload CLI: preupload -> UPOS chunks -> merge -> (cover) -> submit.
//
//   node upload.mjs --file clip.mp4 --meta meta.json              # dry run (stops before cover+submit)
//   node upload.mjs --file clip.mp4 --meta meta.json --dry-run    # same, explicit
//   node upload.mjs --file clip.mp4 --meta meta.json --yes        # real publish (needs authorisation!)
//   node upload.mjs --self-test                                   # full chain against a local mock
//
// Endpoint evidence: see README.md ("端点证据"). Nothing here is guessed.
import { statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, resolve, dirname, join } from "node:path";
import * as bili from "./lib/bili.mjs";
import { log, redactValue, readJsonFile } from "./lib/http.mjs";

const USAGE = [
  "usage: node upload.mjs --file <video> [--meta meta.json] [options]",
  "",
  "  --dry-run        run preupload + chunk upload + merge, then print the cover/submit",
  "                   payloads that WOULD be sent (masked) and stop. Default behaviour.",
  "  --yes            actually publish (cover/up + add/v3). Requires author consent.",
  "  --cookie <path>  cookie file (default ./cookie.json)",
  "  --meta <path>    metadata file (default ./meta.json)",
  "  --threads <n>    parallel chunk uploads (default from preupload response, else 3)",
  "  --no-preflight   skip the /x/web-interface/nav login check",
  "  --probe-line     probe a CDN line first (GET /preupload?r=probe)",
  "  --self-test      run the whole chain against a local mock server",
  "  --help",
].join("\n");

function parseArgs(argv) {
  const o = {
    file: null,
    meta: "meta.json",
    cookie: "cookie.json",
    dryRun: true,
    yes: false,
    threads: 0,
    preflight: true,
    probeLine: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") o.file = argv[++i];
    else if (a === "--meta") o.meta = argv[++i];
    else if (a === "--cookie") o.cookie = argv[++i];
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--threads") o.threads = Number(argv[++i]);
    else if (a === "--no-preflight") o.preflight = false;
    else if (a === "--probe-line") o.probeLine = true;
    else if (a === "--self-test") o.selfTest = true;
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else { console.error("unknown argument: " + a + "\n" + USAGE); process.exit(2); }
  }
  if (o.yes) o.dryRun = false;
  return o;
}

function planChunks(size, chunkSize) {
  const chunks = Math.ceil(size / chunkSize);
  const out = [];
  let start = 0;
  for (let i = 0; i < chunks; i++) {
    const len = Math.min(chunkSize, size - start);
    out.push({ index: i, partNumber: i + 1, start, end: start + len, size: len, chunks, total: size });
    start += len;
  }
  return out;
}

function readChunk(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

function buildStudio(meta, uposUri) {
  const stem = basename(String(uposUri).replace("upos://", "")).replace(/\.[^.]+$/, "");
  const videos = [
    {
      title: (meta.part_title || meta.title || stem).slice(0, 80),
      filename: stem,
      desc: meta.part_desc || "",
    },
  ];
  if (meta.cid) videos[0].cid = Number(meta.cid);
  const body = {
    videos,
    cover: meta.cover_url || "",
    cover43: meta.cover43 || "",
    title: String(meta.title || "").slice(0, 80),
    copyright: meta.copyright === 2 ? 2 : 1,
    tid: Number(meta.tid ?? 171),
    tag: Array.isArray(meta.tags) ? meta.tags.join(",") : String(meta.tag || ""),
    desc_format_id: meta.desc_format_id ?? 9999,
    desc: meta.desc || "",
    recreate: meta.recreate ?? -1,
    dynamic: meta.dynamic || "",
    interactive: 0,
    act_reserve_create: 0,
    no_disturbance: meta.no_disturbance ?? 0,
    no_reprint: meta.no_reprint ?? 1,
    subtitle: { open: 0, lan: "" },
    dolby: 0,
    lossless_music: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    web_os: 3,
  };
  if (body.copyright === 2) body.source = meta.source || "";
  if (meta.human_type2) body.human_type2 = Number(meta.human_type2);
  if (meta.is_only_self !== undefined) body.is_only_self = Number(meta.is_only_self);
  if (meta.topic_id) body.topic_id = Number(meta.topic_id);
  if (meta.mission_id) body.mission_id = Number(meta.mission_id);
  if (meta.dtime) body.dtime = Math.floor(Number(meta.dtime) / 1000) || Number(meta.dtime);
  // 创作者声明 / AI-content declaration slot. Field name is documented
  // (bilibili-API-collect upload.md: neutral_mark = 创作者声明); the accepted
  // VALUE SET is not documented anywhere we could verify -> see README 未证实.
  if (meta.neutral_mark) body.neutral_mark = String(meta.neutral_mark);
  if (meta.extra && typeof meta.extra === "object") Object.assign(body, meta.extra);
  return body;
}

function loadCover(path) {
  if (!path) return null;
  const p = resolve(path);
  if (!existsSync(p)) throw new Error("cover file not found: " + p);
  const buf = readFileSync(p);
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!isJpeg) {
    throw new Error(
      "cover/up expects a JPEG data URL (biliup resizes to JPEG). " + basename(p) +
        " is not JPEG - convert first, e.g. ffmpeg -i cover.png -vf scale=1146:717 -q:v 3 cover.jpg",
    );
  }
  return buf;
}

function mask(v) {
  return redactValue(v);
}

async function runChain(ctx, opts, meta, videoPath, { hostsForMock } = {}) {
  const size = statSync(videoPath).size;
  const name = basename(videoPath);
  log("file: " + videoPath + " (" + size + " bytes)");

  if (opts.preflight) {
    const who = await bili.nav(ctx);
    if (!who.json || who.json.code !== 0 || !who.json.data || !who.json.data.isLogin) {
      throw new Error("not logged in (nav code " + (who.json && who.json.code) + "); run: node login.mjs");
    }
    log("login ok: " + who.json.data.uname + " (mid " + who.json.data.mid + ")");
  }

  let lineQuery = "";
  if (opts.probeLine) {
    const probe = await bili.probeLine(ctx);
    const line = probe.json && Array.isArray(probe.json.lines) ? probe.json.lines[0] : null;
    if (line && line.query) {
      lineQuery = line.query;
      log("cdn line: " + lineQuery);
    } else log("cdn line probe returned no usable line, continuing without it");
  }

  const pre = await bili.preupload(ctx, { name, size, lineQuery });
  const bucket = pre.json;
  log(
    "preupload ok: chunk_size=" + bucket.chunk_size + " biz_id=" + bucket.biz_id +
      " endpoint=" + bucket.endpoint + " auth=" + mask(bucket.auth) + " upos_uri=" + bucket.upos_uri,
  );

  const created = await bili.uposCreate(ctx, bucket, size);
  log("upload session: upload_id=" + created.uploadId);

  const plan = planChunks(size, bucket.chunk_size);
  const threads = Math.max(1, Math.min(opts.threads || bucket.threads || 3, plan.length));
  log("chunks: " + plan.length + " x " + bucket.chunk_size + "B, " + threads + " parallel");

  const fd = openSync(videoPath, "r");
  const parts = [];
  try {
    let next = 0;
    const worker = async () => {
      while (true) {
        const idx = next++;
        if (idx >= plan.length) return;
        const c = plan[idx];
        const body = readChunk(fd, c.start, c.size);
        let attempt = 0;
        while (true) {
          const put = await bili.uposPutChunk(ctx, bucket, created.uploadId, { ...c, body });
          if (put.res.status === 200 && /MULTIPART_PUT_SUCCESS/i.test(put.res.text)) {
            parts.push({ partNumber: c.partNumber, index: c.index, size: c.size });
            break;
          }
          attempt++;
          if (attempt > 3) throw new Error("chunk " + c.partNumber + " failed: HTTP " + put.res.status + " " + put.res.text.slice(0, 120));
          log("chunk " + c.partNumber + " retry " + attempt + " (HTTP " + put.res.status + ")");
        }
      }
    };
    await Promise.all(Array.from({ length: threads }, worker));
  } finally {
    closeSync(fd);
  }
  parts.sort((a, b) => a.index - b.index);
  log("chunks uploaded: " + parts.length + "/" + plan.length);

  const merged = await bili.uposMerge(ctx, bucket, created.uploadId, name, parts);
  if (!merged.ok) throw new Error("merge failed: HTTP " + merged.res.status + " " + merged.res.text.slice(0, 200));
  log("merge ok: " + merged.res.text.slice(0, 160));

  const studio = buildStudio(meta, bucket.upos_uri);
  const coverBuf = loadCover(meta.cover);

  if (opts.dryRun) {
    log("");
    log("=== DRY RUN: stopping before cover/up and add/v3 ===");
    log("submitted nothing; no archive was created.");
    if (coverBuf) {
      log("");
      log("would POST " + ctx.hosts.member + "/x/vu/web/cover/up?ts=<ms>");
      log("  Content-Type: application/x-www-form-urlencoded");
      log("  csrf  = " + mask(ctx.cookies.bili_jct));
      log("  cover = data:image/jpeg;base64,<" + coverBuf.length + " bytes jpeg -> " + Math.ceil((coverBuf.length * 4) / 3) + " base64 chars>");
      log("  (the returned data.url is what belongs in the body's cover field)");
    } else {
      log("");
      log("no meta.cover given -> body.cover stays \"\" and Bilibili picks a frame automatically");
    }
    log("");
    log("would POST " + ctx.hosts.member + "/x/vu/web/add/v3?t=<ms>&csrf=" + mask(ctx.cookies.bili_jct));
    log("  Content-Type: application/json");
    log("  Cookie: " + ["SESSDATA", "bili_jct", "DedeUserID"].map((k) => k + "=" + mask(ctx.cookies[k])).join("; ") + " …");
    log("body:");
    for (const line of JSON.stringify(studio, null, 2).split("\n")) log("  " + line);
    log("");
    log("re-run with --yes to actually publish (authorisation required).");
    return { dryRun: true, studio, parts };
  }

  if (!opts.yes) throw new Error("refusing to publish without --yes");

  let coverUrl = studio.cover;
  if (coverBuf) {
    const cov = await bili.coverUp(ctx, coverBuf);
    if (!cov.url) throw new Error("cover/up failed: HTTP " + cov.res.status + " " + cov.res.text.slice(0, 200));
    coverUrl = cov.url;
    studio.cover = coverUrl;
    log("cover ok: " + coverUrl);
  }

  const sub = await bili.submitArchive(ctx, studio);
  if (!sub.json || sub.json.code !== 0) {
    throw new Error("add/v3 failed: HTTP " + sub.res.status + " " + sub.res.text.slice(0, 400));
  }
  log("PUBLISHED: aid=" + sub.json.data.aid + " bvid=" + sub.json.data.bvid);
  return { dryRun: false, sub: sub.json, studio };
}

async function selfTest(opts = {}) {
  const { startMock } = await import("./lib/mock.mjs");
  const mock = await startMock();
  log("mock server on 127.0.0.1:" + mock.port + " (no real request leaves the machine)");
  const dir = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
  (await import("node:fs")).mkdirSync(join(dir, "_scratch"), { recursive: true });
  const video = join(dir, "_scratch", "clip.mp4");
  writeFileSync(video, Buffer.alloc(700 * 1024, 0x41));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x11), Buffer.from([0xff, 0xd9])]);
  writeFileSync(join(dir, "_scratch", "selftest.jpg"), jpeg);
  const meta = {
    title: "self test",
    desc: "dry",
    tags: ["a", "b"],
    tid: 171,
    copyright: 1,
    cover: join(dir, "_scratch", "selftest.jpg"),
  };
  const ctx = bili.makeCtx({ cookies: { SESSDATA: "mock-sessdata", bili_jct: "mock-jct-value", DedeUserID: "42" }, hosts: mock.hosts });
  let failed = null;
  try {
    const dryRun = opts.dryRun !== false;
    const out = await runChain(ctx, { preflight: true, probeLine: false, threads: 2, dryRun, yes: !dryRun }, meta, video, {});
    if (!dryRun) {
      if (mock.state.submitted && mock.state.submitted.videos[0].filename !== "abcdef012345") failed = "filename mismatch";
      if (!out.sub || out.sub.code !== 0) failed = "submit did not return code 0";
    } else if (mock.state.submitted) {
      failed = "dry run reached add/v3 - it must stop before submit";
    }
  } catch (e) {
    failed = e.message;
  }
  await mock.close();
  if (mock.violations.length) failed = "mock violations: " + mock.violations.join(" | ");
  if (failed) {
    log("SELF-TEST FAILED: " + failed);
    process.exit(1);
  }
  log(
    "SELF-TEST PASSED: preupload -> create -> " + mock.state.chunks.size + " chunks -> merge" +
      (mock.state.submitted ? " -> cover(" + mock.state.coverBytes + "B) -> add/v3" : " (stopped before cover/submit, dry run)"),
  );
  log("requests seen: " + mock.seen.map((s) => s.replace(/(?:^|[?&])(csrf|t)=[^&;]*/g, (m, k) => (m.startsWith("?") ? "?" : m.startsWith("&") ? "&" : "") + k + "=***")).join(" ; "));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) return selfTest(opts);
  if (!opts.file) {
    console.error("--file is required\n" + USAGE);
    process.exit(2);
  }
  const videoPath = resolve(opts.file);
  if (!existsSync(videoPath)) {
    console.error("video not found: " + videoPath);
    process.exit(2);
  }
  const metaPath = resolve(opts.meta);
  if (!existsSync(metaPath)) {
    console.error("meta not found: " + metaPath + " (see meta.json.example)");
    process.exit(2);
  }
  const cookiePath = resolve(opts.cookie);
  const cookies = {};
  let hosts;
  if (existsSync(cookiePath)) {
    const stored = readJsonFile(cookiePath);
    Object.assign(cookies, stored.cookies || stored);
    log("cookie file: " + cookiePath + " (mid " + (stored.mid ?? "?") + ")");
  } else {
    if (!opts.dryRun) {
      console.error("cookie file not found: " + cookiePath + "; run: node login.mjs");
      process.exit(2);
    }
    log("cookie file not found: " + cookiePath + " -> running against the live endpoints WITHOUT login (expect 4xx)");
  }
  log("mode: " + (opts.dryRun ? "DRY RUN (stops before submit)" : "PUBLISH"));
  const ctx = bili.makeCtx({ cookies, hosts });
  try {
    await runChain(ctx, opts, readJsonFile(metaPath), videoPath, {});
  } catch (e) {
    log("FAILED: " + e.message);
    process.exit(1);
  }
}

main();
