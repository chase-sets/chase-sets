"""Read-only control-13 identities, not the installer's ownership census.

Pin the lifetime-bearing L -> I1 -> Chromium chain after browser readiness.
Chromium's short-lived startup helpers are not permanent launch identities.
No process is signalled, and no missing recorded identity is forgiven.
"""

import errno
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True

from ownership import CensusError, bounded_read, parse_stat

LAUNCHER = '/usr/local/lib/chase-sets-provider-window/launcher'
CHROME = '/usr/local/lib/chase-sets-provider-window/root/browser/chrome'
PROC = Path('/proc')


def identity(pid):
    path = PROC / str(pid)
    record = parse_stat(bounded_read(path / 'stat'), pid)
    if record['state'] in ('Z', 'X'):
        raise ValueError('dead')
    executable = (path / 'exe').stat()
    image = next((name for target, name in ((LAUNCHER, 'launcher'), (CHROME, 'chrome'))
                  if os.path.samestat(executable, Path(target).stat())), None)
    if image is None:
        raise ValueError('image')
    current = parse_stat(bounded_read(path / 'stat'), pid)
    if any(current[key] != record[key] for key in ('start', 'parent')) or current['state'] in ('Z', 'X'):
        raise ValueError('changed')
    return dict(pid=pid, start=record['start'], parent=record['parent'], image=image,
                device=executable.st_dev, inode=executable.st_ino)


def children(parent, executable, arguments):
    expected = Path(executable).stat()
    text = bounded_read(PROC / str(parent) / 'task' / str(parent) / 'children')
    values = text.split()
    if len(values) > 256 or any(not value.isdecimal() for value in values):
        raise ValueError('children')
    result = []
    for value in values:
        pid = int(value)
        path = PROC / value
        try:
            if not os.path.samestat((path / 'exe').stat(), expected):
                continue
            argv = bounded_read(path / 'cmdline').split('\0')
            if argv[:len(arguments)] != arguments:
                continue
            record = identity(pid)
        except OSError as error:
            # Discovery may encounter an exited, unselected startup helper.
            # Completeness of the required chain is still asserted below.
            if error.errno not in (errno.ENOENT, errno.ESRCH):
                raise
            try:
                bounded_read(path / 'stat')
            except OSError as gone:
                if gone.errno in (errno.ENOENT, errno.ESRCH):
                    continue
            raise
        if record['parent'] != parent:
            raise ValueError('parent')
        result.append(record)
    return result


def baseline(parent, count):
    if count not in (0, 1, 2):
        raise ValueError('count')
    roots = children(parent, LAUNCHER, [LAUNCHER, 'browser'])
    if len(roots) != count:
        raise ValueError('roots')
    records = []
    for root in roots:
        inits = children(root['pid'], LAUNCHER, [LAUNCHER, 'browser'])
        if len(inits) != 1:
            raise ValueError('init')
        init = inits[0]
        browsers = children(init['pid'], CHROME, ['/browser/chrome', '--headless', '--remote-debugging-pipe'])
        if len(browsers) != 1:
            raise ValueError('browser')
        browser = browsers[0]
        if not root['start'] <= init['start'] <= browser['start']:
            raise ValueError('start')
        records.extend((root, init, browser))
    # Recheck all selected identities: startup discovery is not survival proof.
    if [identity(record['pid']) for record in records] != records:
        raise ValueError('changed')
    return records


def main():
    try:
        if os.getuid() != 0:
            raise ValueError('principal')
        if len(sys.argv) == 4 and sys.argv[1] == 'baseline':
            records = baseline(int(sys.argv[2]), int(sys.argv[3]))
        elif len(sys.argv) == 3 and sys.argv[1] == 'survival':
            pids = sys.argv[2].split(',') if sys.argv[2] else []
            if len(pids) > 6 or len(set(pids)) != len(pids) or any(not p.isdecimal() for p in pids):
                raise ValueError('pids')
            records = [identity(int(pid)) for pid in pids]
        else:
            raise ValueError('arguments')
        print(json.dumps(records, separators=(',', ':')))
        return 0
    except (CensusError, OSError, ValueError):
        # Never print exception text, argv, executable paths or proc contents.
        print('provider-boundary-identity-refused', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
