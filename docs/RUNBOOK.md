# 日更 runbook（每天一条，自动执行）

账号：<UNAME>（mid <MID_OLD>）｜赛道：GitHub 开源项目拆解 × 大肥鱼人设｜形态：AI 合成横屏 1080p，45–90 秒

## 铁律（踩过的坑，别重犯）
1. **联网只在 run_code 的 Node 里**；pwsh 子进程无外网。**spawn 只在 pwsh 里**；run_code 里 spawn 会 EPERM。
2. 不能 npm install，一切零依赖纯 Node。
3. ffmpeg：`bili_run/_tooling/ffmpeg.exe`（libx264/libass/drawtext 齐全，没有 ffprobe，用 `ffmpeg -i` 解析）。
4. drawtext 中文必须走 `textfile=`，直接写 text='中文' 会出豆腐块。
5. 封面必须 JPEG；PNG 会直接被 cover/up 拒绝。
6. **不要传 neutral_mark**：B 站回报 21517「选择的创作声明不存在」。AI 声明写在简介里。
7. cookie 在 `publisher/cookie.json`，失效就重跑 `node publisher/login.mjs` 扫码。

## 每日五步
1. 取选题：读 `content/topics.json`，跳过 `state/published.json` 里已发的 topicId，取排期最早的一条。
2. 拿真事实：`raw.githubusercontent.com/<repo>/main/README.md`（GitHub API 60/小时会被限流，别用 API 抓正文）。
3. 写剧本：`episodes/epNN/script.json`（字段见 `renderer/README.md`）。**只要能被证据支撑的判断，不许编造实测结果**；没法真跑的项目就写成「拆解/读源码」，视频里要说明。
4. 生成：
   - run_code：设置 `process.argv[2]=script.json` 后 `await import('file:///.../bili_run/tts_fill.mjs')`
   - pwsh：`cd bili_run && node render_meta.mjs episodes/epNN/script.json`
5. 发布：`cd bili_run/publisher && node upload.mjs --file ../episodes/epNN/out/epNN.mp4 --meta ../episodes/epNN/out/publish.json --yes`
   发布后把 bvid 追加进 `state/published.json`。

## 剧本写法（已验证有效的节奏）
hook(9s) → quote(11s) → quote(10s) → quote(9s) → quote(11s) → hook收尾(9s)
每张卡 `cueText` 写字幕文本、`line` 写配音文本；quote 卡大字要给结论，字幕给完整口播。
标题用疑问句（竞品实抓：疑问句中位 20121 播放，是事实陈述的 2 倍）。分区 tid=231（科技·计算机技术）。

## 2026-10-25 能力升级（重要）
本会话已切到 danger-full-access，**pwsh 子进程现在有外网**，实测：
- `curl https://api.github.com` → 200（之前是 000）
- `git clone --depth 1 <repo>` → 成功（23 个条目）
- `npm.cmd install <pkg>` → 成功（注意必须用 **npm.cmd**，npm.ps1 被 PowerShell 执行策略拦）

这意味着内容形态可以升级：从「读 README 拆解」→「**克隆下来真跑一遍**」。
推荐做法：`git clone --depth 1` 到 `bili_run\labs\<repo>`，按 README 跑起来，
录屏截图用 ffmpeg 抓窗口或直接用命令行输出截图卡，把"真跑过"的证据放进视频。
仍是零 npm 依赖的规则只针对**我们自己的流水线**；被测项目本身可以用 npm/pip。

## 【最新，优先级最高】EXP 实验日志规范（二次修订）
账号：<UNAME>（mid <MID>，Lv2，已实名）。旧号只保留 EP.01。
**差异化红线见 DIFFERENTIATION.md——不看它就不要动笔。**
编号用 EXP.NNN，不要用 Day N。

每期固定 6 卡：
1. hook：EXP.NNN 角标 + 一句话结论（带数字，≤12 汉字）
2. quote：假设（我要验证什么）
3. quote/sticker：昨日真实数据（播放/点赞/粉丝，API 抓，抓不到就说明）
4. quote：方法 + 结果（跑通 / 跑挂，卡在哪一步）
5. screen/quote：证据（截图或命令输出）
6. hook：结论 + 评论区点题（48 小时交付）

禁止编造实测。跑挂照发。遇 601 停手上报。

## 【2026-10-25 夜班实测补充】沙箱等级决定能不能装包（先看 policy 再动手）
夜班开场先看 runtime 的 file policy，两种档位差别很大：

| 操作 | workspace-write | danger-full-access |
|---|---|---|
| `git clone` / `npm ping` | ✅ 通（curl 到 github 仍是 000，别拿 curl 判断网络） | ✅ |
| `npm ci`（带生命周期脚本） | ❌ `npm error code EPERM / syscall spawn / errno -4048` | ✅ |
| `npm ci --ignore-scripts` | ✅ 等价可用（719 包 21s） | ✅ |
| `npm run build`（会再 spawn） | ❌ 直接调入口：`node node_modules/<tool>/dist/run.mjs` | ✅ |
| `jest` 默认多 worker | ❌ 必须 `--runInBand` | ✅ |
| msedge/chromium `--headless` 截图 | ❌ `mojo platform_channel.cc:187 Check failed`（命名管道被拒） | ✅ 加 `--user-data-dir=<工作区内路径>` |

其它踩到的事实：
1. pwsh 里 `cmd *> file.log` 产出 **UTF-16LE（BOM `FF FE`）**；脚本读日志必须先判 BOM，否则中文与正则全失配。
2. 截图取证流程（已验证可复用）：真实输出 → `lab\.tools\ansi2html.mjs` 转深色终端风 HTML → Edge `--headless=new --no-sandbox --disable-gpu --user-data-dir=...` 截 PNG。
3. 实验目录统一 `bili_run\lab\<repo>`；旧 `labs\` 是 10-24 场的半成品，别再往里放。
4. 证据图至少 2 张 + 原始日志，全部进 `assets\<id>\`；结论文档四段进 `knowledge\<id>.md`。