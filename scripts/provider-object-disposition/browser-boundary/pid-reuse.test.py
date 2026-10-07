import errno
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from contextlib import ExitStack, redirect_stdout, redirect_stderr
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('reuse', Path(__file__).with_name('pid-reuse.py'))
reuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reuse)


class PidReuseFixtures(unittest.TestCase):
    def test_readonly_sysctl_is_not_constructed_not_pass_and_spawns_nothing(self):
        output, error = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(reuse.os, 'getuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(sys, 'argv', ['pid-reuse.py', '91', '100']))
            stack.enter_context(mock.patch.object(reuse, 'identity', side_effect=FileNotFoundError()))
            stack.enter_context(mock.patch.object(reuse, 'bounded_read', return_value='#define ADMITTED_UID 1001\n#define ADMITTED_GID 1001\n'))
            stack.enter_context(mock.patch.object(reuse.ctypes, 'CDLL', return_value=mock.Mock(prctl=mock.Mock(return_value=0))))
            stack.enter_context(mock.patch.object(reuse.Path, 'write_text', side_effect=OSError(errno.EROFS, 'SYNTHETIC_PRIVATE')))
            spawn = stack.enter_context(mock.patch.object(reuse.subprocess, 'Popen'))
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(reuse.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {'constructed': False, 'reason': 'EROFS', 'attempts': 1})
        self.assertEqual(error.getvalue(), '')
        spawn.assert_not_called()

    def test_a_still_live_original_identity_refuses_before_any_sysctl_write(self):
        error = io.StringIO()
        with mock.patch.object(reuse.os, 'getuid', return_value=0, create=True), mock.patch.object(sys, 'argv', ['pid-reuse.py', '91', '100']), mock.patch.object(reuse, 'identity', return_value={'start': 100}), mock.patch.object(reuse.Path, 'write_text') as write:
            with redirect_stderr(error):
                self.assertEqual(reuse.main(), 1)
        write.assert_not_called()
        self.assertEqual(error.getvalue(), 'provider-boundary-pid-reuse-refused:old-identity\n')

    def test_eight_misses_retire_every_generated_process_without_a_ninth_attempt(self):
        output, error = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(reuse.os, 'getuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(sys, 'argv', ['pid-reuse.py', '91', '100']))
            stack.enter_context(mock.patch.object(reuse, 'identity', side_effect=[FileNotFoundError()] + [{'start': 200}] * 8))
            stack.enter_context(mock.patch.object(reuse, 'bounded_read', return_value='#define ADMITTED_UID 1001\n#define ADMITTED_GID 1001\n'))
            stack.enter_context(mock.patch.object(reuse.ctypes, 'CDLL', return_value=mock.Mock(prctl=mock.Mock(return_value=0))))
            write = stack.enter_context(mock.patch.object(reuse.Path, 'write_text'))
            stack.enter_context(mock.patch.object(reuse.subprocess, 'Popen', return_value=mock.Mock(pid=92)))
            stack.enter_context(mock.patch.object(reuse.os, 'pidfd_open', return_value=7, create=True))
            retired = stack.enter_context(mock.patch.object(reuse, 'retire'))
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(reuse.main(), 0)
        self.assertEqual(write.call_count, 8)
        self.assertEqual(retired.call_count, 8)
        self.assertEqual(json.loads(output.getvalue()), {'constructed': False, 'reason': 'attempts-exhausted', 'attempts': 8})
        self.assertEqual(error.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
