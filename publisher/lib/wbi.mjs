// WBI signing (wts + w_rid).
// NOT used by the upload/submit chain: biliup's submit/cover/preupload requests
// carry only csrf + t, no wbi fields (crates/biliup/src/uploader/bilibili.rs:587-614,
// 898-924). Implemented anyway because the task asks for w_rid and other member
// endpoints need it. Ported from crates/biliup/src/downloader/live/wbi.rs.
import { createHash } from "node:crypto";

const KEY_MAP = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

export function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  let out = "";
  for (const idx of KEY_MAP.slice(0, 32)) out += raw[idx] ?? "";
  return out;
}

export function wbiSign(params, mixin) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, "");
      return encodeURIComponent(k) + "=" + encodeURIComponent(v);
    })
    .join("&");
  const w_rid = createHash("md5").update(query + mixin).digest("hex");
  return { wts, w_rid };
}
