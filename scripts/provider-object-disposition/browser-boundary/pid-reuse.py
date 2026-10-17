"""At most eight native PID-reuse attempts. Only generated children get pidfd signals."""
import ctypes
import errno
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
from ownership import bounded_read, parse_stat

TARGET = Path('/usr/local/lib/chase-sets-provider-window')


def identity(pid):
    return parse_stat(bounded_read(Path('/proc') / str(pid) / 'stat'), pid)


def retire(process, fd):
    members = []
    try:
        signal.pidfd_send_signal(fd, signal.SIGSTOP)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            stopped, status = os.waitpid(process.pid, os.WUNTRACED | os.WNOHANG)
            if stopped and os.WIFSTOPPED(status):
                break
            if stopped:
                raise ValueError()
            time.sleep(.01)
        else:
            raise ValueError()
        for value in Path(f'/proc/{process.pid}/task/{process.pid}/children').read_text().split():
            pid = int(value)
            before = identity(pid)
            member = os.pidfd_open(pid)
            after = identity(pid)
            if before['start'] != after['start'] or after['parent'] != process.pid:
                os.close(member)
                raise ValueError()
            members.append((pid, member))
        signal.pidfd_send_signal(fd, signal.SIGKILL)
        for _, member in members:
            signal.pidfd_send_signal(member, signal.SIGKILL)
        process.wait(timeout=2)
        deadline = time.monotonic() + 2
        for pid, _ in members:
            while time.monotonic() < deadline:
                if os.waitpid(pid, os.WNOHANG)[0] == pid:
                    break
                time.sleep(.01)
            else:
                raise ValueError()
    finally:
        os.close(fd)
        for _, member in members:
            os.close(member)


def main():
    active = None
    stage = 'arguments'
    try:
        if os.getuid() != 0 or len(sys.argv) != 3 or not all(re.fullmatch(r'[1-9][0-9]{0,9}', value) for value in sys.argv[1:]):
            raise ValueError()
        pid, start = map(int, sys.argv[1:])
        stage = 'old-identity'
        try:
            if identity(pid)['start'] == start:
                raise ValueError()
        except FileNotFoundError:
            pass
        stage = 'principal'
        header = bounded_read(TARGET / 'source/browser-boundary/installation.h')
        uid, gid = (int(re.findall(r'^#define ADMITTED_' + key + r' ([0-9]+)$', header, re.M)[0]) for key in ('UID', 'GID'))
        if not uid or ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
            raise ValueError()
        stage = 'construct'
        for attempt in range(1, 9):
            try:
                Path('/proc/sys/kernel/ns_last_pid').write_text(str(pid - 1))
            except OSError as error:
                reason = {errno.EROFS: 'EROFS', errno.EPERM: 'EPERM', errno.EACCES: 'EACCES', errno.ENOENT: 'ENOENT'}.get(error.errno)
                if reason is None:
                    raise
                print(json.dumps({'constructed': False, 'reason': reason, 'attempts': attempt}), flush=True)
                return 0
            process = subprocess.Popen(['/bin/sh', '-c', 'sleep 30; :', 'SYNTHETIC_PID_REUSE_CONTROL'],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}, user=uid, group=gid, extra_groups=[])
            fd = os.pidfd_open(process.pid)
            active = (process, fd)
            actual = identity(process.pid)
            if process.pid == pid and actual['start'] != start:
                print(json.dumps({'constructed': True, 'pid': pid, 'start': actual['start'], 'attempts': attempt}), flush=True)
                stage = 'survival'
                ready, _, _ = select.select([sys.stdin], [], [], 5)
                if not ready or sys.stdin.buffer.read(1) != b'' or process.poll() is not None:
                    raise ValueError()
                retire(*active)
                active = None
                print('provider-boundary-pid-reuse:survived-retired', flush=True)
                return 0
            retire(*active)
            active = None
        print(json.dumps({'constructed': False, 'reason': 'attempts-exhausted', 'attempts': 8}), flush=True)
        return 0
    except Exception:
        print('provider-boundary-pid-reuse-refused:' + stage, file=sys.stderr)
        return 1
    finally:
        if active:
            try:
                retire(*active)
            except Exception:
                print('provider-boundary-pid-reuse-refused:retirement', file=sys.stderr)


if __name__ == '__main__':
    sys.exit(main())
