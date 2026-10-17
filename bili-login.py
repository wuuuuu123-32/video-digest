# -*- coding: utf-8 -*-
"""
B 站扫码登录 → cookies.txt
==========================
用途：B 站现在不登录就拿不到任何字幕（含 CC / AI 字幕，2026-10 实测三条视频全为空），
      所以给 video-digest 准备一份登录 cookie。扫码一次，之后自动复用。

产出：
  cookies.txt               —— Netscape 格式，给 yt-dlp --cookies 用
  bili-refresh-token.txt    —— 备用，以后 cookie 过期可尝试刷新而不用重扫码
  out/bili-qr.png           —— 二维码，手机 B 站 App 扫

运行（需要 qrcode 包，装在 pylibs/）：
  PYTHONPATH=.../video-digest/pylibs  python bili-login.py
"""
import os
import sys
import time

try:
    import requests
except ImportError:
    print('Missing package: requests')
    print('Install with: python -m pip install --target pylibs requests')
    sys.exit(4)

try:
    import qrcode
except ImportError:
    print('Missing package: qrcode[pil]')
    print('Install with: python -m pip install --target pylibs "qrcode[pil]"')
    sys.exit(4)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
COOKIE_FILE = os.path.join(HERE, 'cookies.txt')
TOKEN_FILE = os.path.join(HERE, 'bili-refresh-token.txt')
QR_PNG = os.path.join(OUT, 'bili-qr.png')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

S = requests.Session()
S.headers.update({'User-Agent': UA, 'Referer': 'https://www.bilibili.com/'})

STATUS = {0: '登录成功', 86038: '二维码已过期', 86090: '已扫码，等待你在手机上确认', 86101: '等待扫码'}


def main():
    os.makedirs(OUT, exist_ok=True)

    r = S.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', timeout=20)
    j = r.json()
    if j.get('code') != 0:
        print('生成二维码失败:', j)
        return 1

    url = j['data']['url']
    key = j['data']['qrcode_key']

    img = qrcode.make(url)
    img.save(QR_PNG)
    print('QR_READY ' + QR_PNG, flush=True)

    deadline = time.time() + 180
    last = None
    while time.time() < deadline:
        time.sleep(2)
        try:
            p = S.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
                      params={'qrcode_key': key}, timeout=20).json()
        except Exception as e:  # 网络抖动不算失败，继续轮询
            print('poll 异常:', e, flush=True)
            continue

        d = p.get('data') or {}
        code = d.get('code')
        msg = STATUS.get(code, 'code=%s' % code)
        if msg != last:
            print('[%s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)
            last = msg

        if code == 0:
            rows = ['# Netscape HTTP Cookie File', '# 由 bili-login.py 生成', '']
            names = []
            for c in S.cookies:
                dom = c.domain or ''
                if 'bilibili' not in dom and 'biligame' not in dom:
                    continue
                # domain 以 . 开头才允许子域，Netscape 格式第二列必须是 TRUE/FALSE
                rows.append('\t'.join([
                    dom,
                    'TRUE' if dom.startswith('.') else 'FALSE',
                    c.path or '/',
                    'FALSE',
                    str(int(c.expires)) if c.expires else '0',
                    c.name,
                    c.value or '',
                ]))
                names.append(c.name)

            with open(COOKIE_FILE, 'w', encoding='utf-8') as f:
                f.write('\n'.join(rows) + '\n')

            if d.get('refresh_token'):
                with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
                    f.write(d['refresh_token'])

            print('COOKIE_SAVED ' + COOKIE_FILE, flush=True)
            print('收到 cookie: ' + ', '.join(names), flush=True)
            if 'SESSDATA' not in names:
                print('⚠ 没有 SESSDATA，登录可能没真正完成', flush=True)
            return 0

        if code == 86038:
            print('二维码过期了，重跑一次即可', flush=True)
            return 2

    print('超时（180 秒内没扫），重跑一次即可', flush=True)
    return 3


if __name__ == '__main__':
    sys.exit(main())
