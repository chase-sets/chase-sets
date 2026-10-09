"""Synthetic /proc transitions, not native Linux feasibility evidence."""
from contextlib import ExitStack, redirect_stderr, redirect_stdout
import errno
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.dont_write_bytecode = True
import ownership

spec = importlib.util.spec_from_file_location('variants', Path(__file__).with_name('native-variants.py'))
variants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(variants)


def process_stat(pid, state='S', parent=1, start=100):
    fields = [state, str(parent)] + ['0'] * 50
    fields[19] = str(start)
    return f'{pid} (SYNTHETIC_PRIVATE) ' + ' '.join(fields) + '\n'


class ProcRace:
    """PID 91 exits at one chosen metadata read, after its initial stat."""
    def __init__(self, field='exe-stat', terminal='Z', parent=1, start=100,
                 code=errno.ENOENT, root=False):
        self.field, self.terminal = field, terminal
        self.parent, self.start, self.code, self.root = parent, start, code, root
        self.raced = False
        self.passes = 0

    def entries(self, _path):
        self.raced = False
        self.passes += 1
        entries = mock.MagicMock()
        entries.__enter__.return_value = [SimpleNamespace(name=str(pid)) for pid in ([10, 91] if self.root else [91])]
        return entries

    def fail(self, field, pid):
        if pid == 91 and field == self.field:
            self.raced = True
            raise OSError(self.code, 'SYNTHETIC_PRIVATE')

    def read(self, path):
        if path.name == 'installation.h':
            return '#define ADMITTED_UID 1001\n'
        pid = int(path.parent.name)
        if path.name == 'stat':
            if pid == 91 and self.raced:
                if self.terminal == 'absent':
                    raise ProcessLookupError(errno.ESRCH, 'SYNTHETIC_PRIVATE')
                if self.terminal == 'malformed':
                    return 'SYNTHETIC_PRIVATE'
                return process_stat(pid, self.terminal, self.parent, self.start)
            return process_stat(pid)
        self.fail('status', pid)
        return 'Uid:\t1001\t1001\t1001\t1001\n'

    def link(self, path):
        if str(path) == '/proc/self/ns/pid':
            return 'pid:[1]'
        pid = int(path.parts[2])
        self.fail('namespace' if path.name == 'pid' else 'exe-link', pid)
        if pid == 91 and self.field == 'complete' and path.name == 'exe':
            self.raced = True
        return 'pid:[1]' if path.name == 'pid' else '/usr/local/lib/chase-sets-provider-window/launcher'

    def image(self, path):
        if path.name == 'launcher':
            return SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFREG)
        self.fail('exe-stat', int(path.parent.name))
        return SimpleNamespace(st_dev=1, st_ino=2)

    def install(self, stack):
        stack.enter_context(mock.patch.object(ownership.os, 'scandir', side_effect=self.entries))
        stack.enter_context(mock.patch.object(ownership, 'bounded_read', side_effect=self.read))
        stack.enter_context(mock.patch.object(ownership.os, 'readlink', side_effect=self.link))
        stack.enter_context(mock.patch.object(ownership.Path, 'stat', autospec=True, side_effect=self.image))
        stack.enter_context(mock.patch.object(ownership.Path, 'is_symlink', return_value=False))
        stack.enter_context(mock.patch.object(ownership.time, 'monotonic', return_value=0))
        stack.enter_context(mock.patch.object(ownership.time, 'sleep'))


class OwnershipRaceFixtures(unittest.TestCase):
    def test_same_identity_exit_at_each_metadata_read_is_gone(self):
        for field in ('status', 'namespace', 'exe-stat', 'exe-link'):
            for terminal in ('Z', 'X', 'absent'):
                with self.subTest(field=field, terminal=terminal), ExitStack() as stack:
                    ProcRace(field=field, terminal=terminal).install(stack)
                    self.assertEqual(ownership.snapshot(), {})

    def test_unexplained_live_reparented_replaced_and_malformed_processes_refuse(self):
        for change in ({'terminal': 'S'}, {'parent': 2}, {'start': 101}, {'terminal': 'malformed'}):
            for field in ('status', 'namespace', 'exe-stat', 'exe-link'):
                with self.subTest(change=change, field=field), ExitStack() as stack:
                    ProcRace(field=field, **change).install(stack)
                    with self.assertRaises(ownership.CensusError):
                        ownership.snapshot()

    def test_permission_errors_are_not_exit_evidence_even_if_stat_disappears(self):
        for terminal in ('Z', 'absent'):
            with self.subTest(terminal=terminal), ExitStack() as stack:
                ProcRace(code=errno.EACCES, terminal=terminal).install(stack)
                with self.assertRaises(ownership.CensusError):
                    ownership.snapshot()

    def test_complete_metadata_does_not_hide_reparenting_or_pid_reuse(self):
        for change in ({'parent': 2}, {'start': 101}):
            with self.subTest(change=change), ExitStack() as stack:
                ProcRace(field='complete', terminal='S', **change).install(stack)
                with self.assertRaises(ownership.CensusError):
                    ownership.snapshot()

    def test_exited_parent_does_not_hide_a_surviving_namespace_member(self):
        with ExitStack() as stack:
            ProcRace(root=True).install(stack)
            records = ownership.snapshot()
        records[92] = dict(pid=92, parent=91, start=101, uid=1001,
                           image=(2, 3), namespace='pid:[2]', path='/browser/chrome')
        self.assertEqual(ownership.classify({}, records, 1001, (1, 2), 'pid:[1]', 1), ownership.ORPHAN)

    def test_owned_command_survives_unrelated_exit_without_losing_live_launcher(self):
        output, error = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            ProcRace(root=True).install(stack)
            stack.enter_context(mock.patch.object(variants.os, 'getuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(sys, 'argv', ['native-variants.py', 'owned', '10']))
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(variants.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), [{'pid': 10, 'parent': 1, 'start': 100, 'image': 'launcher'}])
        self.assertEqual(error.getvalue(), '')

    def test_owned_command_keeps_closed_refusal_for_unexplained_exit(self):
        output, error = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            ProcRace(root=True, start=101).install(stack)
            stack.enter_context(mock.patch.object(variants.os, 'getuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(sys, 'argv', ['native-variants.py', 'owned', '10']))
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(variants.main(), 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(error.getvalue(), 'provider-boundary-variant-refused:owned\n')

    def test_remove_census_requires_two_complete_empty_passes_after_exit(self):
        with ExitStack() as stack:
            race = ProcRace()
            race.install(stack)
            self.assertEqual(ownership.census(), 'none')
            self.assertEqual(race.passes, 2)


if __name__ == '__main__':
    unittest.main()
