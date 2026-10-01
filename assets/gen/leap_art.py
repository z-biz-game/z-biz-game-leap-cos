#!/usr/bin/env python3
"""跳蛙渡 Leap — 视觉母题与全部位图资产的可复现生成器。

母题由玩法决定，不凭感觉画：一条河 = 一排莲叶 + 恰好一片空位，蛙只能朝前一步、
或越过恰好一只对岸的蛙。所以图标里画的就是这条规则本身——绿蛙（左岸，朝右）正从
1 号叶跃起，越过 2 号叶上的琥珀蛙（右岸，朝左），虚线弧落到它唯一能落的 3 号空位。

配色不编，逐条取自本仓实测值：
  水 #0f1d24 / #08121a                        （css/game.css :root --water/--water-deep）
  左岸蛙 #63c76a，右岸蛙 #e0a54a               （js/view.js drawFrog 的 body 分支）
  莲叶 #264a30 + 叶缘 #78be8c                  （js/view.js drawPads）
  两岸 #2f4a2a→#1d2f1c / #3a3325→#241f16      （js/view.js drawBanks）
  未来弧 rgba(150,230,255)                     （js/view.js drawFrog 的虚线弧）

≤64px 另出一版"简化母题"：一只蛙 + 一片叶 + 空位环 + 一弧。五只蛙压到 32px 会糊成
噪点，favicon 要的是轮廓。

重跑：python3 assets/gen/leap_art.py        （幂等；单一 LCG 种子，同输入同字节）
"""
import os
import json
import math
import hashlib

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '..'))
SUPER = 4            # 母图按 4 倍边长绘制再 LANCZOS 下采样，抗锯齿全靠它
SEED = 0x1EAF        # 'LEAP'

PAL = {
    'water': (15, 29, 36),
    'water_deep': (8, 18, 26),
    'water_mid': (22, 45, 55),
    'ink': (230, 236, 243),
    'leap': (99, 199, 106),
    'hop': (224, 165, 74),
    'good': (127, 224, 160),
    'pad': (38, 74, 48),
    'pad_rim': (120, 190, 140),
    'bank_l': (47, 74, 42),
    'bank_l_deep': (29, 47, 28),
    'bank_r': (58, 51, 37),
    'bank_r_deep': (36, 31, 22),
    'reed_l': (150, 200, 130),
    'reed_r': (200, 180, 120),
    'arc': (150, 230, 255),
}

CJK_FONTS = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
]
LATIN_FONTS = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]


class Lcg:
    """确定性随机（与 js/core/rng.js 同族），只驱动水纹噪声与芦苇抖动。"""

    def __init__(self, seed=SEED):
        self.s = seed & 0x7FFFFFFF

    def next(self):
        self.s = (1103515245 * self.s + 12345) & 0x7FFFFFFF
        return self.s / 0x7FFFFFFF

    def span(self, a, b):
        return a + self.next() * (b - a)


def rgba(c, a=255):
    return (c[0], c[1], c[2], a)


def mix(c1, c2, t):
    return tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def vgrad(d, w, h, top, bottom):
    for y in range(h):
        d.line([(0, y), (w, y)], fill=rgba(mix(top, bottom, y / max(1, h - 1))))


def plate(s, radius_ratio=0.226, full=False):
    """水色渐变的方圆角底版（full=True 铺满，maskable 图标不允许有透明边）。"""
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    mask = Image.new('L', (s, s), 0)
    box = (0, 0, s - 1, s - 1) if full else (int(s * 0.03), int(s * 0.03), int(s * 0.97), int(s * 0.97))
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=int(s * radius_ratio), fill=255)
    fill = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    vgrad(ImageDraw.Draw(fill), s, s, PAL['water'], PAL['water_deep'])
    return Image.composite(fill, img, mask), box


def ripples(d, s, y, x0, x1, count, amp, color, width, seed):
    """水面纹：每条带一个稳定相位、整数周期 ⇒ 两端同高，tile 得起来，也不是噪声。"""
    rng = Lcg(seed)
    for i in range(count):
        period = max(1.0, (x1 - x0) / (1.5 + i * 0.5))
        phase = rng.next() * 2 * math.pi
        yy = y + int((i - count / 2) * s * 0.038)
        a = amp * (1 - i * 0.14)
        step = max(1, int(s * 0.004))
        pts = [(x, yy + a * math.sin((x - x0) / period * 2 * math.pi + phase))
               for x in range(int(x0), int(x1), step)]
        d.line(pts, fill=color, width=max(1, width), joint='curve')


def lily_pad(d, cx, cy, r, notch=True):
    rx, ry = r * 1.24, r * 0.62
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=rgba(PAL['pad'], 236))
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), outline=rgba(PAL['pad_rim'], 96),
              width=max(1, int(r * 0.08)))
    if notch and r > 12:
        d.pieslice((cx - rx, cy - ry, cx + rx, cy + ry), -118, -62, fill=rgba(PAL['water_deep'], 215))
        for k in range(3):
            ang = 2.2 - 0.9 + k * 0.52
            d.line([(cx, cy), (cx + rx * 0.88 * math.cos(ang), cy + ry * 0.88 * math.sin(ang))],
                   fill=rgba(mix(PAL['pad'], PAL['pad_rim'], 0.35), 120), width=max(1, int(r * 0.05)))


def gap_ring(d, cx, cy, r):
    """空位不是叶子，是一圈被搅动的水面：js/view.js 画的就是双环。"""
    for i in range(2):
        d.ellipse((cx - r * (0.72 + i * 0.34), cy - r * (0.36 + i * 0.18),
                   cx + r * (0.72 + i * 0.34), cy + r * (0.36 + i * 0.18)),
                  outline=rgba(PAL['arc'], 150 - i * 40), width=max(1, int(r * 0.11)))


def frog(d, cx, cy, r, facing, body, belly):
    """腿 → 身 → 腹 → 眼：眼睛偏向行进方向，"谁能往哪跳"在位图里也是读得出来的。"""
    lw = max(2, int(r * 0.22))
    for side in (-1, 1):
        d.line([(cx + facing * r * 0.10, cy + side * r * 0.15),
                (cx - facing * r * 0.72, cy + side * r * 0.62),
                (cx - facing * r * 0.30, cy + side * r * 0.80)],
               fill=rgba(mix(body, (10, 20, 14), 0.35)), width=lw, joint='curve')
    d.ellipse((cx - r * 0.92, cy - r * 0.72, cx + r * 0.92, cy + r * 0.72),
              fill=rgba(body), outline=rgba(mix(body, (8, 16, 10), 0.55), 210),
              width=max(1, int(r * 0.06)))
    bx = cx - facing * r * 0.16
    d.ellipse((bx - r * 0.5, cy + r * 0.2 - r * 0.3, bx + r * 0.5, cy + r * 0.2 + r * 0.3),
              fill=rgba(mix(body, belly, 0.6), 150))
    for side in (-1, 1):
        ey = cy - side * r * 0.42 - r * 0.10
        ex = cx + facing * r * 0.5
        d.ellipse((ex - r * 0.26, ey - r * 0.26, ex + r * 0.26, ey + r * 0.26), fill=rgba(PAL['ink']))
        px = cx + facing * r * 0.60
        d.ellipse((px - r * 0.12, ey - r * 0.12, px + r * 0.12, ey + r * 0.12), fill=(22, 26, 20, 255))


def bank(d, x0, x1, y0, y1, side, s):
    if x1 - x0 <= 4:
        return
    top, deep = (PAL['bank_l'], PAL['bank_l_deep']) if side == 'left' else (PAL['bank_r'], PAL['bank_r_deep'])
    reed = PAL['reed_l'] if side == 'left' else PAL['reed_r']
    d.rounded_rectangle((x0, y0, x1, y1), radius=int((x1 - x0) * 0.24), fill=rgba(top, 250))
    d.rounded_rectangle((x0, (y0 + y1) / 2, x1, y1), radius=int((x1 - x0) * 0.24), fill=rgba(deep, 210))
    rng = Lcg(SEED + (17 if side == 'left' else 29))
    n = 3
    h = y1 - y0
    for i in range(n):
        rx = x0 + (x1 - x0) * (i + 0.7) / (n + 0.4)
        hgt = h * (0.34 + 0.14 * rng.next())
        d.line([(rx, y0 + h * 0.78), (rx + s * 0.014, y0 + h * 0.78 - hgt * 0.6),
                (rx + s * 0.006, y0 + h * 0.78 - hgt)],
               fill=rgba(reed, 145), width=max(1, int(s * 0.008)), joint='curve')


def dashed_arc(d, p0, p1, apex, color, width, dash):
    steps = 200
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1 - t
        pts.append((mt * mt * p0[0] + 2 * mt * t * apex[0] + t * t * p1[0],
                    mt * mt * p0[1] + 2 * mt * t * apex[1] + t * t * p1[1]))
    acc, seg, on = 0.0, [pts[0]], True
    for a, b in zip(pts, pts[1:]):
        acc += math.hypot(b[0] - a[0], b[1] - a[1])
        seg.append(b)
        if acc >= (dash if on else dash * 0.75):
            acc = 0.0
            if on and len(seg) > 1:
                d.line(seg, fill=color, width=width, joint='curve')
            seg = [b]
            on = not on
    if on and len(seg) > 1:
        d.line(seg, fill=color, width=width, joint='curve')


def badge(size_px, detail='full', full_bleed=False, seed=SEED):
    s = size_px * SUPER
    img, box = plate(s, full=full_bleed)
    overlay = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    x0, y0, x1, y1 = box

    # 河带占满板子的中下部：上沿留给芦苇与跃起的弧线，不留一块空板
    band_y0, band_y1 = int(y0 + (y1 - y0) * 0.26), int(y0 + (y1 - y0) * 0.86)
    water = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    vgrad(ImageDraw.Draw(water), s, s, PAL['water_mid'], PAL['water'])
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((x0 + s * 0.035, band_y0, x1 - s * 0.035, band_y1),
                                           radius=int(s * 0.10), fill=255)
    overlay = Image.composite(water, overlay, mask)
    d = ImageDraw.Draw(overlay)
    water_y = int(y0 + (y1 - y0) * 0.66)
    ripples(d, s, water_y - int(s * 0.13), x0 + s * 0.06, x1 - s * 0.06, 3, s * 0.011,
            rgba(PAL['ink'], 20), int(s * 0.005), seed + 3)
    ripples(d, s, water_y + int(s * 0.10), x0 + s * 0.06, x1 - s * 0.06, 2, s * 0.009,
            rgba(PAL['arc'], 14), int(s * 0.004), seed + 11)

    pads = 5 if detail == 'full' else 1
    pitch = s * 0.132 if detail == 'full' else s * 0.30
    cx0 = (s - pitch * (pads - 1)) / 2
    r = s * 0.060 if detail == 'full' else s * 0.112
    gap = 3 if detail == 'full' else 0
    hop_r = r * 0.95
    lift = hop_r * 1.75

    left_end = cx0 - pitch * 0.80
    right_start = cx0 + pitch * (pads - 1) + pitch * 0.80
    if detail == 'full':
        bank(d, x0 + s * 0.045, left_end, band_y0 + s * 0.03, band_y1 - s * 0.05, 'left', s)
        bank(d, right_start, x1 - s * 0.045, band_y0 + s * 0.03, band_y1 - s * 0.05, 'right', s)

    for p in range(pads):
        cx, cy = cx0 + p * pitch, water_y
        if p == gap:
            gap_ring(d, cx, cy, r)
        else:
            lily_pad(d, cx, cy, r, notch=detail == 'full')

    if detail == 'full':
        # 起跳的那一只抬到半空并带一片投影：弧线把"跳过恰好一只"这件事讲清楚
        d.ellipse((cx0 + 1 * pitch - hop_r * 0.8, water_y - hop_r * 0.5,
                   cx0 + 1 * pitch + hop_r * 0.8, water_y + hop_r * 0.5),
                  fill=(0, 0, 0, 60))
        frog(d, cx0 + 0 * pitch, water_y - hop_r * 0.12, hop_r, 1, PAL['leap'], (200, 255, 205))
        frog(d, cx0 + 2 * pitch, water_y - hop_r * 0.16, hop_r, -1, PAL['hop'], (255, 232, 190))
        frog(d, cx0 + 4 * pitch, water_y - hop_r * 0.12, hop_r, -1, PAL['hop'], (255, 232, 190))
        frog(d, cx0 + 1 * pitch, water_y - lift, hop_r, 1, PAL['leap'], (200, 255, 205))
        dashed_arc(d, (cx0 + 1 * pitch, water_y - lift),
                   (cx0 + 3 * pitch, water_y - hop_r * 0.16),
                   (cx0 + 2 * pitch, water_y - lift - hop_r * 1.5),
                   rgba(PAL['arc'], 150), max(2, int(s * 0.009)), s * 0.022)
    else:
        frog(d, cx0, water_y - hop_r * 0.55, hop_r * 1.05, 1, PAL['leap'], (200, 255, 205))
        dashed_arc(d, (cx0, water_y - hop_r * 0.55), (cx0 + s * 0.285, water_y - hop_r * 0.1),
                   (cx0 + s * 0.14, water_y - hop_r * 3.0), rgba(PAL['arc'], 140),
                   max(2, int(s * 0.011)), s * 0.028)
        gap_ring(d, cx0 + s * 0.285, water_y, r * 0.95)

    if not full_bleed:
        # 只留一圈内描边：早先那三条斜向"高光带"在 1024 上看像刮痕，已删
        d.rounded_rectangle(box, radius=int(s * 0.22), outline=rgba(PAL['ink'], 30),
                            width=max(1, int(s * 0.007)))
    return Image.alpha_composite(img, overlay).resize((size_px, size_px), Image.LANCZOS)


def tileable_water(size_px):
    s = size_px * 2
    img = Image.new('RGBA', (s, s), rgba(PAL['water_deep']))
    d = ImageDraw.Draw(img)
    for y in range(s):
        base = mix(PAL['water'], PAL['water_deep'], abs(math.sin(y / s * math.pi)) * 0.65 + 0.15)
        d.line([(0, y), (s, y)], fill=rgba(base))
    rng = Lcg(SEED + 71)
    for i in range(9):
        y = int(rng.span(0, s))
        cyc = 1 + (i % 3)
        pts = [(x, y + s * 0.012 * math.sin(x / s * 2 * math.pi * cyc + i)) for x in range(0, s, 6)]
        d.line(pts, fill=rgba(PAL['ink'], 16 + (i % 3) * 5), width=max(1, s // 200), joint='curve')
    for _ in range(int(s * s / 900)):
        d.point((int(rng.span(0, s)), int(rng.span(0, s))),
                fill=rgba(PAL['arc'], int(rng.span(8, 26))))
    return img.resize((size_px, size_px), Image.LANCZOS)


def pad_sprite(size_px):
    s = size_px * SUPER
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    lily_pad(ImageDraw.Draw(img), s / 2, s / 2, s * 0.40, notch=True)
    return img.resize((size_px, size_px), Image.LANCZOS)


def ring_sprite(size_px, color, radius_ratio=0.42, softness=0.24):
    """扁环 sprite：水面涟漪（提示环）与水花（落地）共用一张，只是色相与倾角不同。"""
    s = size_px * SUPER
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = s / 2
    n = max(8, int(s * 0.05))
    for i in range(n):
        t = i / (n - 1)
        rad = c * (0.34 + 0.60 * t)
        a = int(255 * math.exp(-((t - (1 - softness)) ** 2) / 0.03))
        d.ellipse((c - rad, c - rad * radius_ratio, c + rad, c + rad * radius_ratio),
                  outline=rgba(color, min(255, a)), width=max(1, s // 80))
    return img.resize((size_px, size_px), Image.LANCZOS)


def bank_texture(w, h):
    s = 2
    img = Image.new('RGBA', (w * s, h * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    vgrad(d, w * s, h * s, PAL['bank_l'], PAL['bank_l_deep'])
    rng = Lcg(SEED + 131)
    for _ in range(int(w * h / 22)):
        x, y = int(rng.span(0, w * s)), int(rng.span(0, h * s))
        ln = int(rng.span(2, 10))
        d.line([(x, y), (x + ln, y - ln * 0.6)], fill=rgba(PAL['reed_l'], 42), width=2)
    return img.resize((w, h), Image.LANCZOS)


def pick_font(px, candidates, used):
    from PIL import ImageFont
    for p in candidates:
        if os.path.exists(p):
            try:
                f = ImageFont.truetype(p, px)
                used.append(os.path.basename(p))
                return f
            except Exception:
                continue
    used.append('PIL default')
    return ImageFont.load_default()


def og_card(w=1200, h=630):
    s = 2
    img = Image.new('RGBA', (w * s, h * s), rgba(PAL['water_deep']))
    d = ImageDraw.Draw(img)
    vgrad(d, w * s, h * s, mix(PAL['water'], (255, 255, 255), 0.05), PAL['water_deep'])
    # 水纹只走下方一条带，不越过文字基线
    ripples(d, w * s, int(h * s * 0.90), 0, w * s, 3, h * s * 0.016,
            rgba(PAL['ink'], 9), int(h * s * 0.003), SEED + 17)
    art = badge(int(h * 0.78), detail='full', seed=SEED + 5)
    img.alpha_composite(art, (int(w * s * 0.045), int((h * s - art.height) / 2)))

    used = []
    tx = int(w * s * 0.455)
    right = int(w * s * 0.945)

    def line(text, base_px, candidates, y, fill, min_px=14):
        px = base_px
        f = pick_font(px, candidates, used)
        while px > min_px and d.textlength(text, font=f) > right - tx:
            px = int(px * 0.92)
            f = pick_font(px, candidates, used)
        d.text((tx, y), text, font=f, fill=fill)
        return px

    ty = int(h * s * 0.16)
    ty += line('LEAP', int(h * s * 0.17), LATIN_FONTS, ty, rgba(PAL['ink'])) * 1.06
    ty += line('跳蛙渡', int(h * s * 0.115), CJK_FONTS, ty, rgba(PAL['leap'])) * 1.15
    d.line([(tx, ty), (right, ty)], fill=rgba(PAL['hop'], 180), width=max(2, 3 * s))
    ty += int(h * s * 0.055)
    ty += line('最短步数是量出来的', int(h * s * 0.10), CJK_FONTS, ty, rgba(PAL['ink'], 235)) * 1.25
    ty += line('BFS 穷尽整条河 × 闭式 n(n+2) × 记忆化 DFS', int(h * s * 0.055), CJK_FONTS,
               ty, rgba(PAL['ink'], 180)) * 1.35
    line('一条河 2n+1 片莲叶，两岸的蛙互换位置', int(h * s * 0.055), CJK_FONTS,
         ty, rgba(PAL['arc'], 175))
    return img.resize((w, h), Image.LANCZOS), used


def write(img, rel):
    path = os.path.join(ASSETS, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    return path


def main():
    master = badge(1024, detail='full')
    simple = badge(96, detail='full', seed=SEED + 2)
    small = badge(128, detail='simple')
    written = [write(master, 'icons/master-1024.png')]

    for size in (512, 256, 192, 96, 64, 48, 32, 16):
        src = master if size >= 192 else (simple if size >= 64 else small)
        written.append(write(src.resize((size, size), Image.LANCZOS), f'icons/icon-{size}.png'))
    # favicon 走真位图：192 版供 apple/PWA 与高分屏，32/48 版供浏览器标签页
    written.append(write(master.resize((192, 192), Image.LANCZOS), 'icons/favicon.png'))
    written.append(write(small.resize((48, 48), Image.LANCZOS), 'icons/favicon-48.png'))
    written.append(write(small.resize((32, 32), Image.LANCZOS), 'icons/favicon-32.png'))

    opaque = Image.new('RGB', (180, 180), PAL['water_deep'])
    src = master.resize((180, 180), Image.LANCZOS)
    opaque.paste(src, (0, 0), src)          # iOS 不给透明区做圆角，透明会露黑底
    written.append(write(opaque, 'icons/apple-touch-icon.png'))
    written.append(write(badge(512, detail='full', full_bleed=True), 'icons/icon-512-maskable.png'))
    written.append(write(badge(192, detail='full', full_bleed=True), 'icons/icon-192-maskable.png'))

    written.append(write(tileable_water(512), 'game/water.png'))
    written.append(write(pad_sprite(256), 'game/pad.png'))
    written.append(write(ring_sprite(128, PAL['arc']), 'game/ripple.png'))
    written.append(write(ring_sprite(128, PAL['good'], radius_ratio=0.30, softness=0.5), 'game/splash.png'))
    written.append(write(bank_texture(256, 128), 'game/bank.png'))

    card, fonts = og_card(1200, 630)
    written.append(write(card, 'og/leap-og-1200x630.png'))

    files = []
    for p in written:
        im = Image.open(p)
        with open(p, 'rb') as f:
            dig = hashlib.sha256(f.read()).hexdigest()[:12]
        files.append({'path': os.path.relpath(p, ASSETS).replace(os.sep, '/'), 'w': im.size[0],
                      'h': im.size[1], 'mode': im.mode, 'bytes': os.path.getsize(p), 'sha256': dig})
    man = {
        'generator': 'assets/gen/leap_art.py', 'seed': SEED, 'supersample': SUPER,
        'palette': {k: '#%02x%02x%02x' % v for k, v in PAL.items()},
        'fonts': sorted(set(fonts)), 'files': files,
    }
    with open(os.path.join(ASSETS, 'art-manifest.json'), 'w') as f:
        json.dump(man, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')
    for row in files:
        print(f"{row['path']:34s} {row['w']:5d}x{row['h']:<5d} {row['bytes']:8d}B {row['mode']:5s} {row['sha256']}")
    print(f"png={len(files)} bytes={sum(r['bytes'] for r in files)} fonts={sorted(set(fonts))}")


if __name__ == '__main__':
    main()
