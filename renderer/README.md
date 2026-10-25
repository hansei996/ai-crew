# renderer — 一份 JSON 剧本 → 1080p 成片 + 封面 + 投稿元数据

零依赖：只用 Node 内置模块（`node:`）和仓库里现成的一份 `ffmpeg.exe`。
没有 npm 包、没有联网下载字体/音乐、没有 ffprobe 依赖。

## 一条命令

```bash
cd bili_run
node renderer/render.mjs renderer/demo/script.json --out renderer/out
```

产物（`renderer/out/`）：

| 文件 | 说明 |
| --- | --- |
| `demo.mp4` | 1920x1080 / 30fps / H.264 High + AAC 192kb 48kHz 立体声 |
| `cover.png` | 1920x1080 封面（标题大字 + 期号角标） |
| `meta.json` | title / desc / tags / cover / durationSec / episode / resolution / fps |
| `probe.json` | 成片探测结果（`ffmpeg -i` 解析：分辨率/时长/码率/音轨） |
| `timeline.json` | 每条 scene 的起始秒、帧数，以及每句字幕的时间轴（自查用） |
| `frames/frame_0N.png` | 自动抽取的预览帧（默认 3 张：12% / 45% / 82% 处） |

命令行参数：`--out DIR` `--fps 30` `--crf 20` `--preset veryfast` `--frames 3`
`--keep`（保留中间文件）`--quiet` `--ffmpeg PATH`。
没给 `--ffmpeg` 时按 `$env:FFMPEG` → `../_tooling/ffmpeg.exe` → `ffmpeg` 的顺序找。

快速回归（4 张卡各 2 秒，约 15 秒出片）：`renderer/demo/smoke.json`。

## script.json 结构

```jsonc
{
  "slug": "demo",                 // 输出文件名 demo.mp4
  "title": "DSH 视频渲染引擎",
  "subtitle": "一条命令，把 JSON 剧本变成成片",
  "episode": "EP.07",             // 封面右上角的期号角标
  "channel": "@DSH 实验室",        // 可选，封面左下角
  "desc": "投稿简介…",
  "tags": ["自动化", "ffmpeg"],
  "transitionSec": 0.4,           // xfade 交叉转场时长，0 = 硬切
  "bgm": true,                    // false = 只出静音轨
  "theme": { "accent": "#4ea1ff" },
  "scenes": [ /* … */ ]
}
```

每条 scene 的字段：

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `type` | 全部 | `hook` / `screen` / `quote` / `sticker`（`title` 是 `hook` 的别名） |
| `durationSec` | 全部 | 该卡时长；按 `--fps` 取整到整帧（`round(sec*fps)`） |
| `text` | 全部 | hook = 大标题；quote = 大字引用；sticker = 贴纸下方标题；screen = 旁白（只进字幕） |
| `subtitle` | hook 内是**字符串** | hook 卡标题下的副标题文本 |
| `subtitle: false` | 非 hook | 关掉这张卡的 ASS 字幕（quote/sticker 卡默认建议关，避免与卡面文字重复） |
| `kicker` | hook | 大标题上方的小字（默认取 `script.subtitle`） |
| `label` | screen | 截图左上角的橙色小标签 |
| `caption` | sticker | 贴纸标题下方的小字 |
| `imagePath` | screen / sticker | 相对 `script.json` 目录；screen 是任意截图，sticker 必须是带 alpha 的 png |
| `voicePath` | 全部 | 该 scene 的人声轨（相对 script.json 目录）；存在时 BGM 自动压到 -22dB |

## 加一个 scene

在 `scenes` 数组里插一条即可，时间轴、字幕、转场全自动重算：

```jsonc
{
  "type": "screen",
  "imagePath": "img/screen_2.png",
  "label": "新的一张截图",
  "text": "这里是旁白。会被自动切成两句字幕。",
  "durationSec": 9.5
}
```

规则：

* **时长求和**：总时长 = Σ`durationSec` − (n−1)×`transitionSec`。
  例：10 条共 93.6s、转场 0.4s → 成片正好 90.0s。
* 每条 scene 独立渲染成一个临时 mp4（统一 1920x1080 / yuv420p / 同 fps），
  再用一条 `xfade` 链拼接、烧字幕、混音——所以新增 scene 不会影响别的卡。
* 想加**新的卡片类型**：在 `render.mjs` 写一个 `xxxFilter(scene, ctx, idx, isLast)`
  （返回 filter_complex 文本，最后一级接 `clipTail(...)` 标成 `[vout]`），
  把类型名加进 `SCENE_TYPES`，并在 `scenes.forEach` 的分发处加一个分支。

## 替换配色

配色全部集中在两处，**不需要任何图片素材**（背景、渐变、暗角、噪点都是 `lib/png.mjs` 现画的）：

1. `lib/theme.mjs` 的 `DEFAULT_THEME` —— 改这里就是改默认值；
2. 或者在 `script.json` 里写 `theme: {…}` 局部覆盖（推荐，只影响这一期）。

```jsonc
"theme": {
  "bgTop": "#0a0610", "bgMid": "#170d20", "bgBottom": "#2a1330",
  "accent": "#ff8a3d",      // 强调色：小标题横条、截图描边、封面角标、卡片下划线
  "accent2": "#ff5f9e",     // 次强调：quote/sticker 卡背景光晕
  "text": "#f2f5ff",        // 大标题 / 引用文字
  "dim": "#9aa6c4",         // 副标题 / 说明文字
  "assFont": "Microsoft YaHei",
  "fontRegular": "C:/Windows/Fonts/msyh.ttc",
  "fontBold": "C:/Windows/Fonts/msyhbd.ttc",
  "sizes": { "title": 112, "quote": 92, "sticker": 62, "subtitle": 46, "ass": 56 }
}
```

字幕样式（字号之外）在 `render.mjs` 调 `writeAss` 的那一处：`outlineWidth: 4`、`shadow: 2`、
`marginV: 86`（底部安全区）、`maxCharsPerLine: 21`。

## 字幕

* 只对 `subtitle !== false` 且不是 hook 的卡出字幕。
* `text` 按 `。！？!?…` 和换行切句，句间按**字数比例**分配这张卡的时间，两侧各留 0.05×时长（≤0.18s）的呼吸位。
* 行宽 21 字、字号 56、描边 4 + 阴影 2、Alignment=2、MarginV=86 → 1080p 底部安全区内。
* 中文用 `Microsoft YaHei`（libass 直接按字体名找系统字体）。

## 音频

* BGM 由 `lib/audio.mjs` **程序化合成**（Am-F-C-G 四小节：小幅失谐 pad + 八分琶音 + 气声噪声，
  再过一级 5.2kHz 低通、归一化到 -5dB 峰值、1.2s 淡入 / 2.2s 淡出），写成 48kHz 立体声 WAV。
* 无人声：BGM 音量 0.22（≈ -13dB）；**只要有一张卡带 `voicePath`，BGM 自动降到 0.0794（-22dB）**。
* 人声按 scene 起点 `adelay` 对齐，`amix normalize=0` 混音，最后 `apad+atrim` 卡到成片精确时长。

## 环境坑（都已在代码里绕过，改代码时别踩回去）

1. **drawtext 的中文不能写在 `text=` 里**：写成 `text='中文'` 会渲染成豆腐块（实测）。
   必须把文本写进 UTF-8 文件、用 `textfile=` 引用 —— 全部卡片文字都走这条路。
2. **字体路径里的冒号要转义**：`fontfile='C\:/Windows/Fonts/msyh.ttc'`，否则 filtergraph 在冒号处断句。
3. **表达式含逗号必须加引号**：`alpha='if(lt(t,0.45),t/0.45,1)'`、`y='380-26*(1-min(t,0.7,1))'`。
4. **本机沙箱禁止管道 stdio**：`spawnSync` 用默认 `pipe` 会直接 EPERM。
   `lib/ff.mjs` 改成把子进程 stdout/stderr 绑到真实文件 fd，再回读日志。
5. **这份 ffmpeg 没有 ffprobe.exe**：`lib/ff.mjs` 用 `ffmpeg -i` 的 banner 解析时长/分辨率/码率/音轨。
6. **drawtext 不会自动折行**：`wrapL()` 先按字号折算安全宽度手动折行；而
   drawtext 也无法逐行居中，所以一个文本块是**一行一个 drawtext**（`pushTextBlock()`），各自 `x=(w-text_w)/2`。
7. **zoompan 前必须先把图 cover 成目标画幅**（`scale=…:force_original_aspect_ratio=increase,crop=…`），
   否则 zoompan 会把宽高比不同的图直接拉伸变形。
8. **xfade 要显式 `settb=AVTB,fps=N,format=yuv420p`**，否则时间基不一致会直接报错。

## 已实测

`renderer/out/demo.mp4`：1920x1080、**90.000s**、1431 kb/s、H.264 High yuv420p 30fps、
AAC 192kb/s 48kHz 立体声；音轨 `volumedetect` mean −21.3dB / max −18.4dB（BGM 有实际内容）。
