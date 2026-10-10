"""Root-owned, stdin-scoped synthetic owners. Only generated children are signalled."""
import errno
import json
import os
from pathlib import Path
import re
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
IMAGES = (('setpriv', '/usr/bin/setpriv'), ('sh', '/bin/sh'), ('sleep', '/usr/bin/sleep'))
ERRNOS = ('ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EINVAL', 'EIO')
STATES = {((0, 'setpriv'),): 'init-pre-exec', ((0, 'sh'),): 'child-absent',
          ((0, 'sh'), (1, 'sh')): 'child-pre-exec', ((0, 'sh'), (1, 'sleep')): 'final'}


def errno_name(error):
    name = errno.errorcode.get(getattr(error, 'errno', None), '')
    return name if name in ERRNOS else 'other'


def proc_children(pid):
    return Path(f'/proc/{pid}/task/{pid}/children').read_text().split()


def exe_image(member):
    info = os.stat(f'/proc/{member}/exe')
    return info.st_dev, info.st_ino


def generated_tree(root, images):
    """Read-only sample of the generated tree below the unshare child. Observation only."""
    try:
        tree = []
        pending = [(root, -1)]
        while pending:
            parent, depth = pending.pop(0)
            for member in proc_children(parent):
                if not member.isdecimal() or len(tree) == 4:
                    return None
                pid = int(member)
                before = parse_stat(bounded_read(Path('/proc') / member / 'stat'), pid)
                image = exe_image(member)
                after = parse_stat(bounded_read(Path('/proc') / member / 'stat'), pid)
                if before['start'] != after['start'] or before['parent'] != parent:
                    return None
                tree.append((depth + 1, pid, before['start'], images.get(image, 'other')))
                pending.append((pid, depth + 1))
        return tuple(tree)
    except Exception:
        return None


def image_names():
    try:
        return {(info.st_dev, info.st_ino): name for name, path in IMAGES for info in [os.stat(path)]}
    except Exception:
        return {}


def tree_state(tree):
    return 'incomplete' if tree is None else STATES.get(tuple((depth, image) for depth, _, _, image in tree), 'incomplete')


def generated_drift(ready, boundary):
    # Endpoint samples only: an unchanged tree can still hide a transient
    # drift, so neither value attributes the census outcome to a foreign PID.
    if 'incomplete' in (tree_state(ready), tree_state(boundary)):
        return 'unproven'
    return 'unchanged' if ready == boundary else 'changed'


def observation_line(ready, boundary):
    return (f'provider-boundary-owner-stimulus:observed:ready={tree_state(ready)};'
            f'boundary={tree_state(boundary)};generated={generated_drift(ready, boundary)}')


def retirement_reason(step, error):
    if step == 'foreign':
        return 'foreign-file'
    if step == 'member':
        return 'member-read-' + errno_name(error) if isinstance(error, OSError) else 'member-parse'
    return step + '-' + (errno_name(error) if isinstance(error, OSError) else 'other')


def principal():
    if TARGET.resolve(strict=True) != TARGET:
        raise ValueError()
    header = (TARGET / 'source/browser-boundary/installation.h').read_text()
    return tuple(int(re.findall(r'^#define ADMITTED_' + key + r' ([0-9]+)$', header, re.M)[0]) for key in ('UID', 'GID'))


def main():
    children = []
    members = []
    images = None
    ready_tree = None
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
        if mode == 'cap':
            os.execv(str(Path(__file__).with_name('census-stimulus')), ['census-stimulus', str(uid), str(gid), 'cap'])
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
            images = image_names()
            ready_tree = generated_tree(process.pid, images)
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
        # The boundary sample is read-only and precedes signalling; the closed
        # reasons below name the first retirement failure without changing it.
        boundary_tree = generated_tree(children[0][0].pid, images) if images is not None else None
        step = 'signal'
        reasons = []
        try:
            deadline = time.monotonic() + 2
            for fd in [entry[2] for entry in members] + [entry[1] for entry in children]:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    reasons.append('signal-' + errno_name(error))
            step = 'wait'
            for process, fd in children:
                try:
                    process.wait(timeout=max(.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    reasons.append('wait-timeout')
                except OSError as error:
                    reasons.append('wait-' + errno_name(error))
                finally:
                    os.close(fd)
            step = 'member'
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
                    reasons.append('member-live')
            if not reasons:
                step = 'foreign'
                if created:
                    info = FOREIGN.lstat()
                    if FOREIGN.resolve(strict=True) != FOREIGN or not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
                        raise ValueError()
                    FOREIGN.unlink()
        except Exception as error:
            reasons.append(retirement_reason(step, error))
        try:
            if images is not None:
                print(observation_line(ready_tree, boundary_tree), flush=True)
            if reasons:
                raise ValueError()
            print('provider-boundary-owner-stimulus:retired', flush=True)
        except Exception:
            print('provider-boundary-owner-stimulus-refused:retirement:' + (reasons or ['output'])[0], file=sys.stderr)
            result = 1
    return result


if __name__ == '__main__':
    sys.exit(main())
