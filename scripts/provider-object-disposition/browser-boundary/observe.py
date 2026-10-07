"""Hosted control observer only. Outputs closed fields, never argv or file contents."""

import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True

from ownership import snapshot


def observe(parent):
    records = snapshot()
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
        status = (path / 'status').read_text()
        fields = {}
        for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp'):
            values = re.findall(r'^' + key + r':\s+([0-9a-f]+)$', status, re.MULTILINE)
            if len(values) != 1:
                raise ValueError()
            fields[key] = values[0]
        label = (path / 'attr/current').read_text().strip()
        fields['label'] = 'expected' if label == 'chase-sets-provider-window (unconfined)' else 'unexpected'
        fields['network'] = 'host' if os.readlink(path / 'ns/net') == os.readlink('/proc/self/ns/net') else 'isolated'
        fields['pidNamespace'] = 'host' if os.readlink(path / 'ns/pid') == os.readlink('/proc/self/ns/pid') else 'isolated'
        fields['hostHelper'] = (path / 'root/usr/bin/sudo').exists()
        fields['oldRootDetached'] = not (path / 'root/old-root/usr').exists()
        result.append(dict(pid=pid, parent=r['parent'], start=r['start'], image=name, **fields))
    return result


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdecimal() or os.getuid() != 0:
            raise ValueError()
        print(json.dumps(observe(int(sys.argv[1])), separators=(',', ':')))
    except (OSError, ValueError, KeyError):
        print('provider-boundary-observer-refused', file=sys.stderr)
        sys.exit(1)
