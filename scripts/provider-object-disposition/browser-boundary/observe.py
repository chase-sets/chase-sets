"""Hosted control observer only. Outputs closed fields, never argv or file contents."""

import errno
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True

from ownership import CensusError, snapshot

stage = 'arguments'


class RootInspectionError(Exception):
    def __init__(self, record, kind, error):
        image = Path(record['path']).name
        numbers = (record['pid'], record['parent'], record['start'], *record['image'])
        if (image not in ('launcher', 'chrome', 'chrome_crashpad_handler') or
                kind not in ('host-helper', 'old-root') or
                any(type(n) is not int or not 0 <= n <= 9007199254740991 for n in numbers)):
            raise ValueError()
        codes = ('EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'ENOTDIR', 'ELOOP', 'EIO')
        code = next((c for c in codes if getattr(errno, c) == error.errno), 'other')
        self.diagnostic = ':'.join((*map(str, numbers), image, kind, code))
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
