# 本地 TTS 工具链（infra 维护 · 2026-10-25）

一句话：**本文件是配音这件事的唯一入口。** 装了什么、什么许可、怎么跑、怎么验、跑挂了怎么办，全部在这里。

| 引擎 | 许可 | 状态 | 用途 |
|---|---|---|---|
| IndexTTS-2.5（WIndexTTS 整合包） | bilibili Model Use License（非 Apache/MIT，商用需邮件授权） | **现役 fallback** | 有参考音就要用它；情感控制最强 |
| CosyVoice-300M-SFT | Apache-2.0 | 可用 | 预置音色 5 个（中文女/中文男/粤语女/韩语女/英文女） |
| CosyVoice2-0.5B | Apache-2.0 | 可用但**无预置音色** | 只能零样本克隆（需参考音） |
| Spark-TTS-0.5B | Apache-2.0 | 可用 | **参数造音**（gender/pitch/speed），音色空间连续 |
| Kokoro-82M | Apache-2.0 | 可用 | 最轻最快（RTF 0.03），中文 4 个女声 |
| Edge ReadAloud（`bili_run/tts/tts.mjs`） | 微软服务条款，非本地模型 | 可用 | 零安装，云端，非商用风险见下 |
| DeepSeek 官方 WSS | — | **已封存（违反 ToS）** | 禁止在生产链路调用，见文末 |

---

## 0. 先看结论：怎么选

1. **要稳定出片、今天就要** → `tts_local.py` + IndexTTS + `ref_xiaoyi-p15-340hz.wav` + EQ（见 §2.2，实测 F0 333.3Hz / 软糯 5.91dB，双指标同时过）。
2. **要许可干净、想挑音色** → CosyVoice-SFT / Kokoro / Spark（全 Apache-2.0，见 `voice/cosyvoice-ab.md` 的 17 条实测）。
3. **要最像官方 stella** → Spark `female|moderate|low`（246.2Hz / 2.37 音节·秒⁻¹，音高与语速最贴），软糯需人耳判。

---

## 1. 机器事实（写死，改机器要改这里）

| 项 | 值 |
|---|---|
| OS / GPU | Win10 19045 / RTX 4070 Ti SUPER 16GB（driver 596.21） |
| 系统 Python | 3.11.9（`<USERPROFILE>\Python311\python.exe`） |
| 分析用 venv | `<LOCAL_TTS_ROOT>\venv`（torch 2.6.0+cu124 / librosa 0.11.0 / numpy 2.4.6 / soundfile 0.14.0） |
| CosyVoice venv | `<LOCAL_TTS_ROOT>\cosyvoice-venv`（从上面 robocopy 复制的副本，再装 CosyVoice 依赖；**不要在原 venv 上装 CosyVoice**） |
| Spark venv | `<LOCAL_TTS_ROOT>\spark-venv`（同上复制，transformers 锁 4.46.2） |
| IndexTTS 运行时 | `<WINDIFFTTS_BUNDLE>\runtime\python.exe`（3.12.10，自带 ffmpeg+ffprobe，**无 pip**） |
| ffmpeg | 优先 `<WINDIFFTTS_BUNDLE>\ffmpeg\bin\{ffmpeg,ffprobe}.exe`（8.1.2 full build，带 rubberband/libass/drawtext） |

---

## 2. 现役链路：IndexTTS-2.5

### 2.1 安装（已经是安装好的，重建时按这个来）

整合包 `<WINDIFFTTS_BUNDLE>`：自带 python 3.12.10 + ffmpeg + ffprobe，**没有 pip**。
要装 Python 包只能借别的 pip `--target` 塞进 runtime：

```powershell
& '<LOCAL_TTS_ROOT>\venv\Scripts\python.exe' -m pip install --target '<WINDIFFTTS_BUNDLE>\runtime\Lib\site-packages' <pkg>
```

### 2.2 出片命令（推荐配方：p15 参考音 + 4.5k 高频压 6dB）

```powershell
# ① 生成参考音（只做一次）：pitch×1.15 后再压 4–8kHz 刺音
& '<WINDIFFTTS_BUNDLE>\ffmpeg\bin\ffmpeg.exe' -hide_banner -loglevel error -y ^
  -i '<WORKSPACE>\bili_run\tts\refs\r_xiaoyi.wav' ^
  -af "rubberband=pitch=1.15,highshelf=f=4500:g=-6" ^
  '<WORKSPACE>\bili_run\tts\refs\ref_xiaoyi-p15-eq6hr.wav'

# ② 合成整集（写回 script.json 的 durationSec / voicePath）
$env:WINDEXTTS_WEIGHTS_DIR='<WINDIFFTTS_BUNDLE>\models\IndexTTS-2.5'
$env:TTS_EMO_TEXT='轻快、认真、像刚跑完实验在汇报'
& '<WINDIFFTTS_BUNDLE>\runtime\python.exe' ^
  '<WORKSPACE>\bili_run\tts_local.py' ^
  '<WORKSPACE>\bili_run\episodes\exp001\script.json' ^
  '<WORKSPACE>\bili_run\tts\refs\ref_xiaoyi-p15-eq6hr.wav'
```

实测（同一句 51 字，measure_voice.py）：

| 参考音 | 输出 F0 中位 | p10–p90 | 起伏 | 软糯加权偏离 | 判定 |
|---|---|---|---|---|---|
| `r_xiaoyi.wav`（296.3Hz） | 275.9 | 195–356 | 160 | 5.44 dB | 音高不达标 |
| `ref_xiaoyi-p15-340hz.wav`（340.4Hz） | 333.3 | 271–432 | 161 | 7.91 dB | 软糯超标 |
| **pitch1.15 + highshelf f=4500 g=-6** | **333.3** | 271–432 | 161 | **5.91 dB** | **双指标同时过** |
| pitch1.15 + eq f=6000 w=3000 g=-6 | 333.3 | 271–421 | 150 | 9.50 dB | 失败 |
| pitch1.15 + lowpass 9500 | 333.3 | 276–444 | 169 | 8.88 dB | 失败 |

结论：**压 4.5kHz 以上的高频架，是唯一既能保 F0 又能把软糯压回 6dB 以内的干净做法**。

### 2.3 参数

| 参数 | 位置 | 说明 |
|---|---|---|
| `WINDEXTTS_WEIGHTS_DIR` | 环境变量 | **必须设**，CLI 默认值写死的是 Linux 路径 `/root/IndexTTS-2.5` |
| `--model-dir` | CLI | 同上，二选一 |
| `--ref` | CLI | 参考音 5–15s 干净人声，单声道 |
| `TTS_EMO_TEXT` | 环境变量 | 情感文本提示，`tts_local.py` 读取 |
| `TTS_EMO_ALPHA` | 环境变量 | 默认 1.0 |
| `--low-vram` | CLI | 3–4GB 显卡模式（w2v 放 CPU），稳定 ~2.9GB |
| `--w4a16` | CLI | INT4 量化 GPT，最快，需要 torchao |

性能（RTX 4070 Ti Supervisor 16GB，fp16 + CUDA Graph，与他人共卡时实测）：
RTF **0.41–0.71**（5.19s 音频 3.68s 生成）、峰值显存 **9.24 GB**（含他人占用）、输出 22050Hz 单声道。

---

## 3. CosyVoice（Apache-2.0）

### 3.1 安装（已完成，重建照做）

```powershell
# ① 代码（commit 074ca6d）
git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/FunAudioLLM/CosyVoice.git <LOCAL_TTS_ROOT>\cosyvoice
# ② 独立 venv（复制现成的，保住 torch 2.6.0+cu124，避免降级）
robocopy <LOCAL_TTS_ROOT>\venv <LOCAL_TTS_ROOT>\cosyvoice-venv /E
# ③ 依赖（不要装 torch/torchaudio 那两个 pin，环境里已有）
& '<LOCAL_TTS_ROOT>\cosyvoice-venv\Scripts\python.exe' -m pip install conformer==0.3.2 diffusers==0.29.0 hydra-core==1.3.2 HyperPyYAML==1.2.3 inflect==7.3.1 librosa==0.10.2 matplotlib==3.7.5 modelscope==1.20.0 networkx==3.1 numpy==1.26.4 omegaconf==2.3.0 onnx==1.16.0 onnxruntime==1.18.0 protobuf==4.25 pyarrow==18.1.0 pydantic==2.7.0 pyworld==0.3.4 rich==13.7.1 soundfile==0.12.1 transformers==4.51.3 x-transformers==2.11.24 wetext==0.0.4 wget==3.2 gdown==5.1.0
# ④ 两个必补的坑包
& ...python.exe -m pip install "setuptools<81" wheel
& ...python.exe -m pip install --no-build-isolation openai-whisper==20231117   # 不加 --no-build-isolation 会 pkg_resources 报错
& ...python.exe -m pip install --no-build-isolation lightning==2.2.4            # Matcha-TTS 依赖
# ⑤ 权重
& ...python.exe -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice-300M-SFT', local_dir=r'<LOCAL_TTS_ROOT>\cosyvoice\pretrained_models\CosyVoice-300M-SFT')"
```

### 3.2 命令

```powershell
$env:PYTHONPATH='<LOCAL_TTS_ROOT>\cosyvoice;<LOCAL_TTS_ROOT>\cosyvoice\third_party\Matcha-TTS'
# 预置音色（SFT）
& '<LOCAL_TTS_ROOT>\cosyvoice-venv\Scripts\python.exe' <LOCAL_TTS_ROOT>\cosyvoice\sft_infer.py ^
  --text "台词" --outdir <目录> --spks 中文女 粤语女
# 零样本克隆（CosyVoice-300M / CosyVoice2-0.5B）
& '<LOCAL_TTS_ROOT>\cosyvoice-venv\Scripts\python.exe' <LOCAL_TTS_ROOT>\cosyvoice\cosyvoice_zs.py ^
  --prompt-wav <5–15s 参考音> --prompt-text "<参考音逐字文本>" --text "台词" --out out.wav
```

**参数/事实**：输出 22050Hz（CosyVoice2 为 24000Hz）；加载 13.9s（热缓存）/52.5s（首次，含 wetext 拉取）；RTF 0.97–1.28；峰值显存 1.9 GB（CosyVoice2 2.4 GB）。
**已知坑**：wetext 文本前端会尝试从 modelscope 拉模型并 403（打印 `no frontend is avaliable`），此时**仍能合成**，但数字/英文缩写读法不保证；纯汉字中文台词不受影响。

---

## 4. Spark-TTS（Apache-2.0，参数造音）

```powershell
# 安装：克隆 + 复制 venv + 装依赖
git clone --depth 1 https://github.com/SparkAudio/Spark-TTS.git <LOCAL_TTS_ROOT>\spark-tts
robocopy <LOCAL_TTS_ROOT>\cosyvoice-venv <LOCAL_TTS_ROOT>\spark-venv /E
& '<LOCAL_TTS_ROOT>\spark-venv\Scripts\python.exe' -m pip install --no-build-isolation einx==0.3.0 einops==0.8.1 soxr==0.5.0.post1 safetensors==0.5.2 transformers==4.46.2
& '<LOCAL_TTS_ROOT>\cosyvoice-venv\Scripts\python.exe' -c "from modelscope import snapshot_download; snapshot_download('SparkAudio/Spark-TTS-0.5B', local_dir=r'<LOCAL_TTS_ROOT>\spark-tts\pretrained_models\Spark-TTS-0.5B')"

# 造音（gender ∈ male|female；pitch/speed ∈ very_low|low|moderate|high|very_high）
& '<LOCAL_TTS_ROOT>\spark-venv\Scripts\python.exe' <LOCAL_TTS_ROOT>\spark-tts\spark_grid.py ^
  --text "台词" --outdir <目录> --combos "female|moderate|low;female|high|low"
```

事实：输出 **16000Hz**、RTF 2.0–3.5、峰值显存 4.0 GB、首次加载约 40s。
**软糯指标对 16kHz 音源不可比**（标尺最高一段 8k–16k 恒为 0），详见 `voice/cosyvoice-ab.md`。

---

## 5. Kokoro-82M（Apache-2.0，最轻）

```powershell
& '<LOCAL_TTS_ROOT>\cosyvoice-venv\Scripts\python.exe' -m pip install --no-build-isolation kokoro "misaki[zh]"
# 权重不能用 huggingface_hub 拉（本机 python 侧连不上，hf-mirror 也报 LocalEntryNotFound）→ 用 curl 直取后 seed 缓存
curl.exe -sSL -o <LOCAL_TTS_ROOT>\kokoro\config.json        https://hf-mirror.com/hexgrad/Kokoro-82M/resolve/main/config.json
curl.exe -sSL -o <LOCAL_TTS_ROOT>\kokoro\kokoro-v1_0.pth    https://hf-mirror.com/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth
foreach($v in 'zf_xiaobei','zf_xiaoni','zf_xiaoxiao','zf_xiaoyi'){ curl.exe -sSL -o "<LOCAL_TTS_ROOT>\kokoro\voices\$v.pt" "https://hf-mirror.com/hexgrad/Kokoro-82M/resolve/main/voices/$v.pt" }
# 再按 toolchain 记录复制到 %USERPROFILE%\.cache\huggingface\hub\models--hexgrad--Kokoro-82M\snapshots\main\ + refs\main
$env:HF_HUB_OFFLINE='1'
& '<LOCAL_TTS_ROOT>\cosyvoice-venv\Scripts\python.exe' <LOCAL_TTS_ROOT>\kokoro_gen.py --text "台词" --outdir <目录>
```

事实：加载 4.0s、**RTF 0.03–0.11**（4 条 31 字台词共 0.7s 生成）、输出 24000Hz。

---

## 6. 冒烟测试（每个工具一条命令 + 预期输出 + 兜底）

> 本机 `LocalMachine` 执行策略 = **Restricted**，`.ps1` 不能直接调用；全部走 `.cmd` 包装（内部 `-ExecutionPolicy Bypass`，不改系统策略）。
> 另：`.ps1` 必须存成 **UTF-8 with BOM**，否则 Windows PowerShell 5.1 按 GBK 解码，中文打断解析。

| 工具 | 一条命令 | 预期输出 | 失败兜底 |
|---|---|---|---|
| 指标工具 | `bili_run\scripts\smoke\smoke_measure_voice.cmd` | `f0_med = 296.3 Hz…SMOKE OK` | 参考音被替换 → 核对 `tts\refs\r_xiaoyi.wav`；缺 librosa → 重建 venv |
| 软糯标尺 | `smoke_softness.cmd` | `run1 = 5.44 dB / run2 = 5.44 dB / SMOKE OK` | 两遍不一致 = 不可复现，查 librosa 版本 |
| IndexTTS | `smoke_indextts.cmd` | `(N.NNs audio in XXXXms, RTF=0.4~0.8, 22050Hz)` | 找不到 config.yaml → 忘了 `--model-dir`；OOM → `--low-vram` |
| CosyVoice | `smoke_cosyvoice.cmd` | `{"stage": "loaded",…}` + `{"spk": "中文女",…}` | 缺 whisper/lightning → 补装两步；`no frontend is avaliable` 可忽略 |
| 封存校验 | `smoke_deepseek_sealed.cmd` | 含 `REFUSED` …`SMOKE OK（封存有效）` | 若跑起来 = 自锁被绕过，立刻停手 |

其余脚本（Spark / Kokoro / 音色库）没有单独冒烟脚本，用「一条命令」验收：
`spark_grid.py --combos "female|moderate|low"` 必须打印 `{"combo":…,"sec":…}`；
`kokoro_gen.py --voices zf_xiaobei` 必须打印 `{"voice":"zf_xiaobei","sec":…}`。

---

## 7. GPU 调度与显存预算（16GB）

| 场景 | 常驻显存 | 并发建议 |
|---|---|---|
| IndexTTS fp16（含 BigVGAN+DiT，CUDA Graph） | ~9.2 GB 峰值（含他人占用时的观测） | **独占**，不要与 Spark 同跑 |
| Spark-TTS-0.5B | 4.0 GB | 可与 Kokoro 同跑 |
| CosyVoice-300M-SFT / CosyVoice2-0.5B | 1.9 / 2.4 GB | 可与 Kokoro 同跑，勿与 IndexTTS 同跑 |
| Kokoro-82M | <1 GB（未单测，估） | 随便跑 |
| ffmpeg 编码（CPU） | 0 | 与任何 TTS 并行无冲突 |

优先级：**出片合成（IndexTTS）> 评测批跑（Spark/CosyVoice）> 分析（软糯/F0，纯 CPU）**。
实测教训：本机曾被两个 `runtime\python.exe`（IndexTTS）占掉 5.6GB，导致新任务只剩 6GB —— **批量前先 `nvidia-smi` 看余量**。

---

## 8. 环境坑清单（全部踩过）

1. `python3` 指向 0 字节 WindowsApps 存根，`python3 --version` exit 9009 **零输出**，脚本静默失败 → 建 `python3.cmd` 转发到 `python`。
2. `ffmpeg`/`ffprobe` 不在 PATH → 一律用整合包 `ffmpeg\bin` 的绝对路径。
3. 整合包 runtime **没有 pip** → 借 venv 的 pip `--target` 装进 `runtime\Lib\site-packages`。
4. `torchaudio.save` 不支持 float16 wav → 转 float32 走 `soundfile`。
5. PowerShell 里 `npm` 必须 `npm.cmd`（`npm.ps1` 被执行策略拦）。
6. `ffmpeg drawtext` 中文必须 `textfile=`，直接 `text='中文'` 出豆腐块。
7. **新增**：WIndexTTS CLI 的 `--model-dir` 默认值是 Linux 路径 `/root/IndexTTS-2.5`，不传就报 `config.yaml` 打开失败。
8. **新增**：`.ps1` 必须 UTF-8 **带 BOM**，否则 PS 5.1 按 GBK 解析报「字符串缺少终止符」。
9. **新增**：`openai-whisper` 在 setuptools≥81 下装不上（`pkg_resources` 被移除）→ `pip install "setuptools<81"` 后加 `--no-build-isolation`。
10. **新增**：`huggingface_hub` 在本机 python 里连不上（hf-mirror 也 `LocalEntryNotFound`），但 PowerShell 的 `Invoke-WebRequest`/`curl.exe` 能取 → 权重用 curl 取完 seed 缓存，再 `HF_HUB_OFFLINE=1` 跑。
11. **新增**：`pcm` 帧若来自外部 WS（见 §9），每帧前 4 字节是大端序号，不是音频。

---

## 9. DeepSeek 官方 WSS 客户端（已封存，禁止调用）

`bili_run\toolchain\deepseek_tts.mjs` 保留了完整技术档案（复现研究用），文件头写明了合规定性与依据，
并且**运行时自锁**：未设 `DS_TTS_FORBIDDEN_ACK=1` 时任何子命令直接 `REFUSED` 退出。

**为什么封存**：DeepSeek 用户协议 3.5(3) 禁止反向工程/尝试获取服务算法与底层组件、禁止以机器人或其他自动设置抓取服务内容；
我们复现 PoW（DSHashV1）、手写 WSS 内部接口、程序化批量调用，逐条落入禁止范围。3.4（对抗风控机制）、2.3(4)（账号不得提供他人使用）同样擦边。

**已产出物处置**：`episodes/exp001/voice/s1..s6.mp3`（6 句 76.32s）与 `<LOCAL_TTS_ROOT>\_dl\e2e_*.mp3` **不删除、不使用、不外发**；
审计日志保留在 `bili_run\state\deepseek_tts_log.json`（含 session_id / prompt / message_id / 音频路径 / 字节 / 时长 / 时间戳，以及会话删除结果）。

**替代路径**：全部改用 §1–§5 的本地 Apache-2.0 引擎 + 用户自录音色（`cosyvoice_zs.py` 零样本克隆）。

---

## 10. 未量项（不装作量过）

- CosyVoice / Spark / Kokoro 的**主观听感**（本轮只给声学数字，人耳判定由用户做）。
- Spark-TTS 的**软糯加权偏离**（16kHz 带宽导致跨采样率不可比，见 `voice/cosyvoice-ab.md`）。
- Kokoro 的**显存峰值**（未单独采样，估 <1GB）。
- CosyVoice2-0.5B 的 **RTF**（无预置音色，未跑 SFT 路径）。
