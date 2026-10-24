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
WITNESS_PREFIX = 'provider-boundary-removal-witness:'
WITNESS_LIMIT = 1024
CAPTURE_LIMIT = len(AMBIGUOUS) + 1 + WITNESS_LIMIT


class CensusError(Exception):
    pass


def bounded_read(path, limit=16384):
    with open(path, 'rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise CensusError()
    return data.decode('ascii')


def parse_stat(text, pid):
    match = re.fullmatch(r'(\d+) \(.*\) ([A-Ztx]) (\d+) (.+)\n', text, re.DOTALL)
    if not match or int(match[1]) != pid:
        raise CensusError()
    fields = text[text.rfind(') ') + 2:].strip().split()
    if len(fields) < 50 or any(not re.fullmatch(r'-?\d+', v) for v in fields[1:]):
        raise CensusError()
    start, parent, flags = int(fields[19]), int(fields[1]), int(fields[6])
    if start < 0 or parent < 0 or flags < 0:
        raise CensusError()
    return {'pid': pid, 'parent': parent, 'start': start, 'state': fields[0],
            'kernel': bool(flags & 0x200000), 'exiting': bool(flags & 0x4)}


def removal_witness(data):
    """Validate the entire closed ASCII record, including its final newline."""
    if not isinstance(data, bytes) or len(data) > WITNESS_LIMIT:
        return None
    match = re.fullmatch(
        rb'provider-boundary-removal-witness:v1;predicate=(identity-drift|parent-order|foreign-image|member-cycle);'
        rb'records=([^;\n]+);start-drift=([01]);image-drift=([01]);repeated-pid=([0-9]+);chain-length=([0-9]+)\n', data)
    if not match:
        return None

    def number(value, maximum, minimum=0):
        if not re.fullmatch(rb'0|[1-9][0-9]{0,19}', value):
            raise ValueError()
        result = int(value)
        if not minimum <= result <= maximum:
            raise ValueError()
        return result

    try:
        records = []
        for encoded in match[2].split(b'|'):
            pid, parent, start, device, inode, namespace, uid, image = encoded.split(b',')
            if namespace not in (b'initial', b'noninitial') or uid not in (b'admitted', b'other'):
                return None
            if image not in (b'launcher', b'target', b'other', b'none'):
                return None
            identity = None if image == b'none' and device == inode == b'-' else (
                number(device, 2**64 - 1), number(inode, 2**64 - 1))
            if image == b'none' and identity is not None:
                return None
            records.append((number(pid, 2**31 - 1, 1), number(parent, 2**31 - 1),
                            number(start, 2**64 - 1), identity, namespace, uid, image))
        predicate = match[1]
        if len(records) != (2 if predicate in (b'identity-drift', b'parent-order') else 1):
            return None
        start_drift, image_drift = match[3] == b'1', match[4] == b'1'
        repeated, length = number(match[5], 2**31 - 1), number(match[6], 4096)
        if predicate != b'member-cycle' and (repeated or length):
            return None
        if predicate != b'identity-drift' and (start_drift or image_drift):
            return None
        first = records[0]
        if predicate == b'identity-drift':
            second = records[1]
            if (first[0] != second[0] or not (start_drift or image_drift) or
                    start_drift != (first[2] != second[2]) or image_drift != (first[3] != second[3])):
                return None
        elif predicate == b'parent-order':
            if first[1] != records[1][0] or records[1][2] <= first[2]:
                return None
        elif predicate == b'foreign-image':
            if first[4] != b'initial' or first[6] != b'target':
                return None
        elif repeated != first[0] or length == 0:
            return None
        return data
    except ValueError:
        return None


def witness_record(predicate, records, uid, image, initial, target_device, repeated=0, length=0):
    projected = []
    for record in records:
        identity = record['image']
        identity_fields = tuple(str(value) for value in identity) if identity is not None else ('-', '-')
        image_class = ('none' if identity is None else 'launcher' if identity == image else
                       'target' if identity[0] == target_device and record['path'].startswith(TARGET.as_posix() + '/') else 'other')
        projected.append(','.join((str(record['pid']), str(record['parent']), str(record['start']),
                                   *identity_fields,
                                   'initial' if record['namespace'] == initial else 'noninitial',
                                   'admitted' if record['uid'] == uid else 'other', image_class)))
    drift = predicate == 'identity-drift'
    line = (f'{WITNESS_PREFIX}v1;predicate={predicate};records={"|".join(projected)};'
            f'start-drift={int(drift and records[0]["start"] != records[1]["start"])};'
            f'image-drift={int(drift and records[0]["image"] != records[1]["image"])};'
            f'repeated-pid={repeated};chain-length={length}\n').encode('ascii')
    return removal_witness(line)


def classify(previous, current, uid, image, initial, target_device):
    return _classify(previous, current, uid, image, initial, target_device, None)


def _candidate(record, image, initial, target_device):
    """Every possible root or member is a candidate; UID alone never is."""
    identity = record['image']
    return (record['namespace'] != initial or identity == image or
            (identity is not None and identity[0] == target_device and
             record['path'].startswith(TARGET.as_posix() + '/')))


def _exited(before, record):
    """Only an imaged process turning into a same-start user zombie has exited."""
    return (before['start'] == record['start'] and before['image'] is not None and
            record['image'] is None and record.get('state') == 'Z' and record.get('kernel') is False)


def _classify(previous, current, uid, image, initial, target_device, witness):
    def ambiguous(predicate, records, repeated=0, length=0):
        if witness is not None:
            witness.append(witness_record(predicate, records, uid, image, initial, target_device, repeated, length))
        return AMBIGUOUS

    def candidate(*records):
        return any(_candidate(record, image, initial, target_device) for record in records)

    for pid, record in current.items():
        before = previous.get(pid)
        # Identity is PID and start (#10023). Drift and parent order can hide an
        # owner only when either record is a candidate.
        if (before and (before['start'] != record['start'] or before['image'] != record['image']) and
                not _exited(before, record) and candidate(before, record)):
            return ambiguous('identity-drift', (before, record))
        parent = current.get(record['parent'])
        if parent and parent['start'] > record['start'] and candidate(record, parent):
            return ambiguous('parent-order', (record, parent))
        if (record['namespace'] == initial and record['image'] != image and
                record['image'] is not None and record['image'][0] == target_device and
                record['path'].startswith(TARGET.as_posix() + '/')):
            return ambiguous('foreign-image', (record,))
    roots = {p for p, r in current.items() if r['image'] == image and r['namespace'] == initial}
    members = {p for p, r in current.items() if r['uid'] == uid and r['namespace'] != initial}
    for pid in members:
        visited = set()
        while pid not in roots:
            if pid in visited:
                return ambiguous('member-cycle', (current[pid],), pid, len(visited))
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
            if time.monotonic() - started > 1:
                raise CensusError()
            if entry.name.isdecimal():
                pids.append(int(entry.name))
                if len(pids) > 4096:
                    raise CensusError()
    result = {}
    for pid in pids:
        if time.monotonic() - started > 1:
            raise CensusError()
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
                    raise
                record['image'], record['path'] = None, ''
            reread = parse_stat(bounded_read(path / 'stat'), pid)
            if any(reread[key] != record[key] for key in ('start', 'kernel')):
                raise CensusError()
            # Reparenting is not a new identity; keep the parent seen last.
            record['parent'] = reread['parent']
        except OSError as error:
            # A missing field alone is not exit proof. A terminal stat must still
            # identify the same process, not a replacement or reparented owner.
            # A released task can surface as EACCES on its exe/ns links; only a
            # missing stat accepts that, never a still-present process.
            try:
                terminal = parse_stat(bounded_read(path / 'stat'), pid)
            except OSError as gone:
                if gone.errno in (errno.ENOENT, errno.ESRCH):
                    continue
                raise CensusError()
            if (error.errno in (errno.ENOENT, errno.ESRCH) and
                    all(terminal[key] == record[key] for key in ('start', 'parent', 'kernel')) and
                    (terminal['state'] in ('Z', 'X') or terminal['exiting'])):
                continue
            raise CensusError()
        result[pid] = record
        if time.monotonic() - started > 1:
            raise CensusError()
    if time.monotonic() - started > 1:
        raise CensusError()
    return result


def census():
    return _census(None)


def _census(witness):
    started = time.monotonic()
    header = TARGET / 'source/browser-boundary/installation.h'
    launcher = TARGET / 'launcher'
    if header.is_symlink() or launcher.is_symlink():
        raise CensusError()
    text = bounded_read(header)
    definitions = re.findall(r'^\s*#\s*define\s+ADMITTED_UID\b.*$', text, re.MULTILINE)
    matches = re.findall(r'^#define ADMITTED_UID ([0-9]+)$', text, re.MULTILINE)
    if len(definitions) != 1 or len(matches) != 1 or int(matches[0]) == 0:
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
        detail = [] if witness is not None else None
        last = _classify(previous, current, uid, image, initial, identity.st_dev, detail)
        if time.monotonic() - started > 3:
            raise CensusError()
        if last == 'none' and classify({}, previous, uid, image, initial, identity.st_dev) == 'none':
            return 'none'
        if last == AMBIGUOUS:
            if witness is not None:
                witness.extend(detail)
            return last
        previous = current
    return last


def validate_capture(stream):
    data = stream.read(CAPTURE_LIMIT + 1)
    if len(data) > CAPTURE_LIMIT:
        return None
    if data in (b'none\n', *(f'{stage}\n'.encode() for stage in (LIVE, ORPHAN, CENSUS))):
        return data
    prefix = (AMBIGUOUS + '\n').encode()
    if data.startswith(prefix) and removal_witness(data[len(prefix):]) is not None:
        return data
    return None


def main():
    if sys.argv[1:] == ['--validate-capture']:
        validated = validate_capture(sys.stdin.buffer)
        if validated is None:
            return 1
        sys.stdout.write(validated.decode('ascii'))
        return 0
    detail = []
    try:
        if len(sys.argv) != 1 or os.getuid() != 0:
            raise CensusError()
        outcome = _census(detail)
    except (CensusError, OSError, UnicodeError, ValueError):
        outcome = CENSUS
    print(outcome)
    if outcome == AMBIGUOUS and len(detail) == 1 and detail[0] is not None:
        sys.stdout.write(detail[0].decode('ascii'))
    return 0 if outcome == 'none' else 1


if __name__ == '__main__':
    sys.exit(main())
