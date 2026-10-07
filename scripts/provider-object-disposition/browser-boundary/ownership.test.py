import importlib.util
from pathlib import Path
import unittest
import sys
import io
import errno
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from unittest import mock

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('ownership', Path(__file__).with_name('ownership.py'))
ownership = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ownership)
observer_spec = importlib.util.spec_from_file_location('observer', Path(__file__).with_name('observe.py'))
observer = importlib.util.module_from_spec(observer_spec)
observer_spec.loader.exec_module(observer)


def record(pid=20, parent=1, start=100, uid=1001, image=(1, 2), namespace='pid:[1]', path='/usr/local/lib/chase-sets-provider-window/launcher'):
    return dict(pid=pid, parent=parent, start=start, uid=uid, image=image, namespace=namespace, path=path)


def classify(previous, current):
    return ownership.classify(previous, current, 1001, (1, 2), 'pid:[1]', 1)


class OwnershipControls(unittest.TestCase):
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
        self.assertEqual(error.getvalue(), 'provider-boundary-observer-refused:census\n')

    def test_observer_argument_refusal_does_not_echo_argv(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['observe.py', 'PRIVATE']):
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(observer.main(), 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(error.getvalue(), 'provider-boundary-observer-refused:arguments\n')

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


if __name__ == '__main__':
    unittest.main()
