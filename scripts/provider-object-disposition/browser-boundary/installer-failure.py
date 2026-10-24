"""Whole installed I route with one explicitly synthetic expected-stage mismatch."""
import os
from pathlib import Path
import re
import subprocess
import sys

TARGET = Path('/usr/local/lib/chase-sets-provider-window')
SOURCE = Path('/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/install-ci.sh')
SYNTHETIC = SOURCE.with_name('SYNTHETIC_INSTALLER_NEGATIVE_CONTROL.sh')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
       'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'ImageOS': 'ubuntu24'}


def synthetic_source(source):
    original = 'refusal arguments direct_probe -u "$principal" -- "$target/launcher" /bin/sh "$source_digest"'
    if source.count(original) != 1:
        raise ValueError()
    return source.replace(original, original.replace('refusal arguments', 'refusal mapping-write'))


def expected_output(uid, gid):
    before = ''.join('provider-boundary-installer-stage:' + mark + '\n' for mark in
                     ('source-location', 'resolve-browser', 'resolve-principal', 'administrator-binding'))
    before += f'provider-boundary-administrator:uid={uid},gid={gid},sudo=true\n'
    before += ''.join('provider-boundary-installer-stage:' + mark + '\n' for mark in
                      ('create-installation', 'copy-inputs', 'resolve-dependencies', 'private-root-files',
                       'build-inventory', 'build-launcher', 'load-profile'))
    return (before + 'provider-boundary-installer-stage:negative-arguments\n'
                'provider-boundary-control:mapping-write,status=78,bytes=36,redacted=true,truncated=false\n'
                'provider-boundary-control-actual:mapping-write,native-stage=arguments\n').encode()


def check_failure(result, uid, gid):
    return (result.returncode == 1 and result.stdout == expected_output(uid, gid) and
            result.stderr == b'provider-boundary-installer-refused:negative-mapping-write-output\n' and
            b'provider-boundary-installer-stage:complete\n' not in result.stdout)


def main():
    import pwd
    stage = 'arguments'
    owned = None
    try:
        if os.getuid() != 0 or len(sys.argv) != 3:
            raise ValueError()
        browser = Path(sys.argv[1])
        if not browser.is_absolute() or browser.resolve(strict=True) != browser or not browser.is_dir():
            raise ValueError()
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', sys.argv[2]):
            raise ValueError()
        ENV['ImageVersion'] = sys.argv[2]
        header = (TARGET / 'source/browser-boundary/installation.h').read_text()
        uid = re.findall(r'^#define ADMITTED_UID ([0-9]+)$', header, re.M)
        if len(uid) != 1 or int(uid[0]) == 0:
            raise ValueError()
        account = pwd.getpwuid(int(uid[0]))
        principal = account.pw_name
        source = SOURCE.read_text()
        changed = synthetic_source(source)
        stage = 'remove-existing'
        removed = subprocess.run(['/bin/bash', str(SOURCE), 'remove'], env=ENV, capture_output=True, timeout=5)
        expected = ''.join('provider-boundary-installer-stage:' + mark + '\n' for mark in
                           ('source-location', 'remove-ownership', 'remove-profile', 'remove-target', 'complete'))
        if removed.returncode != 0 or removed.stdout != expected.encode() or removed.stderr:
            raise ValueError()
        stage = 'exclusive-script'
        fd = os.open(SYNTHETIC, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(changed)
            stream.flush()
            os.fsync(stream.fileno())
            info = os.fstat(stream.fileno())
            owned = (info.st_dev, info.st_ino)
        stage = 'execute-negative'
        result = subprocess.run(['/bin/bash', str(SYNTHETIC), 'install', principal, str(browser)],
                                env=ENV, capture_output=True, timeout=120)
        if not check_failure(result, account.pw_uid, account.pw_gid):
            raise ValueError()
        print('provider-boundary-whole-installer:synthetic-negative;installer=1;native=78;stage=negative-mapping-write-output;exact=true')
        return 0
    except Exception:
        print('provider-boundary-whole-installer-refused:' + stage, file=sys.stderr)
        return 1
    finally:
        if owned is not None:
            try:
                info = SYNTHETIC.lstat()
                if (info.st_dev, info.st_ino) == owned and not SYNTHETIC.is_symlink():
                    SYNTHETIC.unlink()
            except OSError:
                print('provider-boundary-whole-installer-refused:script-cleanup', file=sys.stderr)


if __name__ == '__main__':
    sys.exit(main())
