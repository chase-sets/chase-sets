import importlib.util
import io
from pathlib import Path
import sys
import unittest
from contextlib import redirect_stderr
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('paths', Path(__file__).with_name('path-stimulus.py'))
paths = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paths)


class PathStimulusFixtures(unittest.TestCase):
    def fixture(self):
        path, backup = mock.Mock(), mock.Mock()
        path.name = 'SYNTHETIC'
        path.with_name.return_value = backup
        path.parent.resolve.return_value = path.parent
        path.resolve.return_value = path
        path.lstat.return_value = mock.Mock(st_uid=0, st_mode=0o40755)
        backup.exists.return_value = False
        backup.is_symlink.return_value = False
        return path, backup

    def test_exclusive_backup_collision_never_moves_the_installation(self):
        path, backup = self.fixture()
        backup.exists.return_value = True
        with mock.patch.dict(paths.PATHS, {'target': path}):
            with self.assertRaises(ValueError):
                paths.mutate('target', 'apply')
        path.rename.assert_not_called()

    def test_link_failure_restores_the_exact_original_name(self):
        path, backup = self.fixture()
        path.symlink_to.side_effect = OSError('SYNTHETIC_PRIVATE')
        with mock.patch.dict(paths.PATHS, {'target': path}):
            with self.assertRaises(OSError):
                paths.mutate('target', 'apply')
        path.rename.assert_called_once_with(backup)
        backup.rename.assert_called_once_with(path)

    def test_restoration_does_not_unlink_an_unexpected_target(self):
        path, backup = self.fixture()
        path.is_symlink.return_value = True
        with mock.patch.dict(paths.PATHS, {'target': path}), mock.patch.object(paths.os, 'readlink', return_value='SYNTHETIC_UNRELATED'):
            with self.assertRaises(ValueError):
                paths.mutate('target', 'restore')
        path.unlink.assert_not_called()
        backup.rename.assert_not_called()

    def test_ungranted_path_and_private_error_emit_only_closed_refusal(self):
        for args in (['SYNTHETIC_PRIVATE', 'apply'], ['target', 'apply']):
            error = io.StringIO()
            with mock.patch.object(paths.os, 'getuid', return_value=0, create=True), mock.patch.object(sys, 'argv', ['path-stimulus.py', *args]), mock.patch.object(paths, 'mutate', side_effect=OSError('SYNTHETIC_PRIVATE')):
                with redirect_stderr(error):
                    self.assertEqual(paths.main(), 1)
            self.assertEqual(error.getvalue(), 'provider-boundary-path-stimulus-refused:mutation\n')


if __name__ == '__main__':
    unittest.main()
