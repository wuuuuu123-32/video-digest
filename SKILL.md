---
name: video-digest
description: 把视频（尤其 B站）降维成 agent 能读的材料——字幕全文 + 关键帧拼图，然后读文字、看图来提取视频信息。当用户给出视频链接（B站 / YouTube / b23.tv 等）并要求总结、提取信息、"看看这个视频讲了什么"、看教程 / 插件介绍 / 演示类视频时使用。不适用于音频文件转写，也不适用于只要视频元数据（标题、时长、播放量）的场景。
---

# 视频信息提取

把「视频链接 → 可读材料 → 结论」这条流水线跑完。

## 核心事实：agent 看不了视频流

必须降维。工具走两条通道，**两条都要用**：

| 通道 | 拿到什么 | 覆盖 |
|---|---|---|
| 字幕 | `transcript.md`，带时间戳全文 | B站约 60% 视频有 AI 字幕 |
| 关键帧 | `sheets/*.jpg`，每张 12 格拼图 | 100%，且能补字幕的错 |

❗**两条通道是互补关系，不是备选关系**（2026-10-12 实测）：

- AI 字幕**有识别错误**：把 `MoSearch` 听成 `MOSEARCH`、`DSH Neon` 听成 `dh neon`、`DSH University Office` 听成 `Dsa h university office`
- **关键数据常常只在画面上**：某个 DSH 插件榜单视频，字幕里完全没有 `14,329 个在架 / 4,603 个有效下载`、也没有 npm 包名 `dsh-plugin-shopping-catalog`，这些**只出现在画面里**

→ 只看字幕会漏关键数字和专有名词，只看画面会漏口播细节。

## 怎么跑

```powershell
node D:\dsh\config\video-digest\watch-video.mjs "<视频链接>"
```

参数：

| 参数 | 说明 |
|---|---|
| `--frames 60` | 关键帧目标数（默认 60）。2~3 分钟视频用 24~40 足够 |
| `--subs-only` | 只要字幕不下载视频，几秒完成 |
| `--at 1:23,4:56` | 抽指定时间点的**全分辨率**单帧，用来看清画面小字 |
| `--height 480` | 下载画质上限（默认 480p，抽帧够用） |

产出在 `D:\dsh\config\video-digest\out\<BV号>\`：`transcript.md`、`sheets/sheet-NN.jpg`、`meta.json`、`run.log`。

## 拿到产出后怎么做

1. `read` 读 `transcript.md` —— 主体内容
2. 用 `read_image` 逐张看 `sheets/*.jpg` —— **必须看**，用来校正字幕错字、抓画面上的数字 / 包名 / 代码 / 界面
3. 拼图看不清的细节 → 看 `meta.json` 的 `frames` 定位时间点 → `--at <时间点>` 抽全分辨率单帧再看
4. 给结论时区分「口播说的」和「画面写的」；专有名词以**画面**为准

## 硬规则（踩过的坑，别重踩）

- ❗**B站字幕必须登录**才拿得到。cookie 已存在 `video-digest\cookies.txt`，脚本自动使用
- ❗**yt-dlp 拿不到 B站字幕**（它报 `subtitles=[]`）。抽 34 个视频实测：yt-dlp 说 0 个有字幕，直接调 B站 API 实际 20 个有。字幕是本工具自己实现 **wbi 签名直连** `x/player/wbi/v2` 拿的。
  **不要**试图用 `yt-dlp --write-auto-subs` 去解决 B站字幕问题
- ❗B站约 **40% 视频没有 AI 字幕**（本次实测 14/34）。这时只能靠画面硬字幕读，效果明显下降 —— **要主动把这一点告诉用户**，别假装读全了
- ❗**别用官方 `yt-dlp.exe`**：它是 PyInstaller onefile，在 DSH 沙箱里必然报
  `[PYI-xxxxx:ERROR] Failed to create parent directory structure.`。要用 `bin\yt-dlp`（zipapp + anaconda Python）
- ❗脚本里这些看着多余的代码**别删**，都是沙箱逼出来的：
  - 子进程 stdout/stderr 全部写文件句柄（受限令牌下 node 开不了管道）
  - 所有子进程的 `TEMP/TMP` 被改到脚本的 `.tmp\`（沙箱给的 `%TEMP%` 是 `...\Temp\dsh-xxxxxx`，**拒绝访问**）
  - yt-dlp 用 `-P temp:`，且 `--cookies` 指向一份**副本**（yt-dlp 会回写 cookie jar，还会加 CRLF）
- 抽帧完成后视频会自动删除（省空间）。要 `--at` 重抽，重跑一遍即可

## cookie 过期怎么办（约 1 个月一次）

```powershell
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONPATH='D:\dsh\config\video-digest\pylibs'
& D:\anaconda3\python.exe D:\dsh\config\video-digest\bili-login.py
```

**后台跑**（它会等扫码，约 180 秒），出现 `QR_READY` 后把 `out\bili-qr.png` 用 `vision_present` 给用户扫。
成功标志：日志出现 `COOKIE_SAVED`，且 cookie 里有 `SESSDATA`。
二维码 3 分钟过期，用户说看不到或过期就重跑一次。
