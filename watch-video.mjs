#!/usr/bin/env node
/**
 * video-digest —— 把视频降维成 Agent 能读的材料
 * ===============================================
 *
 * 解决的问题：LLM 看不了视频流。可行路径只有三条，本脚本走前两条：
 *   1) 字幕      -> transcript.md   （信息量最大，成本≈0）
 *   2) 关键帧    -> sheets/*.jpg    （拼图总览，供 vision 读；需要细节再 --at 单独抽高清帧）
 *   3) 音频转写  -> 本脚本不做（本机没装 whisper，无字幕视频另行处理）
 *
 * ❗沙箱约束（实测）：
 *   a. 受限令牌下 node 的 child_process **不能开管道**，所以本脚本完全不读子进程 stdout：
 *      yt-dlp 用 --write-info-json / -o 落盘，ffmpeg 直接产出图片，
 *      两者 stdout+stderr 用 fs.openSync 的文件句柄接走，写进 run.log。
 *   b. 沙箱塞给子进程的 %TEMP% 是 `...\Temp\dsh-xxxxxx`，**拒绝访问**
 *      （PyInstaller 单文件 exe 起不来、pip 装不了、yt-dlp 复制 cookie 库失败，全是这个原因）。
 *      所以所有子进程统一改用本脚本的 .tmp/。yt-dlp 另外还要 `-P temp:` 兜底。
 *   c. 官方 yt-dlp.exe 是 PyInstaller onefile，必须先解压到 temp → 在 a/b 两条下必然失败。
 *      改用 zipapp 形态（bin/yt-dlp，纯源码 zip，原地 import）+ anaconda Python。
 *
 * ❗B站字幕必须自己实现（2026-10-12 实测结论）：
 *   - B站不登录拿不到任何字幕；登录后 **yt-dlp 依然拿不到**（报 subtitles=[]/automatic_captions=[]）。
 *     抽 34 个视频验证：yt-dlp 说 0 个有字幕，直接调 B站 API 实际 20 个有 ai-zh 字幕。
 *     所以字幕走 x/player/wbi/v2（wbi 签名）+ aisubtitle.hdslb.com 的 JSON，不走 yt-dlp。
 *   - 没字幕的视频很常见（本次 14/34），此时只能靠画面硬字幕或音频转写。
 *
 * 用法：
 *   node watch-video.mjs <url> [选项]
 *     --out <dir>                 输出根目录，默认 <script>/out
 *     --cookies <file>            默认自动用 <script>/cookies.txt（bili-login.py 生成）
 *     --cookies-from-browser <e>  edge / chrome / firefox
 *     --frames <n>                关键帧目标数，默认 60（0 = 不抽帧）
 *     --height <n>                下载分辨率上限，默认 480
 *     --subs-only                 只下字幕，不下载视频
 *     --at <t1,t2,...>            额外抽这些时间点的全分辨率单帧，支持 90 或 1:30
 *   产出：<out>/<id>/meta.json, transcript.md, sheets/sheet-NN.jpg, frames/, run.log
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---- 找 yt-dlp ----
// ❗用 zipapp 而不是官方 yt-dlp.exe：后者是 PyInstaller onefile，启动时必须先解压到
//   %TEMP%\_MEIxxxx，在受限令牌下必然报 `[PYI-xxxxx:ERROR] Failed to create parent
//   directory structure.`（2026-10-12 实测，改 TEMP 环境变量也救不回来）。
function findPython() {
  for (const p of [process.env.PYTHON_PATH, 'D:\\anaconda3\\python.exe',
    'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe']) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'python';
}
function getYtdlpInvoker() {
  const zipapp = path.join(HERE, 'bin', 'yt-dlp');
  if (fs.existsSync(zipapp)) return { exe: findPython(), prefix: [zipapp], label: `${findPython()} ${zipapp}` };
  const exe = path.join(HERE, 'bin', 'yt-dlp.exe');
  if (fs.existsSync(exe)) return { exe, prefix: [], label: exe };
  return { exe: 'yt-dlp', prefix: [], label: 'yt-dlp (PATH)' };
}
function findFfmpeg() {
  for (const p of ['D:\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}
const INV = getYtdlpInvoker();
const FFMPEG = process.env.FFMPEG_PATH || findFfmpeg();

// ❗所有子进程统一用脚本自己的 .tmp/，理由见文件头 b。
const TMPDIR_LOCAL = path.join(HERE, '.tmp');
fs.mkdirSync(TMPDIR_LOCAL, { recursive: true });

/** 跑外部程序，stdout/stderr 写进 log 文件（不建管道，绕开沙箱限制） */
function run(exe, args, logFile) {
  const fd = fs.openSync(logFile, 'a');
  try {
    const r = spawnSync(exe, args, {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, TEMP: TMPDIR_LOCAL, TMP: TMPDIR_LOCAL, TMPDIR: TMPDIR_LOCAL },
    });
    if (r.error) throw r.error;
    return r.status;
  } finally {
    fs.closeSync(fd);
  }
}
const ytdlp = (args, log) => run(INV.exe, [...INV.prefix, ...args], log);

const mmss = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(ss).padStart(2, '0');
};
const toSec = (t) => {
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const p = t.split(':').map(Number).reverse();
  return (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600;
};

/** 把碎片化的字幕合并成"句"：句末标点收束，或块长超过 12 秒 */
function mergeCues(cues) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) cur = { t: c.t, text: c.text };
    else cur.text += c.text;
    if (/[。！？.!?]$/.test(cur.text) || c.t - cur.t >= 12) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

/** SRT -> [{t,text}]（yt-dlp 字幕 fallback 用） */
function parseSrt(txt) {
  const cues = [];
  for (const block of txt.replace(/\r/g, '').split(/\n\s*\n/)) {
    const m = block.match(/(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})/);
    if (!m) continue;
    const lines = block.split('\n').filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes('-->'));
    if (!lines.length) continue;
    const text = lines.join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) cues.push({ t: toSec(m[1]), text });
  }
  return cues.sort((a, b) => a.t - b.t);
}

// ============ B站字幕：自己实现（yt-dlp 拿不到，见文件头） ============

/** cookies.txt（Netscape）-> {name: value}
 *  ❗必须容忍 CRLF：yt-dlp 回写 cookie jar 时用 Windows 换行，按 \n 切分会让值尾巴带上 \r，
 *    拼进 Cookie header 会被 fetch 判为 invalid header value（2026-10-12 实测踩到）。 */
function parseNetscapeCookies(file) {
  const jar = {};
  if (!file || !fs.existsSync(file)) return jar;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length >= 7) jar[p[5].trim()] = p[6].trim();
  }
  return jar;
}

// wbi 签名的固定重排表（与 B站前端同一张）
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

function wbiQuery(params, imgKey, subKey) {
  const raw = imgKey + subKey;
  const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** 拉 B站字幕：返回 {cues, lang, kind} 或 {cues:null, probe} */
async function fetchBiliSubs(bv, cookieFile) {
  const jar = parseNetscapeCookies(cookieFile);
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (!cookie) return null;
  const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookie };
  const get = async (u) => (await fetch(u, { headers: H })).json();

  const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
  if (view.code !== 0) throw new Error('view 接口失败: ' + view.message);
  const cid = view.data.cid;

  const nav = await get('https://api.bilibili.com/x/web-interface/nav');
  const wi = nav.data.wbi_img;
  const imgKey = wi.img_url.split('/').pop().split('.')[0];
  const subKey = wi.sub_url.split('/').pop().split('.')[0];

  const pj = await get('https://api.bilibili.com/x/player/wbi/v2?' + wbiQuery({ bvid: bv, cid }, imgKey, subKey));
  if (pj.code !== 0) throw new Error('player/wbi/v2 失败: ' + pj.message);
  const subs = ((pj.data || {}).subtitle || {}).subtitles || [];
  if (!subs.length) return { cues: null, probe: 'B站返回字幕列表为空' };

  // 优先中文 AI 字幕，其次人工中文，再退英文
  const pick = subs.find((s) => s.lan === 'ai-zh')
    || subs.find((s) => /^zh/.test(s.lan))
    || subs.find((s) => s.lan === 'ai-en')
    || subs[0];

  const url = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url;
  const body = await (await fetch(url, { headers: H })).json();
  const cues = (body.body || [])
    .map((b) => ({ t: b.from, text: String(b.content || '').trim() }))
    .filter((c) => c.text);
  return { cues, lang: pick.lan, kind: /^ai-/.test(pick.lan) ? 'auto' : 'manual' };
}

function parseArgs(argv) {
  const o = {
    url: null, out: path.join(HERE, 'out'), cookiesFromBrowser: null, cookies: null,
    frames: 60, height: 480, subsOnly: false, at: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') o.out = next();
    else if (a === '--cookies-from-browser') o.cookiesFromBrowser = next();
    else if (a === '--cookies') o.cookies = next();
    else if (a === '--frames') o.frames = parseInt(next(), 10);
    else if (a === '--height') o.height = parseInt(next(), 10);
    else if (a === '--subs-only') o.subsOnly = true;
    else if (a === '--at') o.at = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--')) throw new Error('未知参数: ' + a);
    else if (!o.url) o.url = a;
  }
  if (!o.url) throw new Error('缺少 URL');
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const logAt = (d, msg) => fs.appendFileSync(path.join(d, 'run.log'), `\n[${new Date().toISOString()}] ${msg}\n`);

  const bv = (o.url.match(/(BV[0-9A-Za-z]{10})/) || [])[1];
  const isBili = /bilibili\.com|b23\.tv/i.test(o.url);

  const cookieArgs = [];
  if (o.cookiesFromBrowser) cookieArgs.push('--cookies-from-browser', o.cookiesFromBrowser);
  const autoCookies = path.join(HERE, 'cookies.txt');
  const cookieFile = o.cookies || (fs.existsSync(autoCookies) ? autoCookies : null);
  if (cookieFile) {
    // ❗yt-dlp 用 --cookies 会把 cookie jar **写回原文件**（顺带加自己的注释头和 CRLF）。
    //   所以只给它一份副本，原始 cookies.txt 保持只读，免得被改脏或被清空。
    const ytdlpCookieFile = path.join(TMPDIR_LOCAL, 'yt-dlp-cookies.txt');
    fs.copyFileSync(cookieFile, ytdlpCookieFile);
    cookieArgs.push('--cookies', ytdlpCookieFile);
  }

  const stage = path.join(o.out, bv || '_probe');
  fs.mkdirSync(stage, { recursive: true });
  const log = path.join(stage, 'run.log');
  logAt(stage, `yt-dlp = ${INV.label}\nffmpeg = ${FFMPEG}\ncookies = ${cookieFile}\nurl = ${o.url}`);

  // ---- 1) 元信息（yt-dlp，也是下载视频的前置） ----
  const tmpl = path.join(stage, '%(id)s.%(ext)s');
  const common = ['--no-warnings', '--no-playlist', '--retries', '3', '-P', `temp:${TMPDIR_LOCAL}`, ...cookieArgs];
  console.log('· 拉取视频元信息…');
  let st = ytdlp([...common, '--skip-download', '--write-info-json', '-o', tmpl, o.url], log);
  logAt(stage, `info-json exit=${st}`);

  let infoFile = null;
  for (const f of fs.readdirSync(stage)) if (f.endsWith('.info.json')) infoFile = path.join(stage, f);
  if (!infoFile) {
    console.error('✗ 拿不到 info.json，看 run.log：' + log);
    process.exit(2);
  }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const id = info.id || bv || 'video';

  let dir = stage;
  if (path.basename(stage) !== id) {
    dir = path.join(o.out, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(stage, dir);
  }
  const runLog = path.join(dir, 'run.log');
  // ❗短链（b23.tv）时 bv 匹配不到 → stage 先是 `_probe`，拿到 info.id 后才改名成 `<BV>_p1`。
  //   而 tmpl 是在改名**之前**按 stage 算的，所以视频会落在 `_probe\`，抽帧那步在 dir 里找不到它 →
  //   「sheets/ 无」（2026-10-13 踩到）。下载一律用改名**之后**的 tmpl。
  const tmplFinal = path.join(dir, '%(id)s.%(ext)s');

  const meta = {
    id, title: info.title, uploader: info.uploader || info.channel,
    duration: info.duration, durationText: info.duration ? mmss(info.duration) : null,
    webpage_url: info.webpage_url, upload_date: info.upload_date, view_count: info.view_count,
  };
  console.log(`· ${info.title}  (${meta.durationText || '?'})`);

  // ---- 2) 字幕：B站走自己的实现，其它站走 yt-dlp ----
  let cues = null, subLang = null, subKind = null;
  if (isBili && bv && cookieFile) {
    console.log('· 取 B 站字幕（wbi 直连）…');
    try {
      const r = await fetchBiliSubs(bv, cookieFile);
      if (r && r.cues && r.cues.length) {
        cues = r.cues; subLang = r.lang; subKind = r.kind;
        console.log(`  ✓ ${r.lang} 字幕 ${r.cues.length} 段`);
      } else {
        console.log('  · 该视频没有字幕（B站返回空列表）');
        meta.subtitleProbe = (r && r.probe) || 'no cookies';
      }
    } catch (e) {
      console.log('  ✗ 取字幕失败：' + e.message);
      logAt(dir, 'bili subs error: ' + e.message);
    }
  }

  if (!cues) {
    // yt-dlp 字幕 fallback（对非 B站站点有效；B站基本拿不到，见文件头）
    const prefer = ['zh-Hans', 'zh-CN', 'zh', 'ai-zh', 'zh-Hant', 'en'];
    const manual = info.subtitles || {}, auto = info.automatic_captions || {};
    const lang = prefer.find((l) => manual[l]) || prefer.find((l) => auto[l]);
    if (lang) {
      console.log(`· 尝试 yt-dlp 字幕：${lang}…`);
      st = ytdlp([...common, '--skip-download', '--write-subs', '--write-auto-subs',
        '--sub-langs', lang, '--convert-subs', 'srt', '-o', tmpl, o.url], runLog);
      logAt(dir, `subs exit=${st}`);
      for (const f of fs.readdirSync(dir)) {
        if (/\.srt$/i.test(f) && !/\.orig\./i.test(f)) {
          cues = parseSrt(fs.readFileSync(path.join(dir, f), 'utf8'));
          subLang = lang; subKind = manual[lang] ? 'manual' : 'auto';
        }
      }
    }
  }
  meta.subtitle = cues ? { lang: subLang, kind: subKind } : null;

  // ---- 3) 字幕 -> transcript.md ----
  if (cues && cues.length) {
    const blocks = mergeCues(cues);
    const lines = [
      `# ${meta.title}`, '',
      `- 来源：${meta.webpage_url}`,
      `- UP主：${meta.uploader || '?'}`,
      `- 时长：${meta.durationText || '?'}`,
      `- 字幕：${subLang}（${subKind === 'auto' ? 'AI/自动' : '人工'}），共 ${cues.length} 段`,
      `- 关键帧：${o.frames > 0 ? 'sheets/ 拼图，每格时间点见 meta.json 的 frames' : '未抽帧'}`, '',
      '> 带时间戳的字幕全文。要核对画面用 meta.json 里最近的帧，或跑 --at 抽全分辨率单帧。', '',
      '## 字幕全文', '',
      ...blocks.map((b) => `**[${mmss(b.t)}]** ${b.text}`), '',
    ];
    fs.writeFileSync(path.join(dir, 'transcript.md'), lines.join('\n'), 'utf8');
    meta.transcript = { blocks: blocks.length, cues: cues.length };
    console.log(`· 字幕已整理：transcript.md（${blocks.length} 块）`);
  } else if (!meta.subtitleProbe) {
    console.log('· 没拿到字幕。B站视频需要 cookies.txt（跑 bili-login.py 生成）；非 B站视频见 run.log。');
  }

  // ---- 4) 下载视频（抽帧/--at 才需要） ----
  const wantFrames = o.frames > 0 || o.at.length > 0;
  let videoFile = null;
  if (wantFrames && !o.subsOnly) {
    console.log(`· 下载视频（≤${o.height}p，仅用于抽帧）…`);
    // ❗B站是 DASH-only，没有"整段文件"格式，所以 `/b` 这种兜底一定失败
    //   （2026-10-12 踩到：某个视频只有 1080P60，`bv*[height<=480]` 无匹配 → Requested format is not available）。
    //   兜底必须落到 `bv*+ba`（任意画质的视频流 + 最佳音频流）。
    st = ytdlp([...common, '-f', `bv*[height<=${o.height}]+ba/bv*+ba/b`,
      '--merge-output-format', 'mp4', '-o', tmplFinal, o.url], runLog);
    logAt(dir, `video exit=${st}`);
    let best = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp4|mkv|webm|flv)$/i.test(f)) continue;
      const sz = fs.statSync(path.join(dir, f)).size;
      if (sz > best) { best = sz; videoFile = path.join(dir, f); }
    }
  }

  // ---- 5) 抽关键帧拼图 ----
  meta.frames = [];
  if (videoFile && o.frames > 0 && info.duration > 4) {
    const D = info.duration;
    const N = Math.min(o.frames, Math.max(4, Math.floor(D / 2)));
    const interval = D / N;
    const COLS = 4, ROWS = 3, PER = COLS * ROWS;
    const pages = Math.ceil(N / PER);
    const sheetDir = path.join(dir, 'sheets');
    fs.mkdirSync(sheetDir, { recursive: true });
    console.log(`· 抽帧：约每 ${interval.toFixed(1)}s 一帧，${N} 帧 → ${pages} 张拼图`);
    const vf = `fps=${(1 / interval).toFixed(6)},scale=400:-2,tile=${COLS}x${ROWS}:padding=4:color=white`;
    st = run(FFMPEG, ['-y', '-i', videoFile, '-vf', vf, '-frames:v', String(pages),
      '-q:v', '3', path.join(sheetDir, 'sheet-%02d.jpg')], runLog);
    logAt(dir, `sheets exit=${st}`);
    for (let i = 0; i < N; i++) {
      meta.frames.push({
        n: i, t: +(i * interval).toFixed(1), tText: mmss(i * interval),
        sheet: `sheets/sheet-${String(Math.floor(i / PER) + 1).padStart(2, '0')}.jpg`,
        cell: `${Math.floor((i % PER) / COLS) + 1}行${(i % COLS) + 1}列`,
      });
    }
  }

  // ---- 6) --at：抽指定时间点的全分辨率单帧 ----
  meta.stills = [];
  if (videoFile && o.at.length) {
    const stillDir = path.join(dir, 'frames');
    fs.mkdirSync(stillDir, { recursive: true });
    for (const t of o.at) {
      const sec = toSec(t);
      const name = `at-${mmss(sec).replace(/:/g, 'm')}s.jpg`;
      const out = path.join(stillDir, name);
      run(FFMPEG, ['-y', '-ss', String(sec), '-i', videoFile, '-frames:v', '1', '-q:v', '2', out], runLog);
      if (fs.existsSync(out)) meta.stills.push({ t: sec, file: `frames/${name}` });
    }
    if (meta.stills.length) console.log(`· 单帧已抽：${meta.stills.length} 张 → frames/`);
  }

  // ---- 7) 收尾：抽帧用完就删视频省空间（要 --at 重抽则保留） ----
  if (videoFile) {
    const mb = fs.statSync(videoFile).size / 1048576;
    if (o.frames > 0 && o.at.length === 0) {
      fs.rmSync(videoFile, { force: true });
      meta.video = `已删除（${mb.toFixed(0)} MB，抽帧用完即删；要重抽重跑即可）`;
    } else {
      meta.video = `${path.basename(videoFile)}（${mb.toFixed(0)} MB，保留以便 --at 重抽）`;
    }
  }

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log('\n✓ 完成：' + dir);
  console.log('  · transcript.md  ' + (cues ? '有' : '无'));
  console.log('  · sheets/        ' + (meta.frames.length ? meta.frames.length + ' 帧拼图' : '无'));
  console.log('  · run.log        排错用');
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
