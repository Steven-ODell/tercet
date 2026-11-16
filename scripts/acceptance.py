"""Drive a real tmux client through a private PTY; never attach a human terminal."""
import difflib
import re
import fcntl
import os
from pathlib import Path
import pty
import select
import shlex
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid
import signal

signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

ROOT = Path(__file__).resolve().parents[1]
MODE = "acceptance"
# acceptance.sh passes the sandbox's screens dir, or acceptance/ itself with --record.
EXPECTED = ROOT / "acceptance"
ARTIFACTS = Path(os.environ.get("TERCET_ACCEPTANCE_OUT", EXPECTED))
RECORD = os.environ.get("TERCET_ACCEPTANCE_RECORD") == "1"
ARTIFACTS.mkdir(parents=True, exist_ok=True)
CONTROL = Path(tempfile.mkdtemp(prefix="control-", dir=os.environ.get("TERCET_SANDBOX_DIR")))
SESSION = MODE + "-" + uuid.uuid4().hex[:10]
# A private socket per run, so acceptance.sh can kill exactly this tmux server.
TMUX = ["tmux", "-L", os.environ.get("TERCET_ACCEPTANCE_TMUX", "tercet-test")]
SANDBOX_PATH = re.compile(r"/tmp/tercet-sandbox\.[A-Za-z0-9]{6}")
SPINNER = re.compile("[\u2800-\u28ff](?= )")
SIDEBAR_AGE = re.compile(r" *(?:now|\d{1,2}m)(?=││)")
env = dict(os.environ, TERM="xterm-256color")
env.pop("TMUX", None)
client = None
master = None
wire = bytearray()


def tmux(*args):
    return subprocess.check_output(TMUX + list(args), env=env, stderr=subprocess.PIPE)


def pump():
    if select.select([master], [], [], 0.02)[0]:
        try:
            wire.extend(os.read(master, 65536))
        except OSError:
            pass


def capture():
    return tmux("capture-pane", "-p", "-t", SESSION).decode()


def wait_for(predicate, description):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        pump()
        if predicate():
            return
    raise AssertionError(description + "\n" + capture())


def mouse(button, x, y, release=False):
    os.write(master, f"\x1b[<{button};{x};{y}{'m' if release else 'M'}".encode())
    pump()


def normalized(text):
    """Mask what changes between runs without moving columns: the sandbox dir's random
    suffix, spinner frame, sidebar age and live provider token counts.
    The context percentage, bar and limit still have to match."""
    text = SANDBOX_PATH.sub("/tmp/tercet-sandbox.XXXXXX", text)
    text = SPINNER.sub("\u280b", text)
    text = SIDEBAR_AGE.sub(lambda m: "now".rjust(len(m.group(0))), text)
    return re.sub(r" +Context (\d+% [▰▱]+) [\d.]+[kM]? /", r" Context \1 <live> /", text)


def save(name):
    (ARTIFACTS / (name + ".txt")).write_text(normalized(capture()))


def screen(name, text):
    wait_for(lambda: text in capture(), name + " missing " + text)
    save(name)


def compare():
    """Every saved screen must equal its recorded copy in acceptance/."""
    failed = []
    for path in sorted(ARTIFACTS.glob("*.txt")):
        expected = EXPECTED / path.name
        want = expected.read_text().splitlines() if expected.exists() else []
        got = path.read_text().splitlines()
        if want != got:
            failed.append(path.stem)
            diff = difflib.unified_diff(want, got, "acceptance/" + path.name, str(path), lineterm="", n=0)
            print("\n".join(list(diff)[:24]), file=sys.stderr)
    if failed:
        raise AssertionError("screens differ from acceptance/: " + ", ".join(failed))


def key(*keys):
    for pressed in keys:
        tmux("send-keys", "-t", SESSION, pressed)
        for _ in range(8):
            pump()


try:
    command = "TERCET_ACCEPTANCE_CONTROL=" + shlex.quote(str(CONTROL)) + " exec bun " + shlex.quote(str(ROOT / "scripts/acceptance-app.tsx"))
    tmux("-f", "/dev/null", "new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40", command)
    tmux("set-option", "-t", SESSION, "status", "off")
    tmux("set-option", "-t", SESSION, "mouse", "on")
    tmux("set-option", "-s", "set-clipboard", "on")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    client = subprocess.Popen(TMUX + ["attach-session", "-t", SESSION], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    screen("01-thread", "tercet acceptance sandbox")
    key("M-m")
    screen("02-model", "Model · Favorites first")
    tmux("send-keys", "-t", SESSION, "-l", "flint-40b-free")
    key("Enter")
    wait_for(lambda: "Model · Favorites first" not in capture(), "model did not apply immediately")
    key("M-e")
    screen("03-model-options", "Apply selection")
    # Click the measured Apply label; never choose a paid model.
    lines = capture().splitlines()
    y = next(i for i,l in enumerate(lines) if "Apply selection" in l)
    x = lines[y].index("Apply selection")
    mouse(0, x+2, y+1); mouse(0, x+2, y+1, True)
    wait_for(lambda: "Apply selection" not in capture(), "model did not apply")
    key("Escape", "Escape")  # launch focus is the sidebar
    tmux("send-keys", "-t", SESSION, "-l", "Reply exactly acceptance-stream-ok. Do not use tools or change files.")
    screen("04-send", "Reply exactly")
    key("Enter")
    # Require an assistant row, not just the user's prompt containing the marker.
    wait_for(lambda: "assistant" in capture().lower() and capture().count("acceptance-stream-ok") >= 2, "free assistant did not stream")
    # Capture after the turn settles so the screen does not depend on stream timing.
    wait_for(lambda: "checkpoint · completed" in capture() and "Thinking…" not in capture(), "turn did not complete")
    screen("05-stream", "acceptance-stream-ok")
    key("Escape", "Escape")
    # Vim keys: select the last lines (they hold the assistant reply) and yank them.
    key("G", "V", "k", "k", "y")
    def copied():
        try:
            return b"acceptance-stream-ok" in tmux("show-buffer")
        except subprocess.CalledProcessError:
            return False
    wait_for(copied, "OSC52 copy missing")
    screen("06-copy", "Transcript")
    (CONTROL / "question").touch()
    screen("07-question-fixture", "choose Purple")
    key("i", "Enter", "Down", "Down", "Enter")  # vim i moves focus to the composer and its card
    wait_for(lambda: (CONTROL / "answered").exists(), "question response missing")
    save("08-answer-fixture")
    key("M-f")
    screen("09-files", "Files")
    (CONTROL / "diff").touch()
    wait_for(lambda: (CONTROL / "diff-ready").exists(), "diff fixture not ready")
    key("M-d")
    screen("10-diff-fixture", "acceptance-fixture.ts")
    key("Enter")
    screen("11-patch-fixture", "+purple fixture")
    if not RECORD:
        compare()
    print("PASS: sandbox thread/model/send/free stream/copy/files; deterministic question+diff fixtures; " + ("recorded " if RECORD else "screens match ") + str(EXPECTED))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
finally:
    # Raw terminal bytes stay private outside the repository.
    (CONTROL / "terminal.bin").write_bytes(wire)
    subprocess.run(TMUX + ["kill-session", "-t", SESSION], env=env, capture_output=True)
    if client:
        client.wait(timeout=5)
    if master is not None:
        os.close(master)
