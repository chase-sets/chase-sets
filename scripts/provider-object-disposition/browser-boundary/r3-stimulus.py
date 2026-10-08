"""Interrupt this installation's R3 child at its exact pre-target boundary."""
import ctypes
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import time

TARGET = Path('/usr/local/lib/chase-sets-provider-window')
INPUT = Path('/usr/local/lib/chase-sets-provider-window-input')
PROFILE = Path('/etc/apparmor.d/chase-sets-provider-window')
BACKUP = INPUT / 'SYNTHETIC_R3_PROFILE_ORIGINAL'
HEADER = TARGET / 'source/browser-boundary/installation.h'
HEADER_BACKUP = HEADER.with_name('installation.h.R3_ORIGINAL')
INSTALLER = INPUT / 'scripts/provider-object-disposition/browser-boundary/install-ci.sh'
SCRIPT = INSTALLER.with_name('SYNTHETIC_R3_INSTALLER.sh')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def regular(path):
    info = path.lstat()
    if path.resolve(strict=True) != path or info.st_uid != 0 or not stat.S_ISREG(info.st_mode):
        raise ValueError()


def mutate(action):
    if action == 'apply':
        for path in (PROFILE, HEADER, INSTALLER):
            regular(path)
        for path in (BACKUP, HEADER_BACKUP, SCRIPT):
            if path.exists() or path.is_symlink():
                raise ValueError()
        source = INSTALLER.read_text()
        anchor = '  mark remove-target\n'
        if source.count(anchor) != 1:
            raise ValueError()
        with BACKUP.open('xb') as output:
            output.write(PROFILE.read_bytes())
        with SCRIPT.open('x') as output:
            output.write(source.replace(anchor, "  printf 'SYNTHETIC_R3_READY\\n'\n  IFS= read -r synthetic_wait\n" + anchor))
        guardian = os.getpid()
        def lifetime():
            if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != guardian:
                os._exit(1)
        process = subprocess.Popen(['/bin/bash', str(SCRIPT), 'remove'], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, preexec_fn=lifetime)
        fd = os.pidfd_open(process.pid)
        output = b''
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    raise ValueError()
                chunk = os.read(process.stdout.fileno(), 4097 - len(output))
                output += chunk
                if len(output) > 4096 or not chunk:
                    raise ValueError()
                if output.endswith(b'SYNTHETIC_R3_READY\n'):
                    break
            else:
                raise ValueError()
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            remaining, error = process.communicate(timeout=2)
            output += remaining
            expected = (b'provider-boundary-installer-stage:source-location\n'
                        b'provider-boundary-installer-stage:remove-ownership\n'
                        b'provider-boundary-installer-stage:remove-profile\nSYNTHETIC_R3_READY\n')
            if process.returncode != -signal.SIGKILL or output != expected or error != b'':
                raise ValueError()
        finally:
            if process.poll() is None:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                process.communicate(timeout=2)
            os.close(fd)
        if PROFILE.exists() or PROFILE.is_symlink() or not TARGET.is_dir():
            raise ValueError()
        HEADER.rename(HEADER_BACKUP)
        print('provider-boundary-r3-stimulus:apply;installer-signal=SIGKILL;exact-output=true')
    elif action == 'restore':
        for path in (BACKUP, HEADER_BACKUP, SCRIPT):
            regular(path)
        if PROFILE.exists() or PROFILE.is_symlink() or HEADER.exists() or HEADER.is_symlink():
            raise ValueError()
        HEADER_BACKUP.rename(HEADER)
        BACKUP.rename(PROFILE)
        result = subprocess.run(['/usr/sbin/apparmor_parser', '-r', str(PROFILE)], env=ENV,
                                capture_output=True, timeout=5)
        if result.returncode != 0 or result.stdout or result.stderr:
            raise ValueError()
        SCRIPT.unlink()
        print('provider-boundary-r3-stimulus:restore')
    else:
        raise ValueError()


def main():
    try:
        if os.getuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in ('apply', 'restore'):
            raise ValueError()
        mutate(sys.argv[1])
        return 0
    except Exception:
        print('provider-boundary-r3-stimulus-refused:mutation', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
