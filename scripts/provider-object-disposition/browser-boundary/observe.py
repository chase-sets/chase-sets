"""Hosted control observer only. Outputs closed fields, never argv or file contents."""

import errno
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True

from ownership import CensusError, bounded_read, parse_stat, snapshot

stage = 'arguments'
LAUNCHER = Path('/usr/local/lib/chase-sets-provider-window/launcher')
FDINFO_ROOT = r'/proc/[0-9]+(?:/task/[0-9]+)?/fdinfo'


def closed_errno(error):
    codes = ('EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'ENOTDIR', 'ELOOP', 'EIO')
    return next((c for c in codes if getattr(errno, c) == error.errno), 'other')


def root_recheck(record):
    path = Path('/proc') / str(record['pid'])
    try:
        current = parse_stat(bounded_read(path / 'stat'), record['pid'])
        if current['start'] != record['start']:
            identity = 'changed'
        elif current['state'] == 'Z':
            identity = 'zombie'
        else:
            image = (path / 'exe').stat()
            identity = 'same' if (image.st_dev, image.st_ino) == record['image'] else 'changed'
    except (CensusError, OSError, ValueError):
        identity = 'unknown'
    try:
        link = os.readlink(path / 'root')
        root = 'proc-fdinfo' if re.fullmatch(FDINFO_ROOT, link) else 'other'
    except OSError:
        root = 'unreadable'
    try:
        info = (path / 'root').stat()
        kind, code = ('directory' if stat.S_ISDIR(info.st_mode) else 'other'), 'none'
    except OSError as error:
        kind, code = 'unreadable', closed_errno(error)
    return ':'.join((identity, root, kind, code))


class RootInspectionError(Exception):
    def __init__(self, record, kind, error):
        image = Path(record['path']).name
        numbers = (record['pid'], record['parent'], record['start'], *record['image'])
        if (image not in ('launcher', 'chrome', 'chrome_crashpad_handler') or
                kind not in ('host-helper', 'old-root') or
                any(type(n) is not int or not 0 <= n <= 9007199254740991 for n in numbers)):
            raise ValueError()
        self.errno = closed_errno(error)
        self.diagnostic = ':'.join((*map(str, numbers), image, kind, self.errno, root_recheck(record)))
        super().__init__()


def root_exists(path, record, kind):
    try:
        return path.exists()
    except OSError as error:
        raise RootInspectionError(record, kind, error) from None


def same_identity(record):
    path = Path('/proc') / str(record['pid'])
    current = parse_stat(bounded_read(path / 'stat'), record['pid'])
    image = (path / 'exe').stat()
    return (current['start'] == record['start'] and current['parent'] == record['parent'] and
            current['state'] != 'Z' and (image.st_dev, image.st_ino) == record['image'])


def private_fdinfo_root(record, records):
    # Chromium can chroot to a helper's proc fdinfo directory. After that helper
    # exits, fdinfo permission returns ESRCH even while Chromium remains alive.
    # A proc fdinfo directory has only numeric, regular-file children: neither
    # usr nor old-root can exist. Bind its filesystem to the owned init's private
    # proc mount, rather than treating ESRCH or a matching path alone as proof.
    if Path(record['path']).name != 'chrome':
        return False
    try:
        installed = LAUNCHER.stat()
        launcher_image = (installed.st_dev, installed.st_ino)
        current = record
        visited = set()
        while current['pid'] not in visited:
            visited.add(current['pid'])
            parent = records.get(current['parent'])
            if parent is None or parent['start'] > current['start']:
                return False
            if parent['image'] == launcher_image and parent['path'] == str(LAUNCHER):
                if parent['namespace'] == os.readlink('/proc/self/ns/pid') or not same_identity(parent):
                    return False
                init = parent
                break
            current = parent
        else:
            return False
        root = Path('/proc') / str(record['pid']) / 'root'
        link = os.readlink(root)
        if not re.fullmatch(FDINFO_ROOT, link) or not same_identity(record):
            return False
        root_stat = root.stat()
        proc = Path('/proc') / str(init['pid']) / 'root/proc'
        proc_stat = proc.stat()
        if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_dev != proc_stat.st_dev:
            return False
        mounts = bounded_read(Path('/proc') / str(init['pid']) / 'mountinfo').splitlines()
        matches = []
        for line in mounts:
            before, after = line.split(' - ', 1)
            fields, filesystem = before.split(), after.split()
            if fields[4] == '/proc':
                matches.append((fields[2], filesystem[0]))
        device = f'{os.major(proc_stat.st_dev)}:{os.minor(proc_stat.st_dev)}'
        if matches != [(device, 'proc')]:
            return False
        reread = root.stat()
        return ((reread.st_dev, reread.st_ino) == (root_stat.st_dev, root_stat.st_ino) and
                os.readlink(root) == link and same_identity(record) and same_identity(init))
    except (CensusError, OSError, ValueError, KeyError, IndexError):
        return False


def inspect_root(record, records):
    path = Path('/proc') / str(record['pid']) / 'root'
    try:
        helper = root_exists(path / 'usr/bin/sudo', record, 'host-helper')
        detached = not root_exists(path / 'old-root/usr', record, 'old-root')
        return dict(hostHelper=helper, oldRootDetached=detached, rootObservation='path-checked')
    except RootInspectionError as error:
        if error.errno != 'ESRCH' or not private_fdinfo_root(record, records):
            raise
        return dict(hostHelper=False, oldRootDetached=True, rootObservation='private-proc-fdinfo')


def observe(parent):
    global stage
    stage = 'census'
    records = snapshot()
    stage = 'descendants'
    selected = {parent}
    for _ in range(64):
        children = {p for p, r in records.items() if r['parent'] in selected}
        if children <= selected:
            break
        selected |= children
    else:
        raise ValueError()
    result = []
    for pid in sorted(selected - {parent}):
        r = records[pid]
        name = Path(r['path']).name
        if name not in ('launcher', 'chrome', 'chrome_crashpad_handler'):
            continue
        path = Path('/proc') / str(pid)
        stage = 'status'
        status = (path / 'status').read_text()
        fields = {}
        for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp'):
            stage = 'status-field'
            values = re.findall(r'^' + key + r':\s+([0-9a-f]+)$', status, re.MULTILINE)
            if len(values) != 1:
                raise ValueError()
            fields[key] = values[0]
        stage = 'label'
        label = (path / 'attr/current').read_text().strip()
        fields['label'] = 'expected' if label == 'chase-sets-provider-window (unconfined)' else 'unexpected'
        stage = 'namespaces'
        fields['network'] = 'host' if os.readlink(path / 'ns/net') == os.readlink('/proc/self/ns/net') else 'isolated'
        fields['pidNamespace'] = 'host' if os.readlink(path / 'ns/pid') == os.readlink('/proc/self/ns/pid') else 'isolated'
        stage = 'root'
        fields.update(inspect_root(r, records))
        result.append(dict(pid=pid, parent=r['parent'], start=r['start'], image=name, **fields))
    return result


def main():
    global stage
    stage = 'arguments'
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdecimal() or os.getuid() != 0:
            raise ValueError()
        print(json.dumps(observe(int(sys.argv[1])), separators=(',', ':')))
        return 0
    except RootInspectionError as error:
        print('provider-boundary-observer-refused:root', file=sys.stderr)
        print('provider-boundary-observer-root:' + error.diagnostic, file=sys.stderr)
        return 1
    except (CensusError, OSError, ValueError, KeyError):
        print('provider-boundary-observer-refused:' + stage, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
