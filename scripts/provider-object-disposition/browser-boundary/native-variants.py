"""Closed hosted synthetic builds and read-only process observations, outside the workload root."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
from ownership import snapshot, bounded_read, parse_stat

TARGET = Path('/usr/local/lib/chase-sets-provider-window')
BACKUP = TARGET / 'synthetic-original'
SOURCE = TARGET / 'source/browser-boundary/launcher.c'
HEADER = TARGET / 'source/browser-boundary/installation.h'
NAMES = ('launcher', 'launcher.sha256', 'files.sha256', 'source.sha256')
stage = 'arguments'


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError()
    return source.replace(old, new)


def variant(source, name):
    if name == 'direct-clients':
        source = replace_once(source, '#include <net/if.h>', '#include <net/if.h>\n#include <arpa/inet.h>')
        source = replace_once(source, 'int main(int argc, char **argv) {', Path(__file__).with_name('native-egress.c').read_text() + '\nint main(int argc, char **argv) {')
        return replace_once(source, '            no_network();\n            _exit(0);', '            no_network();\n            synthetic_egress();\n            _exit(0);')
    if name in ('ready-outer', 'ready-nested'):
        source = replace_once(source, 'seed_main(int guardian)', 'seed_main(int guardian, bool nested)')
        source = replace_once(source, 'seed_main(guardian);', 'seed_main(guardian, nested);')
        condition = 'nested' if name.endswith('nested') else '!nested'
        return replace_once(source, '    seed_fence();', f'    seed_fence();\n    if ({condition}) for (;;) syscall(SYS_pause);')
    if name in ('reap-outer', 'reap-nested'):
        signal = '(nested ? 0 : SIGKILL)' if name.endswith('nested') else '(nested ? SIGKILL : 0)'
        return replace_once(source, 'SYS_pidfd_send_signal, seedfd, SIGKILL, NULL, 0', f'SYS_pidfd_send_signal, seedfd, {signal}, NULL, 0')
    if name == 'map-write':
        return replace_once(source, '    seed_map(seed, "uid_map", mapping);', '    seed_map(seed, "uid_map", mapping);\n    seed_map(seed, "uid_map", mapping);')
    if name == 'b3-failure':
        return replace_once(source, 'require(ancestry, "namespace-identity");', 'require(false && ancestry, "namespace-identity");')
    if name == 'ancestry':
        source = replace_once(source, '#include <sys/mount.h>', '#include <sys/mount.h>\n#include <sys/mman.h>')
        source = replace_once(source, 'static int active_seed = -1;', 'static int active_seed = -1;\nstatic volatile int *synthetic_nested;')
        begin = source.index('static void seed_main(')
        end = source.index('static void seed_map(', begin)
        source = source[:begin] + '''static void seed_main(int guardian) {
    struct pollfd parent = {guardian, POLLIN, 0};
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || poll(&parent, 1, 0) != 0 ||
        syscall(SYS_close_range, 0, ~0U, 0) != 0 || prctl(PR_SET_DUMPABLE, 1) != 0) _exit(78);
    (void)seed_fence;
    const char *paths[] = {"/proc/self/setgroups", "/proc/self/uid_map", "/proc/self/gid_map"};
    char uid[80], gid[80];
    snprintf(uid, sizeof(uid), "%u %u 1\\n", ADMITTED_UID, ADMITTED_UID);
    snprintf(gid, sizeof(gid), "%u %u 1\\n", ADMITTED_GID, ADMITTED_GID);
    const char *values[] = {"deny\\n", uid, gid};
    for (int i = 0; i < 3; i++) {
        int fd = open(paths[i], O_WRONLY | O_CLOEXEC);
        if (fd < 0 || write(fd, values[i], strlen(values[i])) != (ssize_t)strlen(values[i])) _exit(78);
        close(fd);
    }
    if (unshare(CLONE_NEWUSER) != 0 || prctl(PR_SET_DUMPABLE, 1) != 0) _exit(78);
    *synthetic_nested = 1;
    for (;;) pause();
}

''' + source[end:]
        source = replace_once(source, 'static void join_seed(bool nested) {', '''static void join_seed(bool nested) {
    synthetic_nested = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    require(synthetic_nested != MAP_FAILED, "namespace-seed");''')
        source = replace_once(source, '        if (ready.st_uid == ADMITTED_UID) break;', '        if (ready.st_uid == ADMITTED_UID && *synthetic_nested == 1) break;')
        begin = source.index('    seed_map(seed, "setgroups", "deny\\n");')
        end = source.index('    snprintf(path, sizeof(path), "/proc/%d/ns/user", seed);', begin)
        source = source[:begin] + '    (void)seed_map;\n' + source[end:]
        return source
    if name.startswith('sf-'):
        calls = {
            'open': 'syscall(SYS_openat, AT_FDCWD, "/tmp/SYNTHETIC_HELPER", O_RDONLY, 0)',
            'socket': 'syscall(SYS_socket, AF_UNIX, SOCK_STREAM, 0)',
            'connect': 'syscall(SYS_connect, -1, NULL, 0)',
            'recvmsg': 'syscall(SYS_recvmsg, -1, NULL, 0)',
            'setns': 'syscall(SYS_setns, -1, CLONE_NEWUSER)',
            'unshare': 'syscall(SYS_unshare, CLONE_NEWUSER)',
            'mount': 'syscall(SYS_mount, NULL, NULL, NULL, 0, NULL)',
            'clone': 'syscall(SYS_clone3, NULL, 0)',
            'prctl': 'syscall(SYS_prctl, PR_SET_DUMPABLE, 0, 0, 0, 0)',
            'x32': 'syscall(0x40000000 | SYS_pause)',
        }
        call = calls[name[3:]]
        source = replace_once(source, '    for (;;) syscall(SYS_pause);', f'    {call};\n    for (;;) syscall(SYS_pause);')
        observation = '''
    struct pollfd synthetic_dead = {seedfd, POLLIN, 0};
    siginfo_t synthetic_status = {0};
    int synthetic_poll = poll(&synthetic_dead, 1, 1000);
    int synthetic_wait = waitid(P_PIDFD, seedfd, &synthetic_status, WEXITED | WNOHANG | WNOWAIT);
    dprintf(STDOUT_FILENO, "SYNTHETIC_SF:%d:%d:%d:%d\\n", synthetic_poll, synthetic_wait, synthetic_status.si_code, synthetic_status.si_status);
    require(synthetic_poll == 1 && synthetic_wait == 0 &&
            (synthetic_status.si_code == CLD_KILLED || synthetic_status.si_code == CLD_DUMPED) &&
            synthetic_status.si_status == SIGSYS, "namespace-seed");
    dprintf(STDOUT_FILENO, "SYNTHETIC_SF:SIGSYS\\n");'''
        return replace_once(source, '    active_seed = seedfd;', '    active_seed = seedfd;' + observation)
    match = re.fullmatch(r'stall-(outer|nested)-B([1-6])', name)
    if match:
        source = replace_once(source, 'static int active_seed = -1;', 'static int active_seed = -1;\nstatic bool synthetic_probe;')
        source = replace_once(source, '    bool probe = strcmp(argv[1], "probe") == 0;', '    bool probe = strcmp(argv[1], "probe") == 0;\n    synthetic_probe = probe;')
        anchors = {
            '1': '    active_seed = seedfd;',
            '2': '    seed_map(seed, "setgroups", "deny\\n");',
            '3': '    snprintf(path, sizeof(path), "/proc/%d/ns/user", seed);',
            '4': '    require(setns(user, CLONE_NEWUSER) == 0, "user-namespace");',
            '5': '    exact_map("uid_map", mapping);',
            '6': '    require(syscall(SYS_pidfd_send_signal, seedfd, SIGKILL, NULL, 0) == 0, "seed-reap");',
        }
        anchor = anchors[match[2]]
        condition = 'nested' if match[1] == 'nested' else '!nested'
        stall = f'    if (synthetic_probe && {condition}) {{ dprintf(STDOUT_FILENO, "SYNTHETIC_TRANSITION:{name}\\n"); for (;;) pause(); }}'
        return replace_once(source, anchor, anchor + '\n' + stall if match[2] == '1' else stall + '\n' + anchor)
    raise ValueError()


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or path.resolve(strict=True) != path:
        raise ValueError()
    return info


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def apply(name):
    global stage
    stage = 'rewrite'
    original = SOURCE.read_text()
    changed = variant(original, name)
    if BACKUP.exists() or BACKUP.is_symlink():
        raise ValueError()
    for name in NAMES:
        regular(TARGET / name)
    regular(SOURCE)
    regular(HEADER)
    stage = 'backup'
    BACKUP.mkdir(mode=0o700)
    for name in NAMES:
        shutil.copy2(TARGET / name, BACKUP / name)
        info = (TARGET / name).stat()
        os.chown(BACKUP / name, info.st_uid, info.st_gid)
    shutil.copy2(SOURCE, BACKUP / 'launcher.c')
    shutil.copy2(HEADER, BACKUP / 'installation.h')
    stage = 'inventory'
    SOURCE.write_text(changed)
    installer = (TARGET / 'source/browser-boundary/install-ci.sh').read_text()
    sources = re.search(r'^sources=\(([^)]+)\)$', installer, re.M)[1].split()
    source_digest = hashlib.sha256(''.join(f'{digest(TARGET / "source" / name)}  {name}\n' for name in sources).encode()).hexdigest()
    entries = []
    for line in (BACKUP / 'files.sha256').read_text().splitlines():
        path = Path(line[66:])
        if not path.is_relative_to(TARGET) or path.resolve(strict=True) != path:
            raise ValueError()
        entries.append(f'{digest(path)}  {path}\n')
    (TARGET / 'files.sha256').write_text(''.join(entries))
    header = (BACKUP / 'installation.h').read_text()
    header = re.sub(r'#define SOURCE_DIGEST "[a-f0-9]{64}"', f'#define SOURCE_DIGEST "{source_digest}"', header)
    header = re.sub(r'#define FILES_DIGEST "[a-f0-9]{64}"', f'#define FILES_DIGEST "{digest(TARGET / "files.sha256")}"', header)
    HEADER.write_text(header)
    stage = 'compile'
    result = subprocess.run(['/usr/bin/gcc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-static', str(SOURCE), '-o', str(TARGET / 'launcher.synthetic'), '-lcrypto', '-ldl', '-pthread'], capture_output=True, timeout=10, check=False)
    if result.returncode != 0:
        raise ValueError()
    stage = 'publish'
    gid = int(re.search(r'^#define ADMITTED_GID (\d+)$', header, re.M)[1])
    os.chown(TARGET / 'launcher.synthetic', 0, gid)
    os.chmod(TARGET / 'launcher.synthetic', 0o750)
    os.replace(TARGET / 'launcher.synthetic', TARGET / 'launcher')
    (TARGET / 'launcher.sha256').write_text(digest(TARGET / 'launcher') + '\n')
    (TARGET / 'source.sha256').write_text(source_digest + '\n')
    print(json.dumps({'sourceDigest': source_digest, 'launcherDigest': digest(TARGET / 'launcher')}))


def restore():
    global stage
    stage = 'restore'
    if BACKUP.resolve(strict=True) != BACKUP or not BACKUP.is_dir():
        raise ValueError()
    for name in (*NAMES, 'launcher.c', 'installation.h'):
        regular(BACKUP / name)
    for name in NAMES:
        os.replace(BACKUP / name, TARGET / name)
    os.replace(BACKUP / 'launcher.c', SOURCE)
    os.replace(BACKUP / 'installation.h', HEADER)
    if (TARGET / 'launcher.synthetic').exists():
        regular(TARGET / 'launcher.synthetic')
        (TARGET / 'launcher.synthetic').unlink()
    BACKUP.rmdir()
    print('provider-boundary-variant:restored')


def owned(ancestor):
    global stage
    stage = 'owned'
    records = snapshot()
    selected = {ancestor}
    for _ in range(len(records)):
        found = {pid for pid, record in records.items() if record['parent'] in selected}
        if found <= selected:
            break
        selected |= found
    result = []
    for pid in sorted(selected):
        record = records.get(pid)
        if record is not None:
            image = Path(record['path']).name
            if pid == ancestor or image in ('launcher', 'chrome', 'chrome_crashpad_handler'):
                result.append({**{key: record[key] for key in ('pid', 'parent', 'start')},
                               'image': image if image in ('launcher', 'chrome', 'chrome_crashpad_handler') else 'caller'})
    print(json.dumps(result))


def namespaces(text):
    global stage
    stage = 'owned'
    if len(text) > 16384 or not re.fullmatch(r'[0-9]+:[0-9]+(?:,[0-9]+:[0-9]+)*', text):
        raise ValueError()
    owners = [tuple(map(int, item.split(':'))) for item in text.split(',')]
    if len(owners) > 256:
        raise ValueError()
    found = set()
    unknown = 0
    for pid, start in owners:
        try:
            before = parse_stat(bounded_read(Path('/proc') / str(pid) / 'stat'), pid)
            if before['start'] != start:
                unknown += 1
                continue
            fd = os.open(f'/proc/{pid}/ns/user', os.O_RDONLY | os.O_CLOEXEC)
            try:
                info = os.fstat(fd)
                after = parse_stat(bounded_read(Path('/proc') / str(pid) / 'stat'), pid)
                if after['start'] == start:
                    found.add((info.st_dev, info.st_ino))
                else:
                    unknown += 1
            finally:
                os.close(fd)
        except OSError:
            unknown += 1
    print(json.dumps({'namespaces': sorted(found), 'unknown': unknown}))


def crash_observation(text):
    global stage
    stage = 'owned'
    if len(text) > 16384 or not re.fullmatch(r'[0-9]+:[0-9]+(?:,[0-9]+:[0-9]+)*', text):
        raise ValueError()
    owners = [tuple(map(int, item.split(':'))) for item in text.split(',')]
    if len(owners) > 256:
        raise ValueError()
    result = []
    for pid, start in owners:
        try:
            path = Path('/proc') / str(pid)
            before = parse_stat(bounded_read(path / 'stat'), pid)
            if before['start'] != start:
                result.append({'pid': pid, 'start': start, 'observation': 'gone'})
                continue
            status = bounded_read(path / 'status')
            cmdline = bounded_read(path / 'cmdline')
            core = re.findall(r'^CoreDumping:\s+([01])$', status, re.M)
            tracer = re.findall(r'^TracerPid:\s+([0-9]+)$', status, re.M)
            after = parse_stat(bounded_read(path / 'stat'), pid)
            if after['start'] != start or len(tracer) != 1:
                raise ValueError()
            result.append({'pid': pid, 'start': start, 'observation': 'present',
                           'renderer': '--type=renderer' in cmdline.split('\0'),
                           'coreDumping': int(core[0]) if len(core) == 1 else None,
                           'traced': int(tracer[0]) != 0,
                           'state': after['state'] if after['state'] in ('R', 'S', 'D', 'T', 't', 'Z', 'I') else 'other'})
        except OSError as error:
            if error.errno not in (2, 3):
                raise
            try:
                current = parse_stat(bounded_read(Path('/proc') / str(pid) / 'stat'), pid)
            except OSError as gone:
                if gone.errno not in (2, 3):
                    raise
                current = None
            if current is not None and current['start'] == start:
                raise ValueError()
            result.append({'pid': pid, 'start': start, 'observation': 'gone'})
    print(json.dumps(result))


def main():
    try:
        if os.getuid() != 0:
            raise ValueError()
        if len(sys.argv) == 3 and sys.argv[1] == 'apply':
            apply(sys.argv[2])
        elif sys.argv[1:] == ['restore']:
            restore()
        elif len(sys.argv) == 3 and sys.argv[1] == 'owned' and re.fullmatch(r'[1-9][0-9]*', sys.argv[2]):
            owned(int(sys.argv[2]))
        elif len(sys.argv) == 3 and sys.argv[1] == 'namespaces':
            namespaces(sys.argv[2])
        elif len(sys.argv) == 3 and sys.argv[1] == 'crash-observation':
            crash_observation(sys.argv[2])
        else:
            raise ValueError()
        return 0
    except Exception:
        print('provider-boundary-variant-refused:' + stage, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
