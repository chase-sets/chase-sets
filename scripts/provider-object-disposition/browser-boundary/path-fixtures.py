"""Execute shipped R1 code, rebinding only fixed names to an owned synthetic tree.

There is no production path override. Shell effect doubles are sentinels, not
realpath doubles: crossing R1 into census/deletion makes the assertion fail.
"""
from pathlib import Path
import subprocess
import tempfile


def observe(name, mutation=None):
    with tempfile.TemporaryDirectory(prefix='SYNTHETIC-R1-') as directory:
        root = Path(directory).resolve()
        real = root / 'real'
        real.mkdir()
        alias = root / 'alias'
        alias.symlink_to(real, target_is_directory=True)
        for member in ('target', 'input'):
            (real / member).mkdir()
        target = alias / 'target' if name == 'target' else real / 'target'
        input_path = alias / 'input' if name == 'input' else real / 'input'
        candidate = target if name == 'target' else input_path
        assert candidate.exists() and not candidate.is_symlink() and candidate.resolve(strict=True) != candidate
        script = 'install-ci.sh' if name == 'target' else 'ci-cleanup.sh'
        source = Path(__file__).with_name(script).read_text()
        # Full shipped control flow, not a copied predicate. Exact-name rebinding
        # is confined to this unprivileged fixture copy, never the installed API.
        bindings = {
            '/usr/local/lib/chase-sets-provider-window-input': str(input_path),
            '/usr/local/lib/chase-sets-provider-window': str(target),
            '/etc/apparmor.d/chase-sets-provider-window': str(real / 'profile'),
        }
        for original, owned in bindings.items():
            if name == 'target' and original.endswith('-input'):
                continue
            assert original in source
            source = source.replace(original, owned)
        variable = 'target' if name == 'target' else 'input'
        stage = 'remove-target-path' if name == 'target' else 'input-path'
        predicate = f'require {stage} test "$(realpath -e -- "${variable}")" = "${variable}"'
        assert predicate in source
        if mutation == 'realpath-only':
            source = source.replace(predicate, ': # SYNTHETIC realpath-only bypass')
        elif mutation == 'order-only':
            anchor = '  require remove-target-symlink' if name == 'target' else 'require input-not-symlink'
            assert anchor in source
            source = source.replace(anchor, 'printf "SYNTHETIC_EFFECT:early-census-or-deletion\\n"\n' + anchor, 1)
        sentinels = '''
id() { printf '0\\n'; }
timeout() { printf 'SYNTHETIC_EFFECT:census\\n' >&2; return 91; }
sudo() { printf 'SYNTHETIC_EFFECT:installer-or-deletion\\n' >&2; return 92; }
rm() { printf 'SYNTHETIC_EFFECT:deletion\\n' >&2; return 93; }
'''
        file = root / script
        file.write_text(source.replace('set -Eeuo pipefail', 'set -Eeuo pipefail\n' + sentinels, 1))
        result = subprocess.run(['/bin/bash', str(file), *(['remove'] if name == 'target' else [])],
                                capture_output=True, timeout=3, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        emitter = 'installer' if name == 'target' else 'cleanup'
        exact = (result.returncode == 1 and result.stderr == f'provider-boundary-{emitter}-refused:{stage}\n'.encode()
                 and b'SYNTHETIC_EFFECT' not in result.stdout + result.stderr
                 and b'remove-ownership' not in result.stdout and b'remove-profile' not in result.stdout
                 and b'remove-input' not in result.stdout and b'remove-installation' not in result.stdout)
        assert target.is_dir() and input_path.is_dir()
        return exact


def controls():
    for name in ('target', 'input'):
        assert observe(name), name
        assert not observe(name, 'realpath-only'), name
        assert not observe(name, 'order-only'), name


if __name__ == '__main__':
    controls()
    print('provider-boundary-owned-realpath:target-input-refusal-order-bypass:PASS')
