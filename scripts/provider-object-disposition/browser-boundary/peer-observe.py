"""Same-UID, non-descendant reach and bounded holder observations. Never signals."""
import errno
import json
import os
from pathlib import Path
import re
import sys
import time

sys.dont_write_bytecode = True
from ownership import bounded_read, parse_stat, CensusError


def pairs(text):
    if len(text) > 16384 or not re.fullmatch(r'[0-9]+:[0-9]+(?:,[0-9]+:[0-9]+)*', text):
        raise ValueError()
    result = [tuple(map(int, value.split(':'))) for value in text.split(',')]
    if len(result) > 256:
        raise ValueError()
    return result


def reach(owners):
    result = []
    for pid, start in owners:
        observation = 'unknown'
        try:
            before = parse_stat(bounded_read(Path('/proc') / str(pid) / 'stat'), pid)
            if before['start'] != start:
                observation = 'gone'
            else:
                fd = os.open(f'/proc/{pid}/ns/user', os.O_RDONLY | os.O_CLOEXEC)
                try:
                    after = parse_stat(bounded_read(Path('/proc') / str(pid) / 'stat'), pid)
                    observation = 'readable' if after['start'] == start else 'gone'
                finally:
                    os.close(fd)
        except OSError as error:
            observation = {errno.EACCES: 'EACCES', errno.EPERM: 'EPERM', errno.ENOENT: 'gone', errno.ESRCH: 'gone'}.get(error.errno, 'unknown')
        except (ValueError, CensusError):
            observation = 'unknown'
        result.append({'pid': pid, 'start': start, 'observation': observation})
    return result


def census(namespaces):
    started = time.monotonic()
    scanned = 0
    unknown = 0
    holders = []
    complete = True
    with os.scandir('/proc') as processes:
        for entry in processes:
            if not entry.name.isdecimal():
                continue
            if scanned == 4096 or time.monotonic() - started >= 2:
                complete = False
                break
            scanned += 1
            pid = int(entry.name)
            try:
                status = bounded_read(Path(entry.path) / 'status')
                uid = re.search(r'^Uid:\s+(\d+)\s', status, re.M)
                if not uid:
                    raise ValueError()
                if int(uid[1]) != os.getuid():
                    continue
                before = parse_stat(bounded_read(Path(entry.path) / 'stat'), pid)
                found = False
                try:
                    info = os.stat(Path(entry.path) / 'ns/user')
                    found = (info.st_dev, info.st_ino) in namespaces
                except OSError:
                    unknown += 1
                with os.scandir(Path(entry.path) / 'fd') as descriptors:
                    for index, descriptor in enumerate(descriptors):
                        if index == 8192 or time.monotonic() - started >= 2:
                            complete = False
                            break
                        try:
                            info = descriptor.stat()
                            found |= (info.st_dev, info.st_ino) in namespaces
                        except OSError:
                            unknown += 1
                after = parse_stat(bounded_read(Path(entry.path) / 'stat'), pid)
                if after['start'] != before['start']:
                    unknown += 1
                elif found:
                    holders.append({'pid': pid, 'start': before['start']})
            except (OSError, ValueError, CensusError):
                unknown += 1
    return {'scanned': scanned, 'complete': complete, 'unknown': unknown, 'peerHolders': holders}


def main():
    try:
        if len(sys.argv) != 3 or os.getuid() == 0:
            raise ValueError()
        values = pairs(sys.argv[2])
        if sys.argv[1] == 'reach':
            result = reach(values)
        elif sys.argv[1] == 'census':
            result = census(set(values))
        else:
            raise ValueError()
        print(json.dumps(result))
        return 0
    except Exception:
        print('provider-boundary-peer-refused:observation', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
