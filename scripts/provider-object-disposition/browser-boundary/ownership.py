"""Read-only, bounded installer census. It never signals or deletes a process."""

import errno
import os
from pathlib import Path
import re
import stat
import sys
import time

TARGET = Path('/usr/local/lib/chase-sets-provider-window')
CENSUS = 'remove-ownership-census'
AMBIGUOUS = 'remove-ambiguous-owner'
ORPHAN = 'remove-orphan-owner'
LIVE = 'remove-live-owner'


class CensusError(Exception):
    pass


def bounded_read(path, limit=16384):
    with open(path, 'rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise CensusError()
    return data.decode('ascii')


def parse_stat(text, pid):
    match = re.fullmatch(r'(\d+) \(.*\) ([A-Z]) (\d+) (.+)\n', text, re.DOTALL)
    if not match or int(match[1]) != pid:
        raise CensusError()
    fields = text[text.rfind(') ') + 2:].strip().split()
    if len(fields) < 50 or any(not re.fullmatch(r'-?\d+', v) for v in fields[1:]):
        raise CensusError()
    start, parent, flags = int(fields[19]), int(fields[1]), int(fields[6])
    if start < 0 or parent < 0 or flags < 0:
        raise CensusError()
    return {'pid': pid, 'parent': parent, 'start': start, 'state': fields[0], 'kernel': bool(flags & 0x200000)}


def classify(previous, current, uid, image, initial, target_device):
    for pid, record in current.items():
        before = previous.get(pid)
        if before and (before['start'] != record['start'] or before['image'] != record['image']):
            return AMBIGUOUS
        parent = current.get(record['parent'])
        if parent and parent['start'] > record['start']:
            return AMBIGUOUS
        if (record['namespace'] == initial and record['image'] != image and
                record['image'] is not None and record['image'][0] == target_device and
                record['path'].startswith(TARGET.as_posix() + '/')):
            return AMBIGUOUS
    roots = {p for p, r in current.items() if r['image'] == image and r['namespace'] == initial}
    members = {p for p, r in current.items() if r['uid'] == uid and r['namespace'] != initial}
    for pid in members:
        visited = set()
        while pid not in roots:
            if pid in visited:
                return AMBIGUOUS
            visited.add(pid)
            record = current.get(pid)
            if record is None or record['parent'] == 0:
                return ORPHAN
            pid = record['parent']
    return LIVE if roots or members else 'none'


def snapshot():
    started = time.monotonic()
    pids = []
    with os.scandir('/proc') as entries:
        for entry in entries:
            if entry.name.isdecimal():
                pids.append(int(entry.name))
                if len(pids) > 4096:
                    raise CensusError()
    result = {}
    for pid in pids:
        path = Path('/proc') / str(pid)
        try:
            record = parse_stat(bounded_read(path / 'stat'), pid)
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ESRCH):
                continue
            raise
        try:
            status = bounded_read(path / 'status')
            uids = re.findall(r'^Uid:\s+(\d+)\s+\d+\s+\d+\s+\d+$', status, re.MULTILINE)
            if len(uids) != 1:
                raise CensusError()
            record['uid'] = int(uids[0])
            record['namespace'] = os.readlink(path / 'ns/pid')
            try:
                image = (path / 'exe').stat()
                record['image'] = (image.st_dev, image.st_ino)
                record['path'] = os.readlink(path / 'exe')
            except FileNotFoundError:
                if record['state'] != 'Z' and not record['kernel']:
                    raise CensusError()
                record['image'], record['path'] = None, ''
            reread = parse_stat(bounded_read(path / 'stat'), pid)
            if reread['start'] != record['start']:
                raise CensusError()
        except OSError:
            # Only a missing stat proves disappearance. Other missing fields do not.
            try:
                bounded_read(path / 'stat')
            except OSError as gone:
                if gone.errno in (errno.ENOENT, errno.ESRCH):
                    continue
            raise CensusError()
        result[pid] = record
        if time.monotonic() - started > 1:
            raise CensusError()
    return result


def census():
    started = time.monotonic()
    header = TARGET / 'source/browser-boundary/installation.h'
    launcher = TARGET / 'launcher'
    if header.is_symlink() or launcher.is_symlink():
        raise CensusError()
    matches = re.findall(r'^#define ADMITTED_UID ([0-9]+)$', bounded_read(header), re.MULTILINE)
    if len(matches) != 1 or int(matches[0]) == 0:
        raise CensusError()
    identity = launcher.stat()
    if not stat.S_ISREG(identity.st_mode):
        raise CensusError()
    uid, image = int(matches[0]), (identity.st_dev, identity.st_ino)
    initial = os.readlink('/proc/self/ns/pid')
    previous = snapshot()
    last = LIVE
    while time.monotonic() - started < 2:
        time.sleep(.02)
        current = snapshot()
        last = classify(previous, current, uid, image, initial, identity.st_dev)
        if time.monotonic() - started > 3:
            raise CensusError()
        if last == 'none' and classify({}, previous, uid, image, initial, identity.st_dev) == 'none':
            return 'none'
        if last == AMBIGUOUS:
            return last
        previous = current
    return last


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1 or os.getuid() != 0:
            raise CensusError()
        outcome = census()
    except (CensusError, OSError, UnicodeError, ValueError):
        outcome = CENSUS
    print(outcome)
    sys.exit(0 if outcome == 'none' else 1)
