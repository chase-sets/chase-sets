import importlib.util
from pathlib import Path
import unittest
import sys
import io
import json
import errno
import os
import re
import subprocess
import tempfile
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from unittest import mock

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('ownership', Path(__file__).with_name('ownership.py'))
ownership = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ownership)
observer_spec = importlib.util.spec_from_file_location('observer', Path(__file__).with_name('observe.py'))
observer = importlib.util.module_from_spec(observer_spec)
observer_spec.loader.exec_module(observer)
stimulus_spec = importlib.util.spec_from_file_location('stimulus', Path(__file__).with_name('hosted-stimulus.py'))
stimulus = importlib.util.module_from_spec(stimulus_spec)
stimulus_spec.loader.exec_module(stimulus)


def record(pid=20, parent=1, start=100, uid=1001, image=(1, 2), namespace='pid:[1]', path='/usr/local/lib/chase-sets-provider-window/launcher'):
    return dict(pid=pid, parent=parent, start=start, uid=uid, image=image, namespace=namespace, path=path)


def classify(previous, current):
    return ownership.classify(previous, current, 1001, (1, 2), 'pid:[1]', 1)


class OwnershipControls(unittest.TestCase):
    def diagnostic(self, previous, current):
        detail = []
        outcome = ownership._classify(previous, current, 1001, (1, 2), 'pid:[1]', 1, detail)
        self.assertEqual(outcome, classify(previous, current))
        return outcome, detail

    def test_same_read_first_predicate_with_frozen_selection_bypass(self):
        unrelated = record(image=(2, 3), path='/SYNTHETIC_PRIVATE/argv')
        member = dict(unrelated, namespace='pid:[2]')
        # Non-candidate start/image drift (S11, S7, S7/S8, S9) is not a refusal.
        flipped = [({20: unrelated}, {20: dict(unrelated, start=101)}),
                   ({20: unrelated}, {20: dict(unrelated, image=(2, 4))}),
                   ({20: unrelated}, {20: dict(unrelated, image=None)}),
                   ({20: dict(unrelated, image=None)}, {20: unrelated})]
        schedules = [
            ('identity-drift', {20: member}, {20: dict(member, start=101)}),
            ('identity-drift', {20: member}, {20: dict(member, image=(2, 4))}),
            ('identity-drift', {20: member}, {20: dict(member, image=None)}),
            ('identity-drift', {20: dict(member, image=None)}, {20: member}),
            ('parent-order', {}, {21: record(pid=21, parent=20, start=99), 20: record()}),
            ('foreign-image', {}, {20: record(image=(1, 3))}),
            ('member-cycle', {}, {20: record(parent=21, namespace='pid:[2]'),
                                  21: record(pid=21, parent=20, namespace='pid:[2]')}),
        ]
        for ambient in ({}, {'CI': 'true', 'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                            'BOUNDARY_DIAGNOSTIC': '13c-alone', 'ImageOS': 'ubuntu24'}):
            with mock.patch.dict(os.environ, ambient, clear=True):
                for predicate, previous, current in schedules:
                    with self.subTest(predicate=predicate, current=current, ambient=ambient):
                        with mock.patch.object(ownership, 'snapshot', side_effect=AssertionError('no rescan')):
                            outcome, detail = self.diagnostic(previous, current)
                        self.assertEqual(outcome, ownership.AMBIGUOUS)
                        self.assertEqual(len(detail), 1)
                        self.assertIsNotNone(ownership.removal_witness(detail[0]))
                        self.assertIn(f';predicate={predicate};'.encode(), detail[0])
                        self.assertNotIn(b'SYNTHETIC_PRIVATE', detail[0])
                        with mock.patch.object(ownership, 'witness_record', return_value=None) as bypass:
                            mutant_outcome, mutant_detail = self.diagnostic(previous, current)
                        bypass.assert_called_once()
                        self.assertEqual(mutant_outcome, outcome)
                        self.assertIsNone(mutant_detail[0])
                self.assertEqual(self.diagnostic({20: unrelated}, {20: unrelated}), ('none', []))
                for previous, current in flipped:
                    with self.subTest(flipped=current, ambient=ambient):
                        self.assertEqual(self.diagnostic(previous, current), ('none', []))

    def test_witness_keeps_iteration_and_predicate_precedence(self):
        previous = {21: record(pid=21)}
        # Both records refuse; the first foreign image wins, not the later drift.
        current = {20: record(image=(1, 3)), 21: record(pid=21, start=101)}
        self.assertIn(b'predicate=foreign-image;', self.diagnostic(previous, current)[1][0])
        self.assertIn(b'predicate=identity-drift;', self.diagnostic(previous, dict(reversed(list(current.items()))))[1][0])
        # On one record drift precedes both parent inversion and foreign image.
        current = {21: record(pid=21, parent=20, start=99, image=(1, 3)), 20: record()}
        self.assertIn(b'predicate=identity-drift;', self.diagnostic(previous, current)[1][0])
        self.assertIn(b'predicate=parent-order;', self.diagnostic({}, current)[1][0])

    def test_witness_closed_capture_bounds_and_validation_bypass(self):
        detail = self.diagnostic({20: record()}, {20: record(start=101)})[1][0]
        capture = b'remove-ambiguous-owner\n' + detail
        self.assertEqual(ownership.validate_capture(io.BytesIO(capture)), capture)
        invalid = [detail + detail, detail[:-1], detail + b'\n', detail + b'PRIVATE',
                   detail.replace(b'v1;', b'v2;'), detail.replace(b'records=20', b'records=020'),
                   detail.replace(b'start-drift=1', b'start-drift=0'), detail.replace(b'initial', b'PRIVATE'),
                   detail.replace(b';chain-length=0', b';extra=1;chain-length=0'),
                   detail.replace(b',100,', b',18446744073709551616,'), b'x' * 1025,
                   detail.replace(b',100,', b',1e2,'), detail.replace(b',launcher', b',none')]
        for line in invalid:
            with self.subTest(line=line):
                self.assertIsNone(ownership.removal_witness(line))
                self.assertIsNone(ownership.validate_capture(io.BytesIO(b'remove-ambiguous-owner\n' + line)))
        for data in (b'', b'none', b'none\n\n', b'none\n' + detail, b'none\x00\n',
                     b'remove-ambiguous-owner\n', b'PRIVATE\n' + capture, capture + b'PRIVATE'):
            self.assertIsNone(ownership.validate_capture(io.BytesIO(data)))
        malformed = detail.replace(b'start-drift=1', b'start-drift=0')
        with mock.patch.object(ownership, 'removal_witness', side_effect=lambda data: data) as bypass:
            self.assertIsNotNone(ownership.validate_capture(io.BytesIO(b'remove-ambiguous-owner\n' + malformed)))
        bypass.assert_called_once_with(malformed)
        maximum = record(start=2**64 - 1, image=(2**64 - 1, 2**64 - 1))
        self.assertIsNotNone(self.diagnostic({20: record()}, {20: maximum})[1][0])
        cycle = ownership.witness_record('member-cycle', (record(),), 1001, (1, 2), 'pid:[1]', 1, 20, 4096)
        self.assertIsNotNone(cycle)
        self.assertIsNone(ownership.removal_witness(cycle.replace(b'4096', b'4097')))

    def test_only_propagated_ambiguity_emits_detail_and_success_is_silent(self):
        for current, outcome in (({}, 'none'), ({20: record()}, ownership.LIVE),
                                 ({20: record(namespace='pid:[2]')}, ownership.ORPHAN)):
            self.assertEqual(self.diagnostic({}, current), (outcome, []))
        detail = self.diagnostic({20: record()}, {20: record(start=101)})[1][0]
        for outcome, records, expected in [('none', [], 'none\n'),
                                          (ownership.AMBIGUOUS, [detail], 'remove-ambiguous-owner\n' + detail.decode()),
                                          (ownership.AMBIGUOUS, [None], 'remove-ambiguous-owner\n'),
                                          (ownership.CENSUS, [detail], 'remove-ownership-census\n')]:
            def census(sink):
                sink.extend(records)
                return outcome
            output, error = io.StringIO(), io.StringIO()
            with mock.patch.object(ownership, '_census', side_effect=census), mock.patch.object(ownership.os, 'getuid', return_value=0, create=True), mock.patch.object(sys, 'argv', ['ownership.py']), redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(ownership.main(), 0 if outcome == 'none' else 1)
            self.assertEqual(output.getvalue(), expected)
            self.assertEqual(error.getvalue(), '')

    def test_census_transports_only_first_propagated_same_read_witness(self):
        schedules = [
            ([{20: record()}, {20: record(start=101)}], ownership.AMBIGUOUS, 1),
            ([{20: record(image=(1, 3))}, {}, {}], 'none', 0),
        ]
        for snapshots, outcome, count in schedules:
            with ExitStack() as stack:
                stack.enter_context(mock.patch.object(ownership.Path, 'is_symlink', return_value=False))
                stack.enter_context(mock.patch.object(ownership.Path, 'stat', return_value=mock.Mock(st_mode=0o100755, st_dev=1, st_ino=2)))
                stack.enter_context(mock.patch.object(ownership, 'bounded_read', return_value='#define ADMITTED_UID 1001\n'))
                stack.enter_context(mock.patch.object(ownership.os, 'readlink', return_value='pid:[1]'))
                stack.enter_context(mock.patch.object(ownership.time, 'monotonic', return_value=0))
                stack.enter_context(mock.patch.object(ownership.time, 'sleep'))
                read = stack.enter_context(mock.patch.object(ownership, 'snapshot', side_effect=snapshots))
                detail = []
                self.assertEqual(ownership._census(detail), outcome)
                self.assertEqual(len(detail), count)
                self.assertEqual(read.call_count, len(snapshots))

    def test_installer_capture_executes_whole_shell_with_closed_detail(self):
        # Synthetic fixed-name copies, never a production path override or process census.
        shell = r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else '/bin/bash'
        shell_path = lambda value: re.sub(r'^([A-Za-z]):', lambda m: '/' + m[1].lower(), Path(value).as_posix())
        with tempfile.TemporaryDirectory(prefix='SYNTHETIC-witness-') as directory:
            root = Path(directory).resolve()
            source = root / 'browser-boundary'
            source.mkdir()
            target, profile, effects = root / 'target', root / 'profile', root / 'effects'
            target.mkdir()
            profile.write_text('SYNTHETIC_PROFILE')
            # Match the deployed Linux stream framing when the fixture runs on Windows.
            (source / 'ownership.py').write_text("import sys; sys.stdout.reconfigure(newline='\\n')\n" + Path(ownership.__file__).read_text())
            installer = Path(ownership.__file__).with_name('install-ci.sh').read_text()
            installer = installer.replace('/usr/local/lib/chase-sets-provider-window', shell_path(target))
            installer = installer.replace('/etc/apparmor.d/chase-sets-provider-window', shell_path(profile))
            installer = installer.replace('/usr/bin/python3', 'python' if os.name == 'nt' else 'python3')
            sentinels = f'''
id() {{ printf '0\\n'; }}
timeout() {{ cat '{shell_path(root / 'output')}'; return "$(cat '{shell_path(root / 'status')}')"; }}
rm() {{ printf 'SYNTHETIC_DELETE\\n' >> '{shell_path(effects)}'; return 91; }}
'''
            installer = installer.replace('set -Eeuo pipefail', 'set -Eeuo pipefail\n' + sentinels, 1)
            script = source / 'install-ci.sh'
            script.write_text(installer)
            witness = self.diagnostic({}, {20: record(image=(1, 3))})[1][0]
            capture = b'remove-ambiguous-owner\n' + witness
            for output, status, stage in [(capture, 1, ownership.AMBIGUOUS),
                                          (capture, 0, ownership.CENSUS), (capture, 78, ownership.CENSUS),
                                          (capture[:-1], 1, ownership.CENSUS), (capture + b'\x00', 1, ownership.CENSUS),
                                          (capture + b'PRIVATE', 1, ownership.CENSUS),
                                          (capture + witness, 1, ownership.CENSUS),
                                          (b'x' * 2048, 1, ownership.CENSUS), (b'none\n', 1, ownership.CENSUS),
                                          (b'remove-live-owner\n', 1, ownership.LIVE),
                                          (b'remove-orphan-owner\n', 1, ownership.ORPHAN)]:
                with self.subTest(status=status, stage=stage, output=output):
                    (root / 'output').write_bytes(output)
                    (root / 'status').write_text(str(status))
                    result = subprocess.run([shell, shell_path(script), 'remove'], capture_output=True)
                    expected = (witness if stage == ownership.AMBIGUOUS else b'') + f'provider-boundary-installer-refused:{stage}\n'.encode()
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stderr, expected)
                    self.assertEqual(result.stdout, b'provider-boundary-installer-stage:source-location\nprovider-boundary-installer-stage:remove-ownership\n')
                    self.assertTrue(target.is_dir() and profile.is_file())
                    self.assertFalse(effects.exists())

    def test_13g_disappeared_records_still_obey_the_pass_deadline(self):
        entries = mock.MagicMock()
        entries.__enter__.return_value = [mock.Mock(name='entry')]
        entries.__enter__.return_value[0].name = '91'
        with mock.patch.object(ownership.os, 'scandir', return_value=entries), mock.patch.object(ownership, 'bounded_read', side_effect=FileNotFoundError(errno.ENOENT, 'SYNTHETIC_PRIVATE')), mock.patch.object(ownership.time, 'monotonic', side_effect=[0, 0, 0, 1.001, 1.001]):
            with self.assertRaises(ownership.CensusError):
                ownership.snapshot()

    def test_13g_census_cap_refuses_before_reading_any_process(self):
        entries = mock.MagicMock()
        entries.__enter__.return_value = [type('Entry', (), {'name': str(pid)})() for pid in range(1, 4098)]
        with mock.patch.object(ownership.os, 'scandir', return_value=entries), mock.patch.object(ownership.time, 'monotonic', return_value=0), mock.patch.object(ownership, 'bounded_read') as read:
            with self.assertRaises(ownership.CensusError):
                ownership.snapshot()
            read.assert_not_called()

    def test_13g_unreadable_status_or_namespace_is_not_a_missing_process(self):
        entries = mock.MagicMock()
        entries.__enter__.return_value = [type('Entry', (), {'name': '91'})()]
        fields = ['S', '17'] + ['0'] * 50
        fields[19] = '12345'
        stat = '91 (synthetic) ' + ' '.join(fields) + '\n'
        for field in ('status', 'namespace'):
            def read(path):
                if path.name == 'stat':
                    return stat
                if field == 'status':
                    raise PermissionError(errno.EACCES, 'SYNTHETIC_PRIVATE')
                return 'Uid:\t1001\t1001\t1001\t1001\n'
            with mock.patch.object(ownership.os, 'scandir', return_value=entries), mock.patch.object(ownership, 'bounded_read', side_effect=read), mock.patch.object(ownership.os, 'readlink', side_effect=PermissionError(errno.EACCES, 'SYNTHETIC_PRIVATE')):
                with self.assertRaises(ownership.CensusError):
                    ownership.snapshot()

    def test_13g_empty_pass_still_obeys_deadline(self):
        entries = mock.MagicMock()
        entries.__enter__.return_value = []
        with mock.patch.object(ownership.os, 'scandir', return_value=entries), mock.patch.object(ownership.time, 'monotonic', side_effect=[0, 1.001]):
            with self.assertRaises(ownership.CensusError):
                ownership.snapshot()

    def test_13g_missing_stat_within_budget_is_absent(self):
        entries = mock.MagicMock()
        entries.__enter__.return_value = [type('Entry', (), {'name': '91'})()]
        for code in (errno.ENOENT, errno.ESRCH):
            with mock.patch.object(ownership.os, 'scandir', return_value=entries), mock.patch.object(ownership, 'bounded_read', side_effect=OSError(code, 'SYNTHETIC_PRIVATE')), mock.patch.object(ownership.time, 'monotonic', return_value=0):
                self.assertEqual(ownership.snapshot(), {})

    def test_missing_key_stimulus_preserves_an_exclusive_exact_restoration_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            header = Path(directory) / 'installation.h'
            backup = header.with_name('installation.h.original')
            original = b'#define ADMITTED_UID 1001\n#define ADMITTED_GID 1001\n'
            header.write_bytes(original)
            with mock.patch.object(stimulus, 'HEADER', header), mock.patch.object(stimulus, 'BACKUP', backup), mock.patch.object(stimulus, 'regular', return_value=mock.Mock(st_mode=0o100644)):
                stimulus.missing_key('apply')
                self.assertEqual(header.read_bytes(), b'#define ADMITTED_GID 1001\n')
                self.assertEqual(backup.read_bytes(), original)
                with self.assertRaises(ValueError):
                    stimulus.missing_key('apply')
                self.assertEqual(backup.read_bytes(), original)
                stimulus.missing_key('restore')
                self.assertEqual(header.read_bytes(), original)
                self.assertFalse(backup.exists())

    def test_missing_or_duplicate_uid_is_not_a_valid_stimulus(self):
        for original in (b'#define ADMITTED_GID 1001\n', b'#define ADMITTED_UID 1001\n' * 2):
            with tempfile.TemporaryDirectory() as directory:
                header = Path(directory) / 'installation.h'
                backup = header.with_name('installation.h.original')
                header.write_bytes(original)
                with mock.patch.object(stimulus, 'HEADER', header), mock.patch.object(stimulus, 'BACKUP', backup), mock.patch.object(stimulus, 'regular'):
                    with self.assertRaises(ValueError):
                        stimulus.missing_key('apply')
                self.assertEqual(header.read_bytes(), original)
                self.assertFalse(backup.exists())

    def test_stimulus_errors_and_arguments_are_closed(self):
        for action in ('apply', 'PRIVATE'):
            output, error = io.StringIO(), io.StringIO()
            with mock.patch.object(stimulus.os, 'getuid', return_value=0, create=True), mock.patch.object(sys, 'argv', ['hosted-stimulus.py', action]), mock.patch.object(stimulus, 'missing_key', side_effect=OSError('PRIVATE_PATH')):
                with redirect_stdout(output), redirect_stderr(error):
                    self.assertEqual(stimulus.main(), 1)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(error.getvalue(), 'provider-boundary-stimulus-refused:missing-key\n')

    def test_n2_own_pid_parent_and_start_are_distinct(self):
        fields = ['S', '17'] + ['0'] * 50
        fields[19] = '12345'
        actual = ownership.parse_stat('91 (name ) with spaces) ' + ' '.join(fields) + '\n', 91)
        self.assertEqual((actual['pid'], actual['parent'], actual['start']), (91, 17, 12345))

    def test_truncated_stat_and_wrong_pid_refuse(self):
        for text in ['91 (name) S 17 0\n', '92 (name) S 17\n', '']:
            with self.assertRaises(ownership.CensusError):
                ownership.parse_stat(text, 91)

    def test_13a_none(self):
        self.assertEqual(classify({}, {}), 'none')

    def test_13b_live(self):
        root = record()
        child = record(pid=21, parent=20, start=101, namespace='pid:[2]')
        self.assertEqual(classify({}, {20: root, 21: child}), ownership.LIVE)

    def test_13c_orphan_precedes_live(self):
        self.assertEqual(classify({}, {20: record(), 21: record(pid=21, namespace='pid:[2]')}), ownership.ORPHAN)

    def test_13e_foreign_image_precedes_live(self):
        self.assertEqual(classify({}, {20: record(), 21: record(pid=21, image=(1, 3))}), ownership.AMBIGUOUS)

    def test_13f_pid_reuse_and_image_drift(self):
        for changed in [record(start=101), record(image=(1, 3))]:
            self.assertEqual(classify({20: record()}, {20: changed}), ownership.AMBIGUOUS)

    def test_13f_parent_start_inversion(self):
        self.assertEqual(classify({}, {20: record(), 21: record(pid=21, parent=20, start=99)}), ownership.AMBIGUOUS)

    def test_disappeared_identity_does_not_authorize_signalling(self):
        self.assertEqual(classify({20: record()}, {}), 'none')
        self.assertFalse(hasattr(ownership, 'kill'))

    def test_unrelated_host_process_is_not_an_owner(self):
        self.assertEqual(classify({}, {20: record(image=(2, 3), path='/usr/bin/sleep')}), 'none')

    def test_observer_census_exception_is_a_closed_refusal_not_a_traceback(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(observer, 'snapshot', side_effect=observer.CensusError('PRIVATE')):
            with mock.patch.object(observer.os, 'getuid', return_value=0, create=True):
                with mock.patch.object(sys, 'argv', ['observe.py', '123']):
                    with redirect_stdout(output), redirect_stderr(error):
                        self.assertEqual(observer.main(), 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(error.getvalue(), 'provider-boundary-observer-refused:census\nprovider-boundary-observer-detail:none:unknown\n')

    def observer_read_failure(self, stage, failure, current=None, stat_error=None, image=(1, 2), image_error=None, preceding=False):
        status = ''.join(f'{key}:\t0\n' for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp'))
        records = {20: record(), 21: record(pid=21)}
        if preceding:
            records[19] = record(pid=19)
        current = dict(start=100, parent=1, state='S') | (current or {})
        inspected = []
        def fail():
            if observer.stage == stage:
                raise failure
        def text(path):
            if '20' in path.parts:
                if stage == 'status-field' and path.name == 'status':
                    return 'PRIVATE'
                fail()
            return status if path.name == 'status' else 'chase-sets-provider-window (unconfined)'
        def link(path):
            if '20' in Path(path).parts:
                fail()
            return 'SYNTHETIC_NAMESPACE'
        def scope(selected, owner):
            if selected['pid'] == 20:
                fail()
            return 'launch'
        def root(selected, census):
            inspected.append(selected['pid'])
            if selected['pid'] == 20:
                fail()
            return dict(hostHelper=False, oldRootDetached=True, rootObservation='path-checked')
        def identity(selected):
            if selected['pid'] == 20 and stage == 'identity-recheck':
                if failure is None:
                    return False
                fail()
            return True
        output, error = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(observer.os, 'getuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(sys, 'argv', ['observe.py', '1']))
            stack.enter_context(mock.patch.object(observer, 'snapshot', return_value=records))
            stack.enter_context(mock.patch.object(observer.Path, 'read_text', autospec=True, side_effect=text))
            stack.enter_context(mock.patch.object(observer.os, 'readlink', side_effect=link))
            stack.enter_context(mock.patch.object(observer, 'launch_owner', return_value=record()))
            stack.enter_context(mock.patch.object(observer, 'user_namespace_scope', side_effect=scope))
            stack.enter_context(mock.patch.object(observer, 'inspect_root', side_effect=root))
            stack.enter_context(mock.patch.object(observer, 'same_identity', side_effect=identity))
            stack.enter_context(mock.patch.object(observer, 'bounded_read', side_effect=stat_error, return_value='SYNTHETIC_STAT'))
            stack.enter_context(mock.patch.object(observer, 'parse_stat', return_value=current))
            stack.enter_context(mock.patch.object(observer.Path, 'stat', side_effect=image_error, return_value=mock.Mock(st_dev=image[0], st_ino=image[1])))
            with redirect_stdout(output), redirect_stderr(error):
                result = observer.main()
        return result, output.getvalue(), error.getvalue(), inspected

    def assert_observer_omits(self, stage, failure, **recheck):
        result, output, error, inspected = self.observer_read_failure(stage, failure, **recheck)
        self.assertEqual(result, 0, error)
        self.assertEqual(error, '')
        self.assertEqual(json.loads(output), [dict(pid=21, parent=1, start=100, image='launcher',
                         **{key: '0' for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp')},
                         label='expected', network='host', pidNamespace='host', userNamespace='launch',
                         hostHelper=False, oldRootDetached=True, rootObservation='path-checked')])
        self.assertIn(21, inspected)

    def test_observer_omits_zombie_at_namespaces(self):
        self.assert_observer_omits('namespaces', OSError(errno.ENOENT, 'PRIVATE'), current={'state': 'Z'})

    def test_observer_omits_reaped_process_at_status(self):
        for code in (errno.ENOENT, errno.ESRCH):
            with self.subTest(code=code):
                self.assert_observer_omits('status', OSError(errno.ENOENT, 'PRIVATE'), stat_error=OSError(code, 'PRIVATE'))

    def test_observer_omits_zombie_at_identity_recheck(self):
        self.assert_observer_omits('identity-recheck', None, current={'state': 'Z'})

    def test_observer_omits_changed_start_time(self):
        for stage in ('status', 'label', 'namespaces', 'user-namespace', 'identity-recheck'):
            with self.subTest(stage=stage):
                self.assert_observer_omits(stage, OSError(errno.ENOENT, 'PRIVATE'), current={'start': 101})

    def test_observer_live_read_failures_keep_exact_stage_errno_and_no_partial_records(self):
        for stage in ('status', 'label', 'namespaces', 'user-namespace', 'identity-recheck'):
            for code, label in ((errno.EACCES, 'EACCES'), (errno.EPERM, 'EPERM'), (errno.ENOENT, 'ENOENT'),
                                (errno.ESRCH, 'ESRCH'), (errno.ENOTDIR, 'ENOTDIR'), (errno.ELOOP, 'ELOOP'),
                                (errno.EIO, 'EIO'), (123456, 'other')):
                with self.subTest(stage=stage, code=code):
                    result, output, error, _ = self.observer_read_failure(stage, OSError(code, 'PRIVATE', 'PRIVATE_PATH'))
                    self.assertEqual(result, 1)
                    self.assertEqual(output, '')
                    self.assertEqual(error, f'provider-boundary-observer-refused:{stage}\nprovider-boundary-observer-detail:{label}:same\n')
                    self.assertNotIn('PRIVATE', error)

    def test_observer_live_image_and_parent_drift_still_refuse(self):
        for recheck in ({'current': {'parent': 2}}, {'image': (1, 3)}):
            with self.subTest(recheck=recheck):
                result, output, error, _ = self.observer_read_failure('identity-recheck', None, **recheck)
                self.assertEqual(result, 1)
                self.assertEqual(output, '')
                self.assertEqual(error, 'provider-boundary-observer-refused:identity-recheck\nprovider-boundary-observer-detail:none:changed\n')

    def test_observer_refusal_after_a_complete_record_emits_no_partial_records(self):
        result, output, error, inspected = self.observer_read_failure('namespaces', OSError(errno.EACCES, 'PRIVATE'), preceding=True)
        self.assertEqual(inspected, [19])
        self.assertEqual(result, 1)
        self.assertEqual(output, '')
        self.assertEqual(error, 'provider-boundary-observer-refused:namespaces\nprovider-boundary-observer-detail:EACCES:same\n')

    def test_observer_ambiguous_recheck_never_proves_disappearance(self):
        for failure in (OSError(errno.EACCES, 'PRIVATE'), OSError(errno.EIO, 'PRIVATE'),
                        ValueError('PRIVATE'), observer.CensusError('PRIVATE'), KeyError('PRIVATE')):
            with self.subTest(failure=type(failure), code=getattr(failure, 'errno', None)):
                result, output, error, _ = self.observer_read_failure('namespaces', OSError(errno.ENOENT, 'PRIVATE'), stat_error=failure)
                self.assertEqual(result, 1)
                self.assertEqual(output, '')
                self.assertEqual(error, 'provider-boundary-observer-refused:namespaces\nprovider-boundary-observer-detail:ENOENT:unknown\n')

    def test_observer_non_os_errors_keep_stage_and_identity(self):
        for failure in (ValueError('PRIVATE'), KeyError('PRIVATE'), observer.CensusError('PRIVATE')):
            with self.subTest(failure=type(failure)):
                result, output, error, _ = self.observer_read_failure('label', failure)
                self.assertEqual(result, 1)
                self.assertEqual(output, '')
                self.assertEqual(error, 'provider-boundary-observer-refused:label\nprovider-boundary-observer-detail:none:same\n')

    def test_observer_unreadable_image_is_not_missing_stat_proof(self):
        for code in (errno.ENOENT, errno.ESRCH, errno.EACCES):
            with self.subTest(code=code):
                result, output, error, _ = self.observer_read_failure('namespaces', OSError(errno.ENOENT, 'PRIVATE'), image_error=OSError(code, 'PRIVATE'))
                self.assertEqual(result, 1)
                self.assertEqual(output, '')
                self.assertEqual(error, 'provider-boundary-observer-refused:namespaces\nprovider-boundary-observer-detail:ENOENT:unknown\n')

    def test_observer_malformed_status_still_refuses_even_after_exit(self):
        for current, identity in (({}, 'same'), ({'state': 'Z'}, 'zombie'), ({'start': 101}, 'changed')):
            with self.subTest(current=current):
                result, output, error, _ = self.observer_read_failure('status-field', None, current=current)
                self.assertEqual(result, 1)
                self.assertEqual(output, '')
                self.assertEqual(error, f'provider-boundary-observer-refused:status-field\nprovider-boundary-observer-detail:none:{identity}\n')

    def test_observer_root_stage_never_omits_a_vanished_record(self):
        for failure in (OSError(errno.ENOENT, 'PRIVATE'), ValueError('PRIVATE'), KeyError('PRIVATE'), observer.CensusError('PRIVATE')):
            with self.subTest(failure=type(failure)):
                result, output, error, inspected = self.observer_read_failure('root', failure, stat_error=OSError(errno.ENOENT, 'PRIVATE'))
                self.assertEqual(result, 1)
                self.assertEqual(output, '')
                self.assertEqual(error, 'provider-boundary-observer-refused:root\n')
                self.assertEqual(inspected, [20])

    def test_observer_descendant_cap_refuses_without_a_selected_record(self):
        records = {pid: record(pid=pid, parent=pid - 1) for pid in range(2, 67)}
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(observer, 'snapshot', return_value=records), mock.patch.object(observer.os, 'getuid', return_value=0, create=True), mock.patch.object(sys, 'argv', ['observe.py', '1']):
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(observer.main(), 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(error.getvalue(), 'provider-boundary-observer-refused:descendants\nprovider-boundary-observer-detail:none:unknown\n')

    def test_observer_argument_refusal_does_not_echo_argv(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['observe.py', 'PRIVATE']):
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(observer.main(), 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(error.getvalue(), 'provider-boundary-observer-refused:arguments\nprovider-boundary-observer-detail:none:unknown\n')

    def test_observer_identity_drift_after_root_inspection_publishes_no_partial_records(self):
        status = ''.join(f'{key}:\t0\n' for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp'))
        output, error = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(observer.os, 'getuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(sys, 'argv', ['observe.py', '1']))
            stack.enter_context(mock.patch.object(observer, 'snapshot', return_value={20: record()}))
            stack.enter_context(mock.patch.object(observer.Path, 'read_text', autospec=True, side_effect=lambda p: status if p.name == 'status' else 'chase-sets-provider-window (unconfined)'))
            stack.enter_context(mock.patch.object(observer.os, 'readlink', return_value='SYNTHETIC_NAMESPACE'))
            stack.enter_context(mock.patch.object(observer, 'launch_owner', return_value=record()))
            stack.enter_context(mock.patch.object(observer, 'user_namespace_scope', return_value='launch'))
            stack.enter_context(mock.patch.object(observer, 'inspect_root', return_value={}))
            stack.enter_context(mock.patch.object(observer, 'same_identity', return_value=False))
            stack.enter_context(mock.patch.object(observer, 'bounded_read', return_value='SYNTHETIC_LIVE_STAT'))
            stack.enter_context(mock.patch.object(observer, 'parse_stat', return_value=dict(start=100, parent=1, state='S')))
            stack.enter_context(mock.patch.object(observer.Path, 'stat', return_value=mock.Mock(st_dev=1, st_ino=3)))
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(observer.main(), 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(error.getvalue(), 'provider-boundary-observer-refused:identity-recheck\nprovider-boundary-observer-detail:none:changed\n')

    def test_observer_root_error_retains_closed_identity_path_kind_and_errno(self):
        for kind in ('host-helper', 'old-root'):
            for code, label in ((errno.EACCES, 'EACCES'), (errno.EPERM, 'EPERM'), (123456, 'other')):
                with self.subTest(kind=kind, code=code):
                    path = mock.Mock()
                    path.exists.side_effect = OSError(code, 'PRIVATE', 'PRIVATE_PATH')
                    output, error = io.StringIO(), io.StringIO()
                    with mock.patch.object(observer, 'observe', side_effect=lambda _: observer.root_exists(path, record(), kind)), mock.patch.object(observer, 'root_recheck', return_value='same:proc-fdinfo:directory:none'):
                        with mock.patch.object(observer.os, 'getuid', return_value=0, create=True):
                            with mock.patch.object(sys, 'argv', ['observe.py', '123']):
                                with redirect_stdout(output), redirect_stderr(error):
                                    self.assertEqual(observer.main(), 1)
                    self.assertEqual(output.getvalue(), '')
                    self.assertEqual(error.getvalue(), 'provider-boundary-observer-refused:root\n' +
                                     f'provider-boundary-observer-root:20:1:100:1:2:launcher:{kind}:{label}:same:proc-fdinfo:directory:none\n')

    def test_root_recheck_distinguishes_live_identity_from_root_lookup(self):
        image = mock.Mock(st_dev=1, st_ino=2, st_mode=0o040755)
        with mock.patch.object(observer, 'bounded_read', return_value=''), mock.patch.object(observer, 'parse_stat', return_value=dict(start=100, state='S')):
            with mock.patch.object(observer.Path, 'stat', return_value=image), mock.patch.object(observer.os, 'readlink', return_value='/proc/7/fdinfo'):
                self.assertEqual(observer.root_recheck(record()), 'same:proc-fdinfo:directory:none')
            with mock.patch.object(observer.Path, 'stat', side_effect=OSError(errno.ESRCH, 'PRIVATE')), mock.patch.object(observer.os, 'readlink', side_effect=OSError(errno.EACCES, 'PRIVATE')):
                self.assertEqual(observer.root_recheck(record()), 'unknown:unreadable:unreadable:ESRCH')

    def test_root_recheck_never_emits_an_unrecognized_root_path(self):
        image = mock.Mock(st_dev=1, st_ino=2, st_mode=0o040755)
        with mock.patch.object(observer, 'bounded_read', return_value=''), mock.patch.object(observer, 'parse_stat', return_value=dict(start=101, state='S')):
            with mock.patch.object(observer.Path, 'stat', return_value=image), mock.patch.object(observer.os, 'readlink', return_value='/PRIVATE'):
                self.assertEqual(observer.root_recheck(record()), 'changed:other:directory:none')

    def test_observer_root_success_and_absence_are_unchanged(self):
        for exists in (True, False):
            path = mock.Mock()
            path.exists.return_value = exists
            self.assertEqual(observer.root_exists(path, record(), 'host-helper'), exists)

    def test_observer_root_diagnostic_rejects_unbounded_or_open_fields(self):
        for changed in (record(pid=9007199254740992), record(path='/PRIVATE'), record(start=-1)):
            with self.assertRaises(ValueError):
                observer.RootInspectionError(changed, 'host-helper', OSError(errno.EACCES, 'PRIVATE'))
        with self.assertRaises(ValueError):
            observer.RootInspectionError(record(), 'PRIVATE', OSError(errno.EACCES, 'PRIVATE'))

    def test_private_fdinfo_root_requires_owned_identity_proc_mount_and_exact_root(self):
        parent = record(path=str(observer.LAUNCHER), namespace='pid:[2]')
        chrome = record(pid=21, parent=20, start=101, image=(1, 3), path='/browser/chrome')
        for mutation in ('none', 'mount-type', 'mount-device', 'duplicate-mount', 'root-device', 'root-link', 'identity', 'unowned', 'host-init'):
            with self.subTest(mutation=mutation), ExitStack() as stack:
                mount = '30 29 0:1 / /proc rw - proc proc rw\n'
                if mutation == 'mount-type':
                    mount = mount.replace(' - proc ', ' - tmpfs ')
                if mutation == 'mount-device':
                    mount = mount.replace('0:1', '0:2')
                if mutation == 'duplicate-mount':
                    mount += mount
                records = {20: parent, 21: chrome} if mutation != 'unowned' else {21: chrome}
                link = '/proc/7/fdinfo' if mutation != 'root-link' else '/PRIVATE'
                def info(path):
                    if path == observer.LAUNCHER:
                        return mock.Mock(st_dev=1, st_ino=2)
                    return mock.Mock(st_dev=3 if mutation == 'root-device' and path.name == 'root' else 2,
                                     st_ino=4, st_mode=0o040755)
                stack.enter_context(mock.patch.object(observer.Path, 'stat', autospec=True, side_effect=info))
                stack.enter_context(mock.patch.object(observer.os, 'readlink', side_effect=lambda p: ('pid:[2]' if mutation == 'host-init' else 'pid:[1]') if str(p) == '/proc/self/ns/pid' else link))
                stack.enter_context(mock.patch.object(observer, 'same_identity', return_value=mutation != 'identity'))
                stack.enter_context(mock.patch.object(observer, 'bounded_read', return_value=mount))
                stack.enter_context(mock.patch.object(observer.os, 'major', return_value=0, create=True))
                stack.enter_context(mock.patch.object(observer.os, 'minor', return_value=1, create=True))
                self.assertEqual(observer.private_fdinfo_root(chrome, records), mutation == 'none')

    def test_private_root_never_converts_arbitrary_errno_or_missing_proof_to_absence(self):
        for code, proved in ((errno.EACCES, True), (errno.ESRCH, False), (errno.EPERM, True)):
            with self.subTest(code=code, proved=proved):
                with mock.patch.object(observer.Path, 'exists', side_effect=OSError(code, 'PRIVATE')):
                    with mock.patch.object(observer, 'root_recheck', return_value='same:proc-fdinfo:directory:none'):
                        with mock.patch.object(observer, 'private_fdinfo_root', return_value=proved):
                            with self.assertRaises(observer.RootInspectionError):
                                observer.inspect_root(record(), {})

    def test_private_fdinfo_proof_is_distinct_from_path_absence(self):
        with mock.patch.object(observer.Path, 'exists', side_effect=OSError(errno.ESRCH, 'PRIVATE')):
            with mock.patch.object(observer, 'root_recheck', return_value='same:proc-fdinfo:directory:none'):
                with mock.patch.object(observer, 'private_fdinfo_root', return_value=True):
                    self.assertEqual(observer.inspect_root(record(), {}), dict(hostHelper=False, oldRootDetached=True, rootObservation='private-proc-fdinfo'))

    def test_identity_recheck_rejects_reuse_reparent_and_executable_drift(self):
        for changes in ({}, {'start': 101}, {'parent': 2}, {'state': 'Z'}):
            current = dict(start=100, parent=1, state='S')
            current.update(changes)
            with mock.patch.object(observer, 'bounded_read', return_value=''), mock.patch.object(observer, 'parse_stat', return_value=current):
                with mock.patch.object(observer.Path, 'stat', return_value=mock.Mock(st_dev=1, st_ino=2)):
                    self.assertEqual(observer.same_identity(record()), not changes)
                with mock.patch.object(observer.Path, 'stat', return_value=mock.Mock(st_dev=1, st_ino=3)):
                    self.assertFalse(observer.same_identity(record()))

    def test_user_namespace_ancestry_is_bound_not_just_different_from_host(self):
        for chain, expected in (((2,), 'launch'), ((3, 2), 'nested'), ((1,), 'host'), ((3, 1), 'unrelated')):
            with self.subTest(chain=chain), ExitStack() as stack:
                stack.enter_context(mock.patch.object(observer.Path, 'stat', autospec=True, side_effect=lambda p: mock.Mock(st_dev=1, st_ino=1 if 'self' in p.parts else 2)))
                stack.enter_context(mock.patch.object(observer, 'same_identity', return_value=True))
                stack.enter_context(mock.patch.object(observer.os, 'O_CLOEXEC', 0, create=True))
                stack.enter_context(mock.patch.object(observer.os, 'open', return_value=100))
                stack.enter_context(mock.patch.object(observer.os, 'fstat', side_effect=lambda fd: mock.Mock(st_dev=1, st_ino=chain[fd - 100])))
                stack.enter_context(mock.patch.object(observer, 'namespace_parent', side_effect=lambda fd: fd + 1))
                close = stack.enter_context(mock.patch.object(observer.os, 'close'))
                self.assertEqual(observer.user_namespace_scope(record(), record()), expected)
                self.assertEqual(close.call_args_list, [mock.call(100 + n) for n in range(len(chain))])

    def test_user_namespace_observer_closes_handles_on_parent_refusal_and_depth_cap(self):
        for error in (OSError(errno.EPERM, 'PRIVATE'), None):
            with self.subTest(error=type(error).__name__), ExitStack() as stack:
                stack.enter_context(mock.patch.object(observer.Path, 'stat', autospec=True, side_effect=lambda p: mock.Mock(st_dev=1, st_ino=1 if 'self' in p.parts else 2)))
                stack.enter_context(mock.patch.object(observer, 'same_identity', return_value=True))
                stack.enter_context(mock.patch.object(observer.os, 'O_CLOEXEC', 0, create=True))
                stack.enter_context(mock.patch.object(observer.os, 'open', return_value=100))
                stack.enter_context(mock.patch.object(observer.os, 'fstat', return_value=mock.Mock(st_dev=1, st_ino=3)))
                stack.enter_context(mock.patch.object(observer, 'namespace_parent', side_effect=error or (lambda fd: fd + 1)))
                close = stack.enter_context(mock.patch.object(observer.os, 'close'))
                with self.assertRaises(OSError if error else ValueError):
                    observer.user_namespace_scope(record(), record())
                self.assertEqual(close.call_args_list, [mock.call(100 + n) for n in range(1 if error else 33)])


def alive(**fields):
    return dict(record(**fields), state='S', kernel=False)


def zombie(process, **fields):
    return {**process, 'state': 'Z', 'image': None, 'path': '', **fields}


INSTALLED = ownership.TARGET.as_posix()
ROOT = alive(pid=10)
MEMBER = alive(pid=31, parent=10, start=101, image=(9, 3), namespace='pid:[2]', path='/usr/bin/SYNTHETIC_MEMBER')
FOREIGN = alive(pid=77, uid=0, start=400, image=(9, 5), path='/usr/bin/SYNTHETIC_FOREIGN')
RUNNER = alive(pid=40, start=300, image=(9, 7), path='/usr/bin/SYNTHETIC_RUNNER')
STATELESS = {key: value for key, value in zombie(ROOT).items() if key != 'state'}

# #10023 FINAL rows the predicate changes: (row, previous, current, FINAL).
CHANGED = [
    ('S1 foreign alive->zombie', {77: FOREIGN}, {77: zombie(FOREIGN)}, 'none'),
    ('S2 foreign fork->exec', {77: FOREIGN}, {77: dict(FOREIGN, image=(9, 6), path='/usr/bin/SYNTHETIC_EXEC')}, 'none'),
    ('S3 member alive->zombie', {10: ROOT, 31: MEMBER}, {10: ROOT, 31: zombie(MEMBER)}, ownership.LIVE),
    ('S4 member zombie reparented outside the chain', {10: ROOT, 31: MEMBER},
     {10: ROOT, 31: zombie(MEMBER, parent=1)}, ownership.ORPHAN),
    ('S4 member zombie reparented to a live root', {10: ROOT, 32: dict(MEMBER, pid=32), 31: dict(MEMBER, parent=32, start=102)},
     {10: ROOT, 31: zombie(MEMBER, start=102)}, ownership.LIVE),
    ('S5 root alive->zombie without members', {10: ROOT}, {10: zombie(ROOT)}, 'none'),
    ('S6 root alive->zombie with a live member', {10: ROOT, 31: MEMBER}, {10: zombie(ROOT), 31: MEMBER}, ownership.ORPHAN),
    ('S7 runner fork->exec', {40: RUNNER}, {40: dict(RUNNER, image=(9, 8))}, 'none'),
    ('S8 runner alive->zombie', {40: RUNNER}, {40: zombie(RUNNER)}, 'none'),
    ('S9 foreign zombie->live', {77: zombie(FOREIGN)}, {77: FOREIGN}, 'none'),
    ('S11 foreign PID reuse', {77: FOREIGN}, {77: dict(FOREIGN, start=401)}, 'none'),
    ('S12 foreign parent-order inversion', {}, {78: dict(FOREIGN, pid=78, parent=77, start=399), 77: FOREIGN}, 'none'),
]
# Rows the FINAL table keeps refusing: (row, previous, current, first predicate).
UNCHANGED = [
    ('S10 root start drift', {10: ROOT}, {10: dict(ROOT, start=101)}, 'identity-drift'),
    ('S10 member start drift', {10: ROOT, 31: MEMBER}, {10: ROOT, 31: dict(MEMBER, start=102)}, 'identity-drift'),
    ('S10 foreign reused as a member', {77: FOREIGN}, {77: dict(MEMBER, pid=77, start=401)}, 'identity-drift'),
    ('S10 member reused as foreign', {31: MEMBER}, {31: dict(FOREIGN, pid=31, start=402)}, 'identity-drift'),
    ('S10 exited root with changed start', {10: ROOT}, {10: zombie(ROOT, start=101)}, 'identity-drift'),
    ('S12 foreign child older than its launcher parent', {}, {78: dict(FOREIGN, pid=78, parent=10, start=99), 10: ROOT},
     'parent-order'),
    ('S13 exec into the launcher', {77: FOREIGN}, {77: dict(FOREIGN, image=(1, 2), path=INSTALLED + '/launcher')},
     'identity-drift'),
    ('S13 exec into the target', {77: FOREIGN}, {77: dict(FOREIGN, image=(1, 3), path=INSTALLED + '/root/chrome')},
     'identity-drift'),
    ('S13 exec out of the launcher', {10: ROOT}, {10: dict(ROOT, image=(9, 6), path='/usr/bin/SYNTHETIC_EXEC')},
     'identity-drift'),
    ('S13 member exec', {10: ROOT, 31: MEMBER}, {10: ROOT, 31: dict(MEMBER, image=(9, 4))}, 'identity-drift'),
    ('candidate zombie->live', {10: zombie(ROOT)}, {10: ROOT}, 'identity-drift'),
    ('candidate imageless record without state', {10: ROOT}, {10: STATELESS}, 'identity-drift'),
    ('candidate imageless X record', {10: ROOT}, {10: zombie(ROOT, state='X')}, 'identity-drift'),
    ('candidate imageless kernel record', {10: ROOT}, {10: zombie(ROOT, kernel=True)}, 'identity-drift'),
    ('candidate zombie that keeps an image', {10: ROOT}, {10: dict(ROOT, state='Z', image=(9, 6))}, 'identity-drift'),
    ('foreign target image', {}, {77: dict(FOREIGN, image=(1, 3), path=INSTALLED + '/root/chrome')}, 'foreign-image'),
    ('member cycle', {}, {31: dict(MEMBER, parent=32), 32: dict(MEMBER, pid=32, parent=31)}, 'member-cycle'),
]


class ExitAndCandidateDrift(unittest.TestCase):
    """#10023 FINAL S1-S13 schedules against the shared census predicate."""
    def outcome(self, previous, current):
        detail = []
        outcome = ownership._classify(previous, current, 1001, (1, 2), 'pid:[1]', 1, detail)
        self.assertEqual(outcome, classify(previous, current))
        if outcome != ownership.AMBIGUOUS:
            self.assertEqual(detail, [])
            return outcome, None
        self.assertEqual(len(detail), 1)
        self.assertIsNotNone(ownership.removal_witness(detail[0]))
        self.assertNotIn(b'SYNTHETIC', detail[0])
        return outcome, re.search(rb';predicate=([a-z-]+);', detail[0])[1].decode()

    def mutant(self, candidate=None, exited=None):
        stack = ExitStack()
        if candidate is not None:
            stack.enter_context(mock.patch.object(ownership, '_candidate', lambda *_: candidate))
        if exited is not None:
            stack.enter_context(mock.patch.object(ownership, '_exited', lambda *_: exited))
        return stack

    def test_changed_rows_reach_their_final_outcome_without_a_witness(self):
        for row, previous, current, final in CHANGED:
            with self.subTest(row=row):
                self.assertEqual(self.outcome(previous, current), (final, None))

    def test_unchanged_rows_still_refuse_with_their_first_predicate(self):
        for row, previous, current, predicate in UNCHANGED:
            with self.subTest(row=row):
                self.assertEqual(self.outcome(previous, current), (ownership.AMBIGUOUS, predicate))

    def test_reverted_predicate_restores_every_changed_refusal(self):
        for row, previous, current, _final in CHANGED:
            with self.subTest(row=row), self.mutant(candidate=True, exited=False):
                self.assertEqual(self.outcome(previous, current)[0], ownership.AMBIGUOUS)

    def test_each_half_of_the_predicate_owns_its_rows(self):
        exits = {'S1', 'S3', 'S4', 'S5', 'S6', 'S8'}
        candidate_exits = {'S3', 'S4', 'S5', 'S6'}
        for row, previous, current, final in CHANGED:
            name = row.split()[0]
            with self.subTest(row=row, mutant='every record a candidate'), self.mutant(candidate=True):
                self.assertEqual(self.outcome(previous, current)[0], final if name in exits else ownership.AMBIGUOUS)
            with self.subTest(row=row, mutant='no exact exit'), self.mutant(exited=False):
                self.assertEqual(self.outcome(previous, current)[0],
                                 ownership.AMBIGUOUS if name in candidate_exits else final)

    def test_over_relaxed_predicates_lose_the_unchanged_refusals(self):
        for row, previous, current, predicate in UNCHANGED:
            for mutant in ({'candidate': False}, {'exited': True}):
                with self.subTest(row=row, mutant=mutant), self.mutant(**mutant):
                    relaxed = self.outcome(previous, current)
                    # Foreign-image and member-cycle stay universal; an exit never excuses parent order.
                    if predicate in ('foreign-image', 'member-cycle') or (
                            predicate == 'parent-order' and 'exited' in mutant):
                        self.assertEqual(relaxed, (ownership.AMBIGUOUS, predicate))
                    else:
                        self.assertNotEqual(relaxed, (ownership.AMBIGUOUS, predicate))

    def run_census(self, snapshots):
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(ownership.Path, 'is_symlink', return_value=False))
            stack.enter_context(mock.patch.object(ownership.Path, 'stat', return_value=mock.Mock(st_mode=0o100755, st_dev=1, st_ino=2)))
            stack.enter_context(mock.patch.object(ownership, 'bounded_read', return_value='#define ADMITTED_UID 1001\n'))
            stack.enter_context(mock.patch.object(ownership.os, 'readlink', return_value='pid:[1]'))
            stack.enter_context(mock.patch.object(ownership.time, 'monotonic', return_value=0))
            stack.enter_context(mock.patch.object(ownership.time, 'sleep'))
            read = stack.enter_context(mock.patch.object(ownership, 'snapshot', side_effect=snapshots))
            detail = []
            outcome = ownership._census(detail)
            return outcome, len(detail), read.call_count

    def test_census_admits_exits_only_through_the_unchanged_two_empty_passes(self):
        persistent = zombie(FOREIGN)
        schedules = [
            ('S1 foreign exit', [{77: FOREIGN}, {77: persistent}], ('none', 0, 2)),
            # The exited root's own pass still had a root, so a third pass decides.
            ('S5 root exit beside a persistent foreign zombie',
             [{10: ROOT, 77: FOREIGN}, {10: zombie(ROOT), 77: persistent}, {77: persistent}], ('none', 0, 3)),
            ('S10 candidate start drift', [{10: ROOT}, {10: dict(ROOT, start=101)}], (ownership.AMBIGUOUS, 1, 2)),
        ]
        for row, snapshots, expected in schedules:
            with self.subTest(row=row):
                self.assertEqual(self.run_census(snapshots), expected)


if __name__ == '__main__':
    unittest.main()
