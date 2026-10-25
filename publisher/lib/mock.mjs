// Local mock of the bilibili member + UPOS endpoints. Used by --self-test to
// prove the transport (query params, headers, chunk framing, merge body) without
// touching a real account: no request leaves 127.0.0.1.
import { createServer } from "node:http";

export function startMock({ chunkSize = 1024 * 256 } = {}) {
  const violations = [];
  const seen = [];
  const state = { chunks: new Map(), uploadId: "mock-upload-id", parts: null, submitted: null, coverBytes: 0 };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const expect = (cond, msg) => {
        if (!cond) violations.push(msg);
      };
      const send = (obj, status = 200) => {
        const text = typeof obj === "string" ? obj : JSON.stringify(obj);
        res.writeHead(status, { "content-type": typeof obj === "string" ? "text/plain" : "application/json" });
        res.end(text);
      };
      const port = server.address().port;
      seen.push(req.method + " " + url.pathname + (url.search ? "?" + url.search.slice(0, 120) : ""));

      if (url.pathname === "/x/web-interface/nav") {
        expect(!!req.headers.cookie, "nav must carry cookie");
        return send({ code: 0, data: { isLogin: true, mid: 42, uname: "mock-user" } });
      }
      if (url.pathname === "/preupload") {
        expect(url.searchParams.get("r") === "upos", "preupload r=upos");
        expect(url.searchParams.get("profile") === "ugcupos/bup", "preupload profile=ugcupos/bup");
        expect(url.searchParams.get("name") === "clip.mp4", "preupload name");
        expect(!!url.searchParams.get("size"), "preupload size");
        expect(!!req.headers.cookie && /SESSDATA=/.test(req.headers.cookie), "preupload must carry SESSDATA");
        return send({
          OK: 1,
          auth: "ak=mock&sign=deadbeef",
          biz_id: 500001,
          chunk_size: chunkSize,
          endpoint: "//127.0.0.1:" + port,
          upos_uri: "upos://mockbucket/abcdef012345.mp4",
          threads: 3,
        });
      }
      if (url.pathname === "/mockbucket/abcdef012345.mp4" && req.method === "POST" && url.searchParams.has("uploads")) {
        expect(req.headers["x-upos-auth"] === "ak=mock&sign=deadbeef", "create must send X-Upos-Auth");
        expect(url.searchParams.get("partsize") === String(chunkSize), "create partsize");
        expect(url.searchParams.get("biz_id") === "500001", "create biz_id");
        expect(url.searchParams.get("output") === "json", "create output=json");
        return send({ OK: 1, bucket: "mockbucket", key: "/abcdef012345.mp4", upload_id: state.uploadId });
      }
      if (url.pathname === "/mockbucket/abcdef012345.mp4" && req.method === "PUT") {
        const p = url.searchParams;
        expect(req.headers["x-upos-auth"] === "ak=mock&sign=deadbeef", "put must send X-Upos-Auth");
        expect(req.headers["content-type"] === "application/octet-stream", "put content-type");
        expect(p.get("uploadId") === state.uploadId, "put uploadId");
        for (const k of ["partNumber", "chunk", "chunks", "size", "start", "end", "total"]) {
          expect(p.get(k) !== null, "put missing query " + k);
        }
        expect(Number(p.get("size")) === body.length, "put size == body length (part " + p.get("partNumber") + ")");
        expect(Number(p.get("start")) === Number(p.get("chunk")) * chunkSize, "put start offset (part " + p.get("partNumber") + ")");
        state.chunks.set(Number(p.get("partNumber")), body.length);
        return send("MULTIPART_PUT_SUCCESS");
      }
      if (url.pathname === "/mockbucket/abcdef012345.mp4" && req.method === "POST" && url.searchParams.has("uploadId")) {
        expect(url.searchParams.get("name") === "clip.mp4", "merge name");
        expect(url.searchParams.get("profile") === "ugcupos/bup", "merge profile");
        expect(url.searchParams.get("biz_id") === "500001", "merge biz_id");
        const json = JSON.parse(body.toString("utf8"));
        state.parts = json.parts;
        expect(Array.isArray(json.parts) && json.parts.length === state.chunks.size, "merge part count");
        expect(json.parts.every((x) => x.eTag === "etag"), "merge eTag literal");
        return send({ OK: 1, location: "mockbucket/abcdef012345.mp4", bucket: "mockbucket", key: "/abcdef012345.mp4" });
      }
      if (url.pathname === "/x/vu/web/cover/up") {
        expect(!!url.searchParams.get("ts"), "cover ts");
        const form = new URLSearchParams(body.toString("utf8"));
        expect(!!form.get("csrf"), "cover csrf");
        const cover = form.get("cover") || "";
        expect(cover.startsWith("data:image/jpeg;base64,"), "cover data URL prefix");
        state.coverBytes = Buffer.from(cover.split(",")[1] || "", "base64").length;
        return send({ code: 0, message: "0", data: { url: "https://archive.biliimg.com/bfs/archive/mock.jpg" } });
      }
      if (url.pathname === "/x/vu/web/add/v3") {
        expect(url.searchParams.get("csrf") === "mock-jct-value", "submit csrf == bili_jct");
        expect(!!url.searchParams.get("t"), "submit t");
        const studio = JSON.parse(body.toString("utf8"));
        state.submitted = studio;
        expect(Array.isArray(studio.videos) && studio.videos.length === 1, "submit videos[0]");
        expect(studio.videos[0].filename === "abcdef012345", "submit filename = upos_uri stem");
        expect(typeof studio.copyright === "number", "submit copyright");
        expect(typeof studio.tid === "number", "submit tid");
        expect(typeof studio.tag === "string" && studio.tag.includes(","), "submit tag csv");
        expect(studio.desc_format_id === 9999, "submit desc_format_id");
        return send({ code: 0, message: "0", data: { aid: 1, bvid: "BV1mockmock" } });
      }
      violations.push("unexpected request " + req.method + " " + url.pathname);
      send({ code: -404, message: "unexpected" }, 404);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        hosts: { member: "http://127.0.0.1:" + port, api: "http://127.0.0.1:" + port, insecure: true },
        violations,
        seen,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
