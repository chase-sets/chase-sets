import errno
import importlib.util
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock
from contextlib import ExitStack, redirect_stdout, redirect_stderr

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('owner_stimulus', Path(__file__).with_name('ownership-stimulus.py'))
stimulus = importlib.util.module_from_spec(spec)
with mock.patch.dict(sys.modules, {'resource': SimpleNamespace(RLIMIT_NOFILE=7, RLIMIT_NPROC=6, getrlimit=lambda _: (1024, 1024))}):
    spec.loader.exec_module(stimulus)


class OwnershipStimulusFixtures(unittest.TestCase):
    def run_cap(self, cleanup_fails):
        output, error = io.StringIO(), io.StringIO()
        process = mock.Mock(pid=42)
        process.wait.return_value = -9
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(stimulus.os, 'getuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(stimulus.os, 'O_CLOEXEC', 0o2000000, create=True))
            stack.enter_context(mock.patch.object(stimulus.os, 'pidfd_open', return_value=7, create=True))
            stack.enter_context(mock.patch.object(stimulus.signal, 'SIGKILL', 9, create=True))
            stack.enter_context(mock.patch.object(stimulus.os, 'open', side_effect=[6, OSError(errno.EMFILE, 'SYNTHETIC_PRIVATE')]))
            closed = stack.enter_context(mock.patch.object(stimulus.os, 'close'))
            stack.enter_context(mock.patch.object(stimulus.signal, 'pidfd_send_signal', side_effect=OSError(errno.EPERM, 'SYNTHETIC_PRIVATE') if cleanup_fails else None, create=True))
            spawned = stack.enter_context(mock.patch.object(stimulus.subprocess, 'Popen', return_value=process))
            stack.enter_context(mock.patch.object(stimulus, 'principal', return_value=(1001, 1001)))
            stack.enter_context(mock.patch.object(stimulus, 'process_count', return_value=0))
            stack.enter_context(mock.patch.object(sys, 'argv', ['ownership-stimulus.py', 'cap']))
            with redirect_stdout(output), redirect_stderr(error):
                status = stimulus.main()
            self.assertEqual(spawned.call_args.args[0], ['/bin/sleep', '30'])
            self.assertEqual(spawned.call_args.kwargs['env'], stimulus.ENV)
            self.assertIn(mock.call(6), closed.call_args_list)
        self.assertNotIn('SYNTHETIC_PRIVATE', output.getvalue() + error.getvalue())
        return status, output.getvalue(), error.getvalue()

    def test_unconstructed_cap_is_explicit_and_its_generated_child_is_retired(self):
        status, output, error = self.run_cap(False)
        self.assertEqual(status, 0)
        self.assertIn('"constructed": false', output)
        self.assertIn('"reason": "EMFILE"', output)
        self.assertTrue(output.endswith('provider-boundary-owner-stimulus:retired\n'))
        self.assertEqual(error, '')

    def test_cleanup_failure_cannot_inherit_a_prior_nonconstruction_success_status(self):
        status, output, error = self.run_cap(True)
        self.assertEqual(status, 1)
        self.assertNotIn('provider-boundary-owner-stimulus:retired', output)
        self.assertEqual(error, 'provider-boundary-owner-stimulus-refused:retirement\n')


if __name__ == '__main__':
    unittest.main()
