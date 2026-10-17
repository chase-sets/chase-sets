"""Closed, root-only ownership stimulus; never installed in the workload root."""
import os
from pathlib import Path
import re
import stat
import sys

HEADER = Path('/usr/local/lib/chase-sets-provider-window/source/browser-boundary/installation.h')
BACKUP = HEADER.with_name('installation.h.original')


def regular(path):
    info = path.lstat()
    if path.resolve(strict=True) != path or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError()
    return info


def missing_key(action):
    if action == 'apply':
        info = regular(HEADER)
        if BACKUP.exists() or BACKUP.is_symlink():
            raise ValueError()
        original = HEADER.read_bytes()
        changed, count = re.subn(rb'^#define ADMITTED_UID [0-9]+\n', b'', original, flags=re.MULTILINE)
        if count != 1:
            raise ValueError()
        # Exclusive backup creation preserves the only restoration copy. A crash
        # during the subsequent write fails ownership admission, never deletion.
        with BACKUP.open('xb') as backup:
            backup.write(original)
        os.chmod(BACKUP, stat.S_IMODE(info.st_mode))
        try:
            HEADER.write_bytes(changed)
        except OSError:
            os.replace(BACKUP, HEADER)
            raise
    elif action == 'restore':
        regular(BACKUP)
        regular(HEADER)
        os.replace(BACKUP, HEADER)
    else:
        raise ValueError()


def main():
    try:
        if os.getuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in ('apply', 'restore'):
            raise ValueError()
        missing_key(sys.argv[1])
        print('provider-boundary-stimulus:missing-key-' + sys.argv[1])
        return 0
    except (OSError, ValueError):
        print('provider-boundary-stimulus-refused:missing-key', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
