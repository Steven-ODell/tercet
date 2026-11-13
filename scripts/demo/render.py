# Renders tmux `capture-pane -e` dumps to PNG frames and an animated GIF.
#   python render.py FRAMES_DIR DURATIONS OUT.gif [--png-dir DIR]
import os, sys, pathlib, pyte
from PIL import Image, ImageDraw, ImageFont

frames_dir, durations_file, out = sys.argv[1:4]
png_dir = pathlib.Path(sys.argv[sys.argv.index("--png-dir") + 1]) if "--png-dir" in sys.argv else None
COLS, ROWS = 120, 38
SIZE = 15
# DEMO_FONT and DEMO_FONT_BOLD pick other TTF files; the committed GIF used JetBrains Mono Nerd Font.
reg = ImageFont.truetype(os.environ.get("DEMO_FONT", "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf"), SIZE)
bold = ImageFont.truetype(os.environ.get("DEMO_FONT_BOLD", "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Bold.ttf"), SIZE)
asc, desc = reg.getmetrics()
CW, CH = round(reg.getlength("M")), asc + desc
BG, FG = (22, 24, 26), (255, 255, 255)
NAMED = {"black": (22, 24, 26), "red": (255, 110, 94), "green": (94, 255, 108), "brown": (241, 255, 94),
         "yellow": (241, 255, 94), "blue": (189, 94, 255), "magenta": (255, 94, 241), "cyan": (94, 241, 255),
         "white": (255, 255, 255), "brightblack": (125, 125, 125)}

def color(value, default):
    if value == "default":
        return default
    if value in NAMED:
        return NAMED[value]
    try:
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return default

# Quadrants for U+2596..U+259F as (top-left, top-right, bottom-left, bottom-right).
QUAD = {0x2596: (0, 0, 1, 0), 0x2597: (0, 0, 0, 1), 0x2598: (1, 0, 0, 0), 0x2599: (1, 0, 1, 1),
        0x259A: (1, 0, 0, 1), 0x259B: (1, 1, 1, 0), 0x259C: (1, 1, 0, 1), 0x259D: (0, 1, 0, 0),
        0x259E: (0, 1, 1, 0), 0x259F: (0, 1, 1, 1)}

def block(draw, ch, x, y, fg):
    o = ord(ch)
    h2, w2 = CH // 2, CW // 2
    if o == 0x2580: draw.rectangle([x, y, x + CW - 1, y + h2 - 1], fill=fg); return True
    if o == 0x2584: draw.rectangle([x, y + h2, x + CW - 1, y + CH - 1], fill=fg); return True
    if o == 0x2588: draw.rectangle([x, y, x + CW - 1, y + CH - 1], fill=fg); return True
    if o == 0x258C: draw.rectangle([x, y, x + w2 - 1, y + CH - 1], fill=fg); return True
    if o == 0x2590: draw.rectangle([x + w2, y, x + CW - 1, y + CH - 1], fill=fg); return True
    if o in QUAD:
        for (on, (dx, dy)) in zip(QUAD[o], [(0, 0), (1, 0), (0, 1), (1, 1)]):
            if on:
                draw.rectangle([x + dx * w2, y + dy * h2, x + (CW - 1 if dx else w2 - 1), y + (CH - 1 if dy else h2 - 1)], fill=fg)
        return True
    if o == 0x2500: draw.rectangle([x, y + CH // 2, x + CW - 1, y + CH // 2], fill=fg); return True
    if o == 0x2502: draw.rectangle([x + CW // 2, y, x + CW // 2, y + CH - 1], fill=fg); return True
    return False

def render(text):
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    stream.feed(text.rstrip(b"\n").replace(b"\n", b"\r\n"))
    img = Image.new("RGB", (COLS * CW, ROWS * CH), BG)
    draw = ImageDraw.Draw(img)
    for row in range(ROWS):
        line = screen.buffer[row]
        for col in range(COLS):
            c = line[col]
            fg, bg = color(c.fg, FG), color(c.bg, BG)
            if c.reverse: fg, bg = bg, fg
            x, y = col * CW, row * CH
            if bg != BG: draw.rectangle([x, y, x + CW - 1, y + CH - 1], fill=bg)
            if c.data and c.data != " " and not block(draw, c.data, x, y, fg):
                draw.text((x, y), c.data, font=bold if c.bold else reg, fill=fg)
    return img

files = sorted(pathlib.Path(frames_dir).glob("*.ans"))
durs = [round(float(d) * 1000) for d in open(durations_file).read().split()]
imgs = [render(f.read_bytes()) for f in files]
if png_dir:
    png_dir.mkdir(parents=True, exist_ok=True)
    for f, im in zip(files, imgs): im.save(png_dir / (f.stem + ".png"))
imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=durs, loop=0, optimize=True, disposal=1)
print(out, imgs[0].size, len(imgs), sum(durs) / 1000, "s")
