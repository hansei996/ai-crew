#!/usr/bin/env node
// bilibili QR login -> cookie.json
//
// Flow evidence:
//   GET  https://passport.bilibili.com/x/passport-login/web/qrcode/generate
//   GET  https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=
//   (bilibili-API-collect docs/login/login_action/QR.md, fork mirror
//    codeberg.org/mengzhen/bilibili-API-collect; the upstream repo is deleted)
// Cookies on success: DedeUserID, DedeUserID__ckMd5, SESSDATA, bili_jct.
// buvid3 is fetched separately from /x/frontend/finger/spi (biliup credential.rs:871-889).
import { writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import * as bili from "./lib/bili.mjs";
import { encodeQr, qrToPng, qrToTerminal } from "./lib/qr.mjs";
import { log, sleep, setCookies, redactValue, writeJsonPrivate, request } from "./lib/http.mjs";

const USAGE = "usage: node login.mjs [--out cookie.json] [--png login-qr.png] [--timeout 180] [--no-terminal] [--mock PORT]";

function parseArgs(argv) {
  const o = { out: "cookie.json", png: "login-qr.png", timeout: 180, terminal: true, mock: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--png") o.png = argv[++i];
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--no-terminal") o.terminal = false;
    else if (a === "--mock") o.mock = Number(argv[++i]);
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else { console.error("unknown argument: " + a + "\n" + USAGE); process.exit(2); }
  }
  return o;
}

function cookiesFromUrl(urlStr) {
  const out = {};
  try {
    const u = new URL(urlStr);
    for (const [k, v] of u.searchParams) {
      if (["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"].includes(k)) out[k] = v;
    }
  } catch {}
  return out;
}

export async function qrLogin({ out, png, timeout, terminal, hosts }) {
  const ctx = bili.makeCtx({ hosts });
  const gen = await bili.qrcodeGenerate(ctx);
  const data = gen.json && gen.json.data;
  if (gen.res.status !== 200 || !data || !data.qrcode_key) {
    throw new Error("qrcode/generate failed: HTTP " + gen.res.status + " " + gen.res.text.slice(0, 200));
  }
  const { url: scanUrl, qrcode_key: qrcodeKey } = data;
  log("scan url: " + scanUrl.replace(qrcodeKey, redactValue(qrcodeKey)));
  log("qrcode_key: " + redactValue(qrcodeKey) + "  (valid ~180s)");

  const qr = encodeQr(scanUrl);
  writeFileSync(png, qrToPng(qr, { scale: 8, border: 4 }));
  log("qr image: " + resolve(png) + "  (version " + qr.version + ", " + qr.size + " modules)");
  if (terminal) log("\n" + qrToTerminal(qr) + "\n");
  log("Open the Bilibili app -> scan -> confirm. Waiting (max " + timeout + "s)...");

  const started = Date.now();
  let lastCode = null;
  while (Date.now() - started < timeout * 1000) {
    const poll = await bili.qrcodePoll(ctx, qrcodeKey);
    const d = poll.json && poll.json.data;
    const code = d && d.code;
    if (code !== lastCode) {
      const label =
        code === 86101 ? "not scanned" : code === 86090 ? "scanned, waiting for confirm" : code === 86038 ? "expired" : String(code);
      log("poll code " + code + " (" + label + ")");
      lastCode = code;
    }
    if (code === 0) {
      const cookies = { ...setCookies(poll.res), ...cookiesFromUrl(d.url || "") };
      const need = ["SESSDATA", "bili_jct", "DedeUserID"];
      const missing = need.filter((k) => !cookies[k]);
      log("cookies received: " + Object.keys(cookies).sort().join(", "));
      for (const k of Object.keys(cookies)) log("  " + k + " = " + redactValue(cookies[k]));
      if (missing.length) throw new Error("login reported success but cookies missing: " + missing.join(", "));

      const spi = await bili.buvidSpi(ctx);
      const b3 = spi.json && spi.json.data && spi.json.data.b_3;
      if (b3) cookies.buvid3 = b3;

      const authed = bili.makeCtx({ cookies, hosts });
      const who = await bili.nav(authed);
      const info = who.json && who.json.data;
      if (!info || who.json.code !== 0 || !info.isLogin) {
        throw new Error("cookie rejected by /x/web-interface/nav: " + who.res.text.slice(0, 200));
      }
      log("logged in as " + info.uname + " (mid " + info.mid + ", level " + info.level + ")");

      const payload = {
        saved_at: new Date().toISOString(),
        mid: info.mid,
        uname: info.uname,
        cookies: {
          SESSDATA: cookies.SESSDATA,
          bili_jct: cookies.bili_jct,
          DedeUserID: cookies.DedeUserID,
          DedeUserID__ckMd5: cookies.DedeUserID__ckMd5,
          buvid3: cookies.buvid3,
        },
      };
      writeJsonPrivate(out, payload);
      log("cookie written (mode 0600): " + resolve(out) + "  [values not logged]");
      return { out, mid: info.mid, uname: info.uname };
    }
    if (code === 86038) throw new Error("QR expired (86038); run again");
    await sleep(2000);
  }
  throw new Error("timed out after " + timeout + "s without confirmation");
}

if (process.argv[1] && /login\.mjs$/.test(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  qrLogin(opts).catch((e) => {
    console.error("login failed: " + e.message);
    process.exit(1);
  });
}
