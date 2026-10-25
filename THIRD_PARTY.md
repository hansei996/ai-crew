# 第三方组件与许可证

本仓库**不含**任何第三方二进制或模型权重，只含我们自己的代码与文档。运行时可能用到：

| 组件 | 用途 | 许可证 | 商用注意 |
| --- | --- | --- | --- |
| **FFmpeg**（gyan.dev essentials build） | 渲染、编码、滤镜 | **GPL/LGPL 混合**（该 build 含 libx264 等 GPL 组件） | **以 GPL 发布你的分发包时需遵守 GPL**；仅自己用不受影响 |
| **Noto Sans SC** | 标题字体 | **SIL Open Font License 1.1** | 可商用，需保留许可声明 |
| **Cascadia Code / Mono** | 等宽字体 | **MIT** | 可商用 |
| **Microsoft YaHei**（系统自带） | ASS 字幕 | 随 Windows 授权 | 用于视频输出通常可接受，商用分发字体文件不可以 |
| **IndexTTS-2.5** | 本地语音合成（可选） | **bilibili Model Use License** | **商用需邮件申请授权**，侵权责任归使用者 |
| **Edge TTS（read-aloud 接口）** | 云端语音合成（可选） | 非官方公开 API | 属厂商网页接口，**有服务条款风险**，商用自行评估 |

## 我们的立场

· 仓库代码：**MIT**（见 LICENSE）。
· **我们不打包任何模型权重、字体文件、ffmpeg 二进制**——请自行获取并遵守各自许可。
· 如果要用 IndexTTS 做商业内容，**先去 bilibili 官方申请书面授权**；这条我们是踩过坑才写的。