"""Small native ownership negatives; the 4097 proof belongs to hosted controls."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ownership_spec = importlib.util.spec_from_file_location('ownership', Path(__file__).with_name('ownership.py'))
ownership = importlib.util.module_from_spec(ownership_spec)
ownership_spec.loader.exec_module(ownership)
stimulus_spec = importlib.util.spec_from_file_location('stimulus', Path(__file__).with_name('ownership-stimulus.py'))
stimulus = importlib.util.module_from_spec(stimulus_spec)
stimulus_spec.loader.exec_module(stimulus)

IMAGES = {(9, 2): 'setpriv', (9, 3): 'sh', (9, 4): 'sleep'}


def census_record(pid, parent, start, uid, image, namespace, path):
    return dict(pid=pid, parent=parent, start=start, uid=uid, image=image, namespace=namespace, path=path)


UNSHARE = census_record(30, 10, 500, 0, (9, 1), 'pid:[1]', '/usr/bin/unshare')
INIT_PRE_EXEC = census_record(31, 30, 501, 1001, (9, 2), 'pid:[2]', '/usr/bin/setpriv')
INIT = census_record(31, 30, 501, 1001, (9, 3), 'pid:[2]', '/usr/bin/dash')
CHILD = census_record(32, 31, 502, 1001, (9, 4), 'pid:[2]', '/usr/bin/sleep')
FOREIGN = census_record(77, 1, 400, 0, (9, 5), 'pid:[1]', '/usr/bin/SYNTHETIC_FOREIGN')
FOREIGN_EXECED = dict(FOREIGN, image=(9, 6))


def snapshot(*records):
    return {record['pid']: record for record in records}


def classify(previous, current):
    return ownership.classify(previous, current, 1001, (1, 2), 'pid:[1]', 1)


def sample(current):
    """Run the fixture's own read-only sampler against one census snapshot."""
    def read(path):
        record = current[int(path.parent.name)]
        fields = ['S', str(record['parent'])] + ['0'] * 50
        fields[19] = str(record['start'])
        return f"{record['pid']} (synthetic) " + ' '.join(fields) + '\n'

    def children(pid):
        return [str(member) for member, record in current.items() if record['parent'] == pid]

    with mock.patch.object(stimulus, 'proc_children', side_effect=children), \
            mock.patch.object(stimulus, 'bounded_read', side_effect=read), \
            mock.patch.object(stimulus, 'exe_image', side_effect=lambda member: current[int(member)]['image']):
        return stimulus.generated_tree(UNSHARE['pid'], IMAGES)


class OrphanObservation(unittest.TestCase):
    def test_ac1_generated_and_foreign_drift_share_the_refusal_but_not_the_generated_observation(self):
        schedules = {
            'generated': (snapshot(UNSHARE, INIT_PRE_EXEC, FOREIGN), snapshot(UNSHARE, INIT, CHILD, FOREIGN)),
            'foreign': (snapshot(UNSHARE, INIT, CHILD, FOREIGN), snapshot(UNSHARE, INIT, CHILD, FOREIGN_EXECED)),
        }
        lines = {}
        for name, (ready, boundary) in schedules.items():
            # Frozen inputs: each endpoint alone is an exact orphan; only the
            # drift between the two snapshots makes the shipped census ambiguous.
            self.assertEqual(classify(ready, ready), ownership.ORPHAN)
            self.assertEqual(classify(boundary, boundary), ownership.ORPHAN)
            self.assertEqual(classify(ready, boundary), ownership.AMBIGUOUS)
            lines[name] = stimulus.observation_line(sample(ready), sample(boundary))
        self.assertEqual(lines['generated'],
                         'provider-boundary-owner-stimulus:observed:ready=init-pre-exec;boundary=final;generated=changed')
        self.assertEqual(lines['foreign'],
                         'provider-boundary-owner-stimulus:observed:ready=final;boundary=final;generated=unchanged')

    def test_ac1_both_final_exec_transitions_are_named_states(self):
        child_pre_exec = dict(CHILD, image=(9, 3))
        self.assertEqual(stimulus.tree_state(sample(snapshot(UNSHARE, INIT_PRE_EXEC))), 'init-pre-exec')
        self.assertEqual(stimulus.tree_state(sample(snapshot(UNSHARE, INIT))), 'child-absent')
        self.assertEqual(stimulus.tree_state(sample(snapshot(UNSHARE, INIT, child_pre_exec))), 'child-pre-exec')
        self.assertEqual(stimulus.tree_state(sample(snapshot(UNSHARE, INIT, CHILD))), 'final')
        self.assertEqual(stimulus.generated_drift(sample(snapshot(UNSHARE, INIT, child_pre_exec)),
                                                  sample(snapshot(UNSHARE, INIT, CHILD))), 'changed')

    def test_ac1_unsampled_or_incomplete_evidence_stays_unproven(self):
        final = sample(snapshot(UNSHARE, INIT, CHILD))
        with mock.patch.object(stimulus, 'proc_children', return_value=['31']), \
                mock.patch.object(stimulus, 'exe_image', side_effect=PermissionError(errno.EACCES, 'SYNTHETIC_PRIVATE')):
            unreadable = stimulus.generated_tree(30, IMAGES)
        self.assertIsNone(unreadable)
        foreign_image = sample(snapshot(UNSHARE, dict(INIT, image=(9, 9))))
        crowded = snapshot(UNSHARE, INIT, *[dict(CHILD, pid=pid) for pid in range(40, 44)])
        for tree in (None, unreadable, foreign_image, sample(crowded)):
            self.assertEqual(stimulus.tree_state(tree), 'incomplete')
            self.assertEqual(stimulus.generated_drift(final, tree), 'unproven')
            self.assertEqual(stimulus.generated_drift(tree, final), 'unproven')
        with mock.patch.object(stimulus, 'parse_stat', side_effect=[{'start': 501, 'parent': 30}, {'start': 999, 'parent': 30}]), \
                mock.patch.object(stimulus, 'proc_children', side_effect=lambda pid: ['31'] if pid == 30 else []), \
                mock.patch.object(stimulus, 'bounded_read', return_value=''), \
                mock.patch.object(stimulus, 'exe_image', return_value=(9, 3)):
            self.assertIsNone(stimulus.generated_tree(30, IMAGES))
        # Unchanged endpoints are not foreign attribution: no such state exists.
        self.assertEqual(stimulus.generated_drift(final, final), 'unchanged')
        self.assertNotIn('foreign', stimulus.observation_line(final, final))

    def test_main_never_shadows_the_observation_helpers(self):
        # A local of the same name turned the hosted observation print into a
        # retirement:output refusal; main must call the module helpers.
        helpers = {'errno_name', 'image_names', 'generated_tree', 'observation_line', 'retirement_reason'}
        self.assertEqual(helpers & set(stimulus.main.__code__.co_varnames), set())
        self.assertTrue(helpers <= set(stimulus.main.__code__.co_names))

    def test_retirement_reasons_are_closed_and_keep_errno_only(self):
        cases = [
            ('member', ProcessLookupError(errno.ESRCH, 'SYNTHETIC_PRIVATE'), 'member-read-ESRCH'),
            ('member', PermissionError(errno.EACCES, 'SYNTHETIC_PRIVATE'), 'member-read-EACCES'),
            ('member', OSError(errno.EXDEV, 'SYNTHETIC_PRIVATE'), 'member-read-other'),
            ('member', OSError('SYNTHETIC_PRIVATE'), 'member-read-other'),
            ('member', ownership.CensusError(), 'member-parse'),
            ('member', UnicodeError('SYNTHETIC_PRIVATE'), 'member-parse'),
            ('signal', PermissionError(errno.EPERM, 'SYNTHETIC_PRIVATE'), 'signal-EPERM'),
            ('wait', ValueError('SYNTHETIC_PRIVATE'), 'wait-other'),
            ('foreign', ValueError('SYNTHETIC_PRIVATE'), 'foreign-file'),
        ]
        for step, error, reason in cases:
            self.assertEqual(stimulus.retirement_reason(step, error), reason)
            self.assertNotIn('PRIVATE', stimulus.retirement_reason(step, error))


class CensusOwnershipFixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='SYNTHETIC-census-')
        cls.binary = str(Path(cls.directory.name) / 'census-stimulus')
        subprocess.run(['/usr/bin/gcc', '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(Path(__file__).with_name('census-stimulus.c')), '-o', cls.binary], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def run_control(self, mode):
        process = subprocess.Popen([self.binary, str(os.getuid()), str(os.getgid()), mode],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 15)[0])
            ready = json.loads(process.stdout.readline())
            started = time.monotonic()
            process.stdin.close()
            process.wait(timeout=2)
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(process.stderr.read(), b'')
            self.assertEqual(process.stdout.read(), b'provider-boundary-owner-stimulus:retired\n')
            return ready
        finally:
            if not process.stdin.closed:
                process.stdin.close()
            process.wait(timeout=2)
            process.stdout.close()
            process.stderr.close()

    def test_construction_failure_retires_every_atomically_owned_leaf(self):
        ready = self.run_control('construction-failure')
        self.assertFalse(ready['constructed'])
        self.assertEqual(ready['reason'], 'EMFILE')
        self.assertEqual(ready['children'], 4)

    def test_coordinator_cancellation_drains_live_shard_and_all_leaves(self):
        ready = self.run_control('cancel')
        self.assertTrue(ready['constructed'])
        self.assertEqual(ready['children'], 8)
        self.assertEqual(ready['shards'], 1)
        self.assertEqual(ready['maxShardPidfds'], 256)

    def test_shard_death_keeps_guardian_pidfds_and_reaps_all_leaves(self):
        ready = self.run_control('shard-death')
        self.assertFalse(ready['constructed'])
        self.assertEqual(ready['children'], 4)

    def test_coordinator_death_closes_cancellation_pipe_and_guardian_drains(self):
        process = subprocess.Popen([self.binary, str(os.getuid()), str(os.getgid()), 'cancel'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        fd = os.pidfd_open(process.pid)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 15)[0])
            self.assertTrue(json.loads(process.stdout.readline())['constructed'])
            owned = {}

            def record_children(pid):
                for child in Path(f'/proc/{pid}/task/{pid}/children').read_text().split():
                    text = Path(f'/proc/{child}/stat').read_text()
                    owned[child] = text[text.rindex(') ') + 2:].split()[19]
                    record_children(child)

            record_children(process.pid)
            self.assertEqual(len(owned), 10)  # guardian, shard and eight leaves
            started = time.monotonic()
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            process.wait(timeout=2)
            self.assertEqual(process.returncode, -signal.SIGKILL)
            while time.monotonic() - started < 2:
                for pid, start in list(owned.items()):
                    try:
                        text = Path(f'/proc/{pid}/stat').read_text()
                        if text[text.rindex(') ') + 2:].split()[19] != start:
                            del owned[pid]
                    except FileNotFoundError:
                        del owned[pid]
                if not owned:
                    break
                time.sleep(.01)
            self.assertEqual(owned, {})
        finally:
            process.stdin.close()
            process.wait(timeout=2)
            os.close(fd)
            process.stdout.close()
            process.stderr.close()


if __name__ == '__main__':
    unittest.main()
