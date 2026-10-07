"""Small native ownership negatives; the 4097 proof belongs to hosted controls."""
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
