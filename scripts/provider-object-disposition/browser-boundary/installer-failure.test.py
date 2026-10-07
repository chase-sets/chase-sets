import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('installer_failure', Path(__file__).with_name('installer-failure.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallerFailureFixtures(unittest.TestCase):
    def test_one_expected_stage_changes_not_native_command_or_inventory(self):
        source = Path(__file__).with_name('install-ci.sh').read_text()
        changed = module.synthetic_source(source)
        self.assertEqual(changed.replace('refusal mapping-write direct_probe', 'refusal arguments direct_probe'), source)
        for source in ('', source + source):
            with self.assertRaises(ValueError):
                module.synthetic_source(source)

    def test_full_original_status_and_output_are_required(self):
        stdout = module.expected_output(1001, 1001)
        stderr = b'provider-boundary-installer-refused:negative-mapping-write-output\n'
        self.assertEqual(len(b'provider-boundary-refused:arguments\n'), 36)
        # Byte count is the exact original native refusal, not a display truncation.
        self.assertTrue(module.check_failure(subprocess.CompletedProcess([], 1, stdout, stderr), 1001, 1001))
        for code, out, err in ((0, stdout, stderr), (78, stdout, stderr), (1, stdout + b'extra', stderr),
                               (1, b'SYNTHETIC_PRIVATE' + stdout, stderr), (1, stdout, stderr + b'SYNTHETIC_PRIVATE'), (1, stdout.replace(b'status=78', b'status=143'), stderr)):
            self.assertFalse(module.check_failure(subprocess.CompletedProcess([], code, out, err), 1001, 1001))


if __name__ == '__main__':
    unittest.main()
