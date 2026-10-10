"""Small native ownership negatives; the 4097 proof belongs to hosted controls."""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
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


UNSHARE_FD, INIT_FD, LEAF_FD = 20, 21, 22
GENERATED = {1001: (1501, 1000), 1002: (1502, 1001)}  # synthetic pid: (start, parent)
T_INIT_PRE_EXEC = ((0, 1001, 1501, 'setpriv'),)
T_CHILD_ABSENT = ((0, 1001, 1501, 'sh'),)
T_CHILD_PRE_EXEC = ((0, 1001, 1501, 'sh'), (1, 1002, 1502, 'sh'))
T_FINAL = ((0, 1001, 1501, 'sh'), (1, 1002, 1502, 'sleep'))
CONSTRUCTED = '{"constructed": true, "children": 1, "mode": "orphan"}\n'
OBSERVED_FINAL = 'provider-boundary-owner-stimulus:observed:ready=final;boundary=final;generated=unchanged\n'
RETIRED = 'provider-boundary-owner-stimulus:retired\n'


def stat_text(pid, start, parent):
    fields = ['S', str(parent)] + ['0'] * 50
    fields[19] = str(start)
    return f'{pid} (SYNTHETIC) ' + ' '.join(fields) + '\n'


def gone(_pid):
    raise FileNotFoundError(errno.ENOENT, 'SYNTHETIC_PRIVATE')


def run_orphan(trees=None, after=gone, probe=None, lifetime=([True], [], []), stdin=b'', patches=()):
    """Drive main() for one synthetic orphan on a fake clock. `trees` replaces
    the sampler with a schedule (last entry repeats); `after(pid)` answers stat
    reads once SIGKILL was sent; `probe(fd)` answers the pidfd signal-0 check."""
    state = SimpleNamespace(killed=False, now=0.0, signalled=[], waits=[], samples=0)

    class Process:
        pid = 1000

        def poll(self):
            return None

        def wait(self, timeout):
            state.waits.append(state.killed)
            return 0

    def kill(fd, sig):
        if sig == 9:
            state.signalled.append(fd)
            state.killed = True
        elif probe:
            probe(fd)
        elif state.killed:
            raise ProcessLookupError(errno.ESRCH, 'SYNTHETIC_PRIVATE')

    def read(path):
        pid = int(path.parent.name)
        if state.killed:
            return after(pid)
        return stat_text(pid, *GENERATED[pid])

    def read_text(path, *args, **kwargs):
        return {'/proc/1000/task/1000/children': '1001',
                '/proc/1001/status': 'Uid:\t1001\t1001\t1001\t1001\n'}[path.as_posix()]

    def sampled(root, images):
        state.samples += 1
        return trees[min(state.samples, len(trees)) - 1]

    def sleep(seconds):
        state.now += seconds

    out, err = io.StringIO(), io.StringIO()
    with contextlib.ExitStack() as stack:
        for patch in (
                mock.patch.object(stimulus, 'time', SimpleNamespace(monotonic=lambda: state.now, sleep=sleep)),
                mock.patch.object(stimulus.os, 'getuid', return_value=0, create=True),
                mock.patch.object(stimulus, 'principal', return_value=(1001, 1001)),
                mock.patch.object(stimulus.sys, 'argv', ['SYNTHETIC_HELPER', 'orphan']),
                mock.patch.object(stimulus.subprocess, 'Popen', return_value=Process()),
                mock.patch.object(stimulus.os, 'open', return_value=10),
                mock.patch.object(stimulus.os, 'O_CLOEXEC', 0, create=True),
                mock.patch.object(stimulus.os, 'close'),
                mock.patch.object(stimulus.os, 'pidfd_open', side_effect=lambda pid: {1000: UNSHARE_FD, 1001: INIT_FD, 1002: LEAF_FD}[pid],
                                  create=True),
                mock.patch.object(stimulus.os, 'readlink',
                                  side_effect=lambda path: 'pid:[1]' if path == '/proc/self/ns/pid' else 'pid:[2]'),
                mock.patch.object(Path, 'read_text', read_text),
                mock.patch.object(stimulus, 'bounded_read', side_effect=read),
                mock.patch.object(stimulus, 'image_names', return_value={(9, 3): 'sh', (9, 4): 'sleep'}),
                mock.patch.object(stimulus, 'proc_children',
                                  side_effect=lambda pid: {1000: ['1001'], 1001: ['1002']}.get(pid, [])),
                mock.patch.object(stimulus, 'exe_image', side_effect=lambda member: (9, 3) if member == '1001' else (9, 4)),
                mock.patch.object(stimulus.signal, 'pidfd_send_signal', side_effect=kill, create=True),
                mock.patch.object(stimulus.signal, 'SIGKILL', 9, create=True),
                mock.patch.object(stimulus.select, 'select', return_value=lifetime),
                mock.patch.object(stimulus.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(stdin))),
                contextlib.redirect_stdout(out),
                contextlib.redirect_stderr(err),
                *([mock.patch.object(stimulus, 'generated_tree', side_effect=sampled)] if trees else []),
                *patches):
            stack.enter_context(patch)
        status = stimulus.main()
    return SimpleNamespace(status=status, out=out.getvalue(), err=err.getvalue(), signalled=state.signalled,
                           waits=state.waits, samples=state.samples, now=state.now)


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

    def test_main_reports_the_orphan_observation_and_retires(self):
        # Synthetic main path through the real sampler: no process, pidfd,
        # /proc or privilege operation runs. A hosted observation print that
        # raised became retirement:output.
        run = run_orphan()
        self.assertEqual(run.waits, [True])
        self.assertEqual(run.signalled, [INIT_FD, LEAF_FD, UNSHARE_FD])
        self.assertEqual((run.status, run.out, run.err), (0, CONSTRUCTED + OBSERVED_FINAL + RETIRED, ''))

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


class OrphanReadiness(unittest.TestCase):
    """AC1: ready covers setpriv-to-shell and shell-child-to-sleep on the retained init."""

    def test_ready_waits_for_both_final_execs_and_retains_the_leaf(self):
        run = run_orphan(trees=[T_INIT_PRE_EXEC, T_CHILD_ABSENT, T_CHILD_PRE_EXEC, T_FINAL])
        self.assertEqual((run.status, run.out, run.err), (0, CONSTRUCTED + OBSERVED_FINAL + RETIRED, ''))
        self.assertEqual(run.samples, 5)  # four readiness samples, then the boundary sample
        self.assertEqual(run.signalled, [INIT_FD, LEAF_FD, UNSHARE_FD])

    def test_readiness_bypass_mutant_is_detected_with_other_inputs_frozen(self):
        trees = [T_INIT_PRE_EXEC, T_CHILD_ABSENT, T_CHILD_PRE_EXEC, T_FINAL]
        hardened = run_orphan(trees=trees)
        # Mutant: ready as soon as the admitted-UID init is retained (the
        # previous predicate). Same schedule, identities and clock.
        bypass = run_orphan(trees=trees, patches=[
            mock.patch.object(stimulus, 'final_leaf', lambda tree, members: T_FINAL[1] if members else None)])
        self.assertEqual(hardened.out, CONSTRUCTED + OBSERVED_FINAL + RETIRED)
        self.assertNotEqual(bypass.out, hardened.out)
        self.assertIn('ready=init-pre-exec;', bypass.out)

    def test_a_final_shape_on_another_init_identity_is_never_ready(self):
        replaced = ((0, 1001, 9999, 'sh'), (1, 1002, 1502, 'sleep'))
        run = run_orphan(trees=[replaced])
        self.assertEqual(run.status, 1)
        self.assertEqual(run.err, 'provider-boundary-owner-stimulus-refused:construct\n')
        self.assertNotIn(CONSTRUCTED, run.out)
        # Construction failure retires only the generated identities it holds.
        self.assertEqual(run.signalled, [INIT_FD, UNSHARE_FD])
        self.assertTrue(run.out.endswith(RETIRED))

    def test_readiness_deadline_reports_the_last_sample_and_retires_generated_identities(self):
        for tree, state, drift in ((T_INIT_PRE_EXEC, 'init-pre-exec', 'unchanged'),
                                   (T_CHILD_ABSENT, 'child-absent', 'unchanged'),
                                   (T_CHILD_PRE_EXEC, 'child-pre-exec', 'unchanged'),
                                   (None, 'incomplete', 'unproven')):
            with self.subTest(state=state):
                run = run_orphan(trees=[tree, tree])
                self.assertEqual(run.status, 1)
                self.assertLess(run.now, 1.1)  # the unchanged one-second readiness budget
                self.assertEqual(run.err, 'provider-boundary-owner-stimulus-refused:construct\n')
                self.assertEqual(run.out, f'provider-boundary-owner-stimulus:observed:ready={state};'
                                          f'boundary={state};generated={drift}\n' + RETIRED)
                self.assertEqual(run.signalled, [INIT_FD, UNSHARE_FD])

    def test_final_leaf_requires_one_retained_init_and_its_exact_start(self):
        init = (1001, 1501, INIT_FD)
        self.assertEqual(stimulus.final_leaf(T_FINAL, [init]), T_FINAL[1])
        for tree, members in ((T_CHILD_PRE_EXEC, [init]), (T_FINAL, []), (T_FINAL, [init, init]),
                              (T_FINAL, [(1001, 1500, INIT_FD)]), (T_FINAL, [(1003, 1501, INIT_FD)]), (None, [init])):
            self.assertIsNone(stimulus.final_leaf(tree, members))


class OrphanRetirement(unittest.TestCase):
    """AC2: identity-proven disappearance only; every other read or probe fails."""

    def refused(self, reason):
        return 'provider-boundary-owner-stimulus-refused:retirement:' + reason + '\n'

    def test_esrch_and_enoent_disappearance_proven_by_the_pidfd_retire(self):
        # ESRCH: the task was released between open and read of its stat.
        for error in (ProcessLookupError(errno.ESRCH, 'SYNTHETIC_PRIVATE'),
                      FileNotFoundError(errno.ENOENT, 'SYNTHETIC_PRIVATE')):
            with self.subTest(errno=error.errno):
                def after(_pid, error=error):
                    raise error
                run = run_orphan(trees=[T_FINAL], after=after)
                self.assertEqual((run.status, run.out, run.err), (0, CONSTRUCTED + OBSERVED_FINAL + RETIRED, ''))
                self.assertLess(run.now, 2)

    def test_same_live_init_or_leaf_fails_at_the_unchanged_deadline(self):
        for live in (1001, 1002):
            with self.subTest(pid=live):
                def after(pid, live=live):
                    return stat_text(pid, *GENERATED[pid]) if pid == live else gone(pid)
                run = run_orphan(trees=[T_FINAL], after=after)
                self.assertEqual((run.status, run.out, run.err),
                                 (1, CONSTRUCTED + OBSERVED_FINAL, self.refused('member-live')))
                self.assertGreaterEqual(run.now, 2)
                self.assertLess(run.now, 2.1)

    def test_replacement_at_the_member_pid_fails(self):
        run = run_orphan(trees=[T_FINAL], after=lambda pid: stat_text(pid, 7777, 1))
        self.assertEqual((run.status, run.err), (1, self.refused('member-replaced')))

    def test_eacces_and_every_other_read_error_fail_with_a_closed_reason(self):
        # All-read-errors bypass negative: only ENOENT/ESRCH can be disappearance.
        cases = [
            (PermissionError(errno.EACCES, 'SYNTHETIC_PRIVATE'), 'member-read-EACCES'),
            (PermissionError(errno.EPERM, 'SYNTHETIC_PRIVATE'), 'member-read-EPERM'),
            (OSError(errno.EIO, 'SYNTHETIC_PRIVATE'), 'member-read-EIO'),
            (OSError(errno.EINVAL, 'SYNTHETIC_PRIVATE'), 'member-read-EINVAL'),
            (OSError(errno.EXDEV, 'SYNTHETIC_PRIVATE'), 'member-read-other'),
            (FileNotFoundError('SYNTHETIC_PRIVATE'), 'member-read-other'),
            (UnicodeDecodeError('ascii', b'\xff', 0, 1, 'SYNTHETIC_PRIVATE'), 'member-parse'),
            (ownership.CensusError(), 'member-parse'),
        ]
        for error, reason in cases:
            with self.subTest(reason=reason):
                def after(_pid, error=error):
                    raise error
                run = run_orphan(trees=[T_FINAL], after=after)
                self.assertEqual((run.status, run.out, run.err), (1, CONSTRUCTED + OBSERVED_FINAL, self.refused(reason)))
        malformed = run_orphan(trees=[T_FINAL], after=lambda pid: 'SYNTHETIC_PRIVATE\n')
        self.assertEqual(malformed.err, self.refused('member-parse'))

    def test_missing_stat_without_pidfd_proof_is_uncertain(self):
        def alive(_fd):
            return None

        def denied(_fd):
            raise PermissionError(errno.EPERM, 'SYNTHETIC_PRIVATE')

        for probe in (alive, denied):
            with self.subTest(probe=probe.__name__):
                run = run_orphan(trees=[T_FINAL], probe=probe)
                self.assertEqual((run.status, run.err), (1, self.refused('member-uncertain')))

    def test_lifetime_failures_retire_only_generated_identities_and_keep_the_first_error(self):
        for name, options in (('backup deadline', {'lifetime': ([], [], [])}), ('unexpected input', {'stdin': b'x'})):
            with self.subTest(name=name):
                run = run_orphan(trees=[T_FINAL], **options)
                self.assertEqual((run.status, run.out, run.err),
                                 (1, CONSTRUCTED + OBSERVED_FINAL + RETIRED,
                                  'provider-boundary-owner-stimulus-refused:lifetime\n'))
                self.assertEqual(run.signalled, [INIT_FD, LEAF_FD, UNSHARE_FD])
        run = run_orphan(trees=[T_FINAL], lifetime=([], [], []),
                         after=lambda pid: stat_text(pid, *GENERATED[pid]))
        self.assertEqual(run.err, 'provider-boundary-owner-stimulus-refused:lifetime\n' + self.refused('member-live'))


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
