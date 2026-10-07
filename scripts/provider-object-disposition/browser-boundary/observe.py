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
        root = 'proc-fdinfo' if re.fullmatch(r'/proc/[0-9]+(?:/task/[0-9]+)?/fdinfo', link) else 'other'
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
        self.diagnostic = ':'.join((*map(str, numbers), image, kind, closed_errno(error), root_recheck(record)))
        super().__init__()


def root_exists(path, record, kind):
    try:
        return path.exists()
    except OSError as error:
        raise RootInspectionError(record, kind, error) from None


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
        fields['hostHelper'] = root_exists(path / 'root/usr/bin/sudo', r, 'host-helper')
        fields['oldRootDetached'] = not root_exists(path / 'root/old-root/usr', r, 'old-root')
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
