"""Run a command as a child subreaper and take down everything it started.

    reaper.py PIDDIR -- CMD...      writes PIDDIR/reaper.pid and PIDDIR/server.pid (CMD's pid)

The upstream server starts OpenCode with setsid, so a session kill (bgrun) misses it, and if
the server dies the agent is orphaned. As a subreaper, those orphans re-parent to us instead
of to init. When the command exits, or we get SIGTERM/SIGINT/SIGHUP, every descendant gets
SIGTERM, then SIGKILL after a grace period. Only our own descendants are ever signalled.
"""
import ctypes
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
GRACE = 3.0


def descendants(pid):
    found = []
    try:
        with open(f"/proc/{pid}/task/{pid}/children") as source:
            kids = [int(child) for child in source.read().split()]
    except OSError:
        return found
    for kid in kids:
        found.append(kid)
        found.extend(descendants(kid))
    return found


def reap(server=None):
    """Reap finished children; returns the server's wait status if it was among them."""
    status = None
    while True:
        try:
            pid, code = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return status
        if pid == 0:
            return status
        if pid == server:
            status = code


def signal_all(sig):
    for pid in descendants(os.getpid()):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        sys.exit("usage: reaper.py PIDDIR -- CMD...")
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        sys.exit("reaper: prctl(PR_SET_CHILD_SUBREAPER) failed")
    stopping = []
    child = subprocess.Popen(sys.argv[3:])
    for name, pid in (("reaper", os.getpid()), ("server", child.pid)):
        with open(os.path.join(sys.argv[1], name + ".pid"), "w") as target:
            target.write(f"{pid}\n")

    def stop(signum, _frame):
        if not stopping:
            stopping.append(time.monotonic())
            child.send_signal(signal.SIGTERM)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    # The server stops its own agents on SIGTERM; give it the grace period to do so.
    status = None
    while status is None:
        if stopping and time.monotonic() - stopping[0] > GRACE:
            child.kill()
        status = reap(child.pid)
        time.sleep(0.05)
    signal_all(signal.SIGTERM)
    deadline = time.monotonic() + GRACE
    while descendants(os.getpid()) and time.monotonic() < deadline:
        reap()
        time.sleep(0.05)
    signal_all(signal.SIGKILL)
    time.sleep(0.1)
    reap()
    code = os.waitstatus_to_exitcode(status)
    sys.exit(code if code >= 0 else 128 - code)


main()
