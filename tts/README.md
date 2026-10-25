# TTS 模块（bili_run/tts）

零依赖、纯 Node 24 内置模块的中文语音合成，产物为 mp3，可直接给 ffmpeg 做配音轨。

## 文件

| 文件 | 作用 |
|---|---|
| `tts.mjs` | 主模块：`synthesize()`、`mp3Duration()`、`splitForTts()` + CLI |
| `drm.mjs` | Edge ReadAloud 的 `Sec-MS-GEC` **v2** 令牌（sha256 + cs64 双摘要、大写 hex、`<16hex>-<64hex>`） |
| `test_20s.mp3` | 验收音频：19.94s / 119664 B / 24kHz mono / 48kbps |

## 用法

```js
import { synthesize } from './tts/tts.mjs';

const r = await synthesize('大家好，欢迎来到本期视频。', {
  voice: 'zh-CN-YunxiNeural',   // 默认值
  outPath: 'out/voice.mp3',
});
// r = { bytes, durationSec, engine, voice, chunks, sampleRate, bitrateKbps, warnings, outPath }
```

```bash
node tts.mjs --text "中文台词" --out out.mp3 [--voice zh-CN-YunxiNeural] [--engine auto|edge|gtts|baidu]
node tts.mjs "中文台词" out.mp3 zh-CN-XiaoxiaoNeural          # 位置参数写法
```

## 引擎（engine=auto 时按此顺序自动降级）

1. **edge**（首选）— 微软 Edge ReadAloud 神经语音，`zh-CN-YunxiNeural` / `zh-CN-XiaoxiaoNeural` /
   `zh-CN-YunjianNeural` / `zh-CN-XiaoyiNeural` / `zh-CN-YunyangNeural` 等，
   输出 `audio-24khz-48kbitrate-mono-mp3`，单段 ≤1800 字，多段自动拼接。
2. **gtts** — `translate.google.com/translate_tts`（zh-CN），每段 ≤120 字，机器感较强。
3. **baidu** — `fanyi.baidu.com/gettts`（zh 女声 16kHz），每段 ≤200 字。

任一引擎整体失败才会换下一个（不会把两个引擎的音频混拼在同一条轨道里）。

## Edge 协议实现要点（踩过的坑）

- **旧的 `TrustedClientToken` 已失效**：`6A5AA1D4EAFF4E8CB73E84EDDAD4F4D5` → 服务器回 **401**；
  当前有效值为 `6A5AA1D4EAFF4E9FB37E23D68491D6F4`（换成新 token 立刻从 401 变 403，说明 token 被接受）。
- **令牌已升级到 v2**：`Sec-MS-GEC` 不再是单个 sha256，而是 `<cs64 16hex>-<sha256 64hex>`；
  `Sec-MS-GEC-Version=2-143.0.3650.75`，UA 用 `Chrome/143.0.0.0 ... Edg/143.0.0.0`。
  只用 v1（纯 sha256）会一直 **403**。v2 算法见 `drm.mjs`（微软自定义的 sha256+cs64 摘要，非标准 SHA-256）。
- Node 内置 WebSocket 不能带自定义头 → 用 `https.request` 带 `Connection: Upgrade` / `Upgrade: websocket`
  发起，在 `'upgrade'` 事件拿裸 socket，自行实现 RFC6455 掩码帧（含分片、ping/pong、close）。
- 握手还需 `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold` 和 `Cookie: muid=<32位大写hex>;`。
- 二进制帧结构：前 2 字节大端 = header 长度，header 含 `Path:audio` 时其后全部为音频；
  文本帧出现 `Path:turn.end` 表示结束。
- 每 5 分钟时间窗生成一次令牌；每个连接都重新生成，长文本多段也不会过期。
- 已知失效路线（勿再试）：系统 SAPI（`SelectVoice` 报 security setting）、
  `dict.youdao.com/dictvoice`（只有单词能出音频，整句一律 HTTP 500 `returned null audio`）。

## 保底方案（若某天 edge/gtts/baidu 全挂）

保留字幕 + BGM 也可以出片，ffmpeg 参数：

```bash
# 1) 生成与视频等长的静音底噪轨（24kHz mono，与神经语音采样率一致，替换时不爆音）
ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t <时长> -q:a 9 -acodec libmp3lame silence.mp3
# 2) 烧字幕 + 混 BGM（BGM 压到 -22dB，避免压住人声）
ffmpeg -i video.mp4 -i bgm.mp3 -filter_complex \
  "[1:a]volume=0.08,aloop=loop=-1:size=2e9[bg];[0:a][bg]amix=inputs=2:duration=first[a]" \
  -vf "ass=sub.ass" -map 0:v -map "[a]" -c:v libx264 -c:a aac -shortest out.mp4
```
