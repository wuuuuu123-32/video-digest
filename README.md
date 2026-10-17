# video-digest

让 AI agent「看」视频。把视频降维成 agent 能读的材料：**字幕全文 + 关键帧拼图**，然后由 agent 读文字、看图来提取视频信息。

专门解决了 B站的两个坑：**不登录拿不到任何字幕**、**yt-dlp 拿不到 B站字幕**（它报 `subtitles=[]`，实际有）。

## 它怎么工作

LLM 读不了视频流，只能降维。本工具走两条通道，**两条是互补关系**：

| 通道 | 产出 | 覆盖 |
|---|---|---|
| 字幕 | `transcript.md`，带时间戳全文 | B站约 60% 视频有 AI 字幕 |
| 关键帧 | `sheets/*.jpg`，每张 12 格拼图 | 100%，且能补字幕的错 |

实测的例子：某个 DSH 插件榜单视频，AI 字幕把 `dsh-univer-office` 听成 `Dsa h university office`，
而且字幕里**完全没有**画面上的 `14,329 个在架 / 4,603 个有效下载` 和 npm 包名。
只看字幕会漏关键数字和专有名词。

## 安装

需要 Node.js 和 Python（本仓库在 Windows + anaconda 上开发）。

```powershell
# 1) yt-dlp 用 zipapp 形态（不要用官方 yt-dlp.exe，见下方「为什么」）
#    下载到 bin/yt-dlp（无扩展名）
#    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp

# 2) 扫码登录依赖（只在首次登录时需要），见下方「首次扫码登录」
```

脚本会自动在 `D:\anaconda3\python.exe` 等常见位置找 Python；找不到时用环境变量 `PYTHON_PATH` 指定。

## 用法

### 首次扫码登录

扫码登录需要额外安装 `requests` 和 `qrcode`（含 Pillow 图片支持）。它们只用于扫码并生成登录二维码；运行视频处理流程本身不需要这些包。请在仓库根目录按平台执行：

**Windows (PowerShell)**

```powershell
python -m pip install --target .\pylibs "qrcode[pil]" requests
$env:PYTHONPATH = "$PWD\pylibs"
python bili-login.py
```

**macOS / Linux**

```sh
python3 -m pip install --target ./pylibs 'qrcode[pil]' requests
PYTHONPATH="$PWD/pylibs" python3 bili-login.py
```

首次运行会生成 `out/bili-qr.png`，用手机 B站 App 扫码。之后 cookie 过期需要重新登录时，设置好 `PYTHONPATH` 后再次运行 `python bili-login.py`（macOS/Linux 使用 `python3`）。

### 处理视频

```sh
node watch-video.mjs "https://www.bilibili.com/video/BVxxxxxxxxxx"
```

参数：

| 参数 | 说明 |
|---|---|
| `--frames 60` | 关键帧目标数（默认 60） |
| `--subs-only` | 只要字幕不下载视频，几秒完成 |
| `--at 1:23,4:56` | 抽指定时间点的**全分辨率**单帧，用来看清画面小字 |
| `--height 480` | 下载画质上限（默认 480p，抽帧够用） |

产出在 `out/<BV号>/`：`transcript.md`、`sheets/sheet-NN.jpg`、`meta.json`、`run.log`。

## 已知限制

- B站约 **40% 的视频没有 AI 字幕**，这时只能靠画面硬字幕读，效果明显下降
- cookie 约 1 个月过期，重跑 `bili-login.py` 即可
- 「B站字幕」这条链是自己实现 **wbi 签名**直连 `x/player/wbi/v2` 的，B站改接口就会断

## 为什么用 zipapp 而不是官方 yt-dlp.exe

官方 `yt-dlp.exe` 是 PyInstaller onefile，启动时必须先解压到 `%TEMP%\_MEIxxxx`。
在受限令牌环境（如 DSH 沙箱）下会直接报：

```
[PYI-xxxxx:ERROR] Failed to create parent directory structure.
```

改 `TEMP` 环境变量也救不回来。zipapp 形态只需要一个 Python 解释器，全程不碰 temp。

## 为什么 yt-dlp 拿不到 B站字幕却不用它

抽 34 个视频实测：`yt-dlp --write-auto-subs` 说 **0 个**有字幕，
直接调 B站 API 实际 **20 个**有 `ai-zh` 字幕。所以字幕这一环没有走 yt-dlp。

## 作为 agent skill 使用

`SKILL.md` 是给 agent 读的技能定义（Claude Code / DSH 等支持 skill 的环境可直接挂载）。
把本目录软链到你的 skills 目录即可：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\skills\video-digest" -Target "<本仓库路径>"
```
