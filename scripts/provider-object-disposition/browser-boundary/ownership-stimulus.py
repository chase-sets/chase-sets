"""Root-owned, stdin-scoped synthetic owners. Only generated children are signalled."""
import errno
import json
import os
from pathlib import Path
import re
import resource
import select
import shutil
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
from ownership import bounded_read, parse_stat

TARGET = Path('/usr/local/lib/chase-sets-provider-window')
FOREIGN = TARGET / 'SYNTHETIC_AMBIGUOUS_OWNER_CONTROL'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def principal():
    if TARGET.resolve(strict=True) != TARGET:
        raise ValueError()
    header = (TARGET / 'source/browser-boundary/installation.h').read_text()
    return tuple(int(re.findall(r'^#define ADMITTED_' + key + r' ([0-9]+)$', header, re.M)[0]) for key in ('UID', 'GID'))


def process_count():
    with os.scandir('/proc') as entries:
        return sum(entry.name.isdecimal() for entry in entries)


def main():
    children = []
    members = []
    created = False
    result = 1
    constructed = True
    stage = 'arguments'
    try:
        if os.getuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in ('orphan', 'foreign', 'cap'):
            raise ValueError()
        uid, gid = principal()
        if uid == 0:
            raise ValueError()
        mode = sys.argv[1]
        stage = 'construct'

        def child(argv, admitted=True):
            reserved = os.open('/dev/null', os.O_RDONLY | os.O_CLOEXEC)
            try:
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           env=ENV, user=uid if admitted else None, group=gid if admitted else None,
                                           extra_groups=[] if admitted else None)
            finally:
                os.close(reserved)
            fd = os.pidfd_open(process.pid)
            children.append((process, fd))

        if mode == 'orphan':
            child(['/usr/bin/unshare', '--pid', '--fork', '--kill-child=KILL', '/usr/bin/setpriv',
                   f'--reuid={uid}', f'--regid={gid}', '--clear-groups', '/bin/sh', '-c', 'sleep 30; :',
                   'SYNTHETIC_ORPHAN_OWNER_CONTROL'], admitted=False)
            process = children[0][0]
            deadline = time.monotonic() + 1
            observed = False
            while process.poll() is None and time.monotonic() < deadline:
                candidates = Path(f'/proc/{process.pid}/task/{process.pid}/children').read_text().split()
                for member in candidates:
                    if not member.isdecimal():
                        raise ValueError()
                    status = Path(f'/proc/{member}/status').read_text()
                    actual = re.search(r'^Uid:\s+(\d+)\s', status, re.M)
                    if actual and int(actual[1]) == uid and os.readlink(f'/proc/{member}/ns/pid') != os.readlink('/proc/self/ns/pid'):
                        pid = int(member)
                        before = parse_stat(bounded_read(Path('/proc') / member / 'stat'), pid)
                        fd = os.pidfd_open(pid)
                        after = parse_stat(bounded_read(Path('/proc') / member / 'stat'), pid)
                        if before['start'] != after['start'] or before['parent'] != process.pid:
                            os.close(fd)
                            raise ValueError()
                        members.append((pid, before['start'], fd))
                        observed = True
                if observed:
                    break
                time.sleep(.01)
            if not observed:
                raise ValueError()
        elif mode == 'foreign':
            if FOREIGN.exists() or FOREIGN.is_symlink():
                raise ValueError()
            with FOREIGN.open('xb') as output, Path('/bin/sleep').open('rb') as source:
                shutil.copyfileobj(source, output)
            created = True
            os.chown(FOREIGN, 0, gid)
            os.chmod(FOREIGN, 0o750)
            child([str(FOREIGN), '30'])
            if children[0][0].poll() is not None:
                raise ValueError()
        else:
            try:
                while process_count() < 4097 and len(children) < 4097:
                    child(['/bin/sleep', '30'])
            except OSError as error:
                if error.errno not in (errno.EAGAIN, errno.ENOMEM, errno.EMFILE):
                    raise
                print(json.dumps({'constructed': False, 'reason': errno.errorcode[error.errno], 'children': len(children),
                                  'fileLimit': resource.getrlimit(resource.RLIMIT_NOFILE)[0],
                                  'processLimit': resource.getrlimit(resource.RLIMIT_NPROC)[0]}), flush=True)
                constructed = False
            if constructed and process_count() < 4097:
                raise ValueError()
        if constructed:
            print(json.dumps({'constructed': True, 'children': len(children), 'mode': mode}), flush=True)
            stage = 'lifetime'
            # EOF is event-driven retirement. The finite backup deadline also owns
            # cleanup if the admitted controller disappears without closing stdin.
            ready, _, _ = select.select([sys.stdin], [], [], 15)
            if not ready or sys.stdin.buffer.read(1) != b'':
                raise ValueError()
        result = 0
    except Exception:
        print('provider-boundary-owner-stimulus-refused:' + stage, file=sys.stderr)
    finally:
        try:
            deadline = time.monotonic() + 2
            failed = False
            for fd in [entry[2] for entry in members] + [entry[1] for entry in children]:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError:
                    failed = True
            for process, fd in children:
                try:
                    process.wait(timeout=max(.001, deadline - time.monotonic()))
                except (OSError, subprocess.TimeoutExpired):
                    failed = True
                finally:
                    os.close(fd)
            for pid, start, fd in members:
                os.close(fd)
                while time.monotonic() < deadline:
                    try:
                        actual = parse_stat(bounded_read(Path('/proc') / str(pid) / 'stat'), pid)
                        if actual['start'] != start:
                            break
                    except FileNotFoundError:
                        break
                    time.sleep(.01)
                else:
                    failed = True
            if failed:
                raise ValueError()
            if created:
                info = FOREIGN.lstat()
                if FOREIGN.resolve(strict=True) != FOREIGN or not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
                    raise ValueError()
                FOREIGN.unlink()
            print('provider-boundary-owner-stimulus:retired', flush=True)
        except Exception:
            print('provider-boundary-owner-stimulus-refused:retirement', file=sys.stderr)
            result = 1
    return result


if __name__ == '__main__':
    sys.exit(main())
