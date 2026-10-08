"""Closed exact-name R1 stimuli. No ancestor, process, or loaded profile is changed."""
import os
from pathlib import Path
import stat
import sys

PATHS = {
    'target': Path('/usr/local/lib/chase-sets-provider-window'),
    'profile': Path('/etc/apparmor.d/chase-sets-provider-window'),
    'input': Path('/usr/local/lib/chase-sets-provider-window-input'),
}


def mutate(name, action):
    path = PATHS[name]
    backup = path.with_name(path.name + '.SYNTHETIC_PATH_ORIGINAL')
    if path.parent.resolve(strict=True) != path.parent:
        raise ValueError()
    if action == 'apply':
        info = path.lstat()
        if path.resolve(strict=True) != path or info.st_uid != 0 or stat.S_ISLNK(info.st_mode):
            raise ValueError()
        if backup.exists() or backup.is_symlink():
            raise ValueError()
        path.rename(backup)
        try:
            path.symlink_to(backup, target_is_directory=name != 'profile')
        except Exception:
            backup.rename(path)
            raise
    elif action == 'restore':
        if not path.is_symlink() or os.readlink(path) != str(backup):
            raise ValueError()
        if backup.resolve(strict=True) != backup or backup.lstat().st_uid != 0:
            raise ValueError()
        path.unlink()
        backup.rename(path)
    else:
        raise ValueError()


def main():
    try:
        if os.getuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in PATHS or sys.argv[2] not in ('apply', 'restore'):
            raise ValueError()
        mutate(sys.argv[1], sys.argv[2])
        print('provider-boundary-path-stimulus:' + sys.argv[1] + '-' + sys.argv[2])
        return 0
    except Exception:
        print('provider-boundary-path-stimulus-refused:mutation', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
