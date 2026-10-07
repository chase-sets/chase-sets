import importlib.util
import io
from pathlib import Path
import sys
import unittest
from contextlib import redirect_stderr
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('r3', Path(__file__).with_name('r3-stimulus.py'))
r3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r3)


class R3Fixtures(unittest.TestCase):
    def test_mutation_refuses_source_drift_before_starting_a_child(self):
        source = mock.Mock(read_text=mock.Mock(return_value='SYNTHETIC_DRIFT'))
        absent = mock.Mock(exists=mock.Mock(return_value=False), is_symlink=mock.Mock(return_value=False))
        with mock.patch.object(r3, 'regular'), mock.patch.object(r3, 'INSTALLER', source), mock.patch.object(r3, 'BACKUP', absent), mock.patch.object(r3, 'HEADER_BACKUP', absent), mock.patch.object(r3, 'SCRIPT', absent), mock.patch.object(r3.subprocess, 'Popen') as spawn:
            with self.assertRaises(ValueError):
                r3.mutate('apply')
        spawn.assert_not_called()
        absent.open.assert_not_called()

    def test_restore_never_overwrites_a_present_profile(self):
        present = mock.Mock(exists=mock.Mock(return_value=True))
        backup = mock.Mock()
        with mock.patch.object(r3, 'regular'), mock.patch.object(r3, 'PROFILE', present), mock.patch.object(r3, 'BACKUP', backup):
            with self.assertRaises(ValueError):
                r3.mutate('restore')
        backup.rename.assert_not_called()

    def test_errors_and_arguments_remain_closed(self):
        for action in ('apply', 'SYNTHETIC_PRIVATE'):
            error = io.StringIO()
            with mock.patch.object(r3.os, 'getuid', return_value=0, create=True), mock.patch.object(sys, 'argv', ['r3-stimulus.py', action]), mock.patch.object(r3, 'mutate', side_effect=OSError('SYNTHETIC_PRIVATE')):
                with redirect_stderr(error):
                    self.assertEqual(r3.main(), 1)
            self.assertEqual(error.getvalue(), 'provider-boundary-r3-stimulus-refused:mutation\n')


if __name__ == '__main__':
    unittest.main()
