# ai-crew

> 一套能在 **Windows** 上自动运营 AI 账号的开源工具箱：剧本 → 配音 → 渲染 → 投稿 → 风控闸门。
> **零依赖**：只用 Node 内置模块 + 一个 ffmpeg.exe。没有 npm install，没有 Docker，没有云服务。

我们用它真的运营过一个 B 站账号（发布、过审、撞过 601、删过稿、重来过）。这个仓库是那两天打出来的东西，不是写出来的 demo。

---

## 它能干什么

| 模块 | 能力 |
| --- | --- |
| `renderer/` | 一份 JSON 剧本 → 1080p 成片 + 封面 + 投稿元数据。字幕走 libass，转场走 xfade，BGM 程序化合成 |
| `tts/` | 双链路配音：Edge TTS（云端，需外网）/ IndexTTS（本地 GPU，参数化情感） |
| `publisher/` | B 站扫码登录、UPOS 分片上传、封面、稿件提交、评论队列、素材合规台账、发布闸门 |
| `publisher/lib/p0.mjs` | **首帧判据**：防止你的视频在列表页显示成一块黑板（我们踩过三次） |
| `publisher/publish_gate.mjs` | **发布闸门**：13+ 项自检，不通过直接非零退出，让 upload 无路可走 |
| `docs/` | 实战沉淀：运营手册、差异化红线、视觉规范、人设审校门禁、TTS 工具链踩坑 |

## 5 分钟快速开始

```bash
# 1. 准备一个 ffmpeg.exe（建议 gyan.dev 的 essentials build，含 libx264/libass/drawtext）
#    放到任意位置，然后在环境变量 FFMPEG 里指向它

# 2. 复制配置
copy config.example.json config.json
#    填 ffmpegPath 与 workspaceRoot

# 3. 渲染一条 15 秒样片（不需要登录、不需要联网）
node renderer/render.mjs renderer/demo/script.json --out out

# 4. 登录 B 站（会生成一张二维码 PNG，手机 App 扫）
node publisher/login.mjs

# 5. 发布前必过闸门
node publisher/publish_gate.mjs --file <你的.mp4> --meta <你的 publish.json>
node publisher/upload.mjs --file <你的.mp4> --meta <你的 publish.json> --yes
```

## 我们踩过的 10 个坑（省你几天）

1. **封面必须是 JPEG**。B 站 `cover/up` 收 `data:image/jpeg;base64`，给 PNG 直接失败。
2. **`neutral_mark` 传任何值都报 21517**（选择的创作声明不存在）。我们自己不传，AI 声明写在简介里。
3. **`drawtext` 里写中文会出豆腐块**，必须 `textfile=` 指向 UTF-8 文件。
4. **ASS 字幕要填 font 家族名不是文件名**。`NotoSansSC-VF` 会被解析成 ArialMT，中文缺字。
5. **首帧不能是黑的**。B 站列表页取 t=0 帧，我们用 `publisher/lib/p0.mjs` 判 `spread≥40 且 内容占比≥0.1%`。
6. **601 是账号级风控，不是 IP**。同一秒同 IP 下老号 200、新号 406+601。新号第一次投稿建议先手动传一条过掉滑块。
7. **`process.exit()` 在 Windows 上会返回 0xC0000409**，看起来像崩溃但其实是正常退出。用 `process.exitCode`。
8. **PowerShell 里 npm 必须用 `npm.cmd`**（`npm.ps1` 被执行策略拦）。
9. **素材必须有出处**。我们的台账里 338 项只有 5 项可商用——剩下全是授权未声明的表情包。见 `publisher/lib/assets.mjs`。
10. **不稳定指标不能当事实**。同一个命令我们测出 0.62s / 1.06s / 1.72s，波动 2.8 倍——这种数字不要写进片子。

## 目录

```
renderer/    剧本 → 成片（render.mjs + lib/）
tts/         双链路配音（Edge 云端 / IndexTTS 本地）
publisher/   B 站登录、上传、闸门、评论、素材台账
docs/        运营手册 / 差异化红线 / 视觉规范 / 人设门禁 / TTS 踩坑
scripts/     仓库自检（泄漏扫描）
```

## 边界与免责

· 本项目只调用**公开文档化的 B 站 web 接口**，用自己的账号、自己的内容。**不含任何绕过风控、破解或批量自动化的实现。**
· 我们曾逆向过某个非公开接口（PoW + 内部 WSS），**那部分代码不在此仓库**，且因违反服务条款已弃用——留着这句是为了让你别重走。
· 自动化投稿有账号风险。**先小号试，别拿主号开刀。**
· 许可证见 `LICENSE` 与 `THIRD_PARTY.md`；第三方模型的商用限制请看后者。