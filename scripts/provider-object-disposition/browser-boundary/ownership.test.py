import importlib.util
from pathlib import Path
import unittest
import sys
import io
from contextlib import redirect_stderr, redirect_stdout
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


if __name__ == '__main__':
    unittest.main()
