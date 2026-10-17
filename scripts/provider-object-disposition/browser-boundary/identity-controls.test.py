"""Synthetic startup churn and identity-loss controls; no installed boundary."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('identity_controls', Path(__file__).with_name('identity-controls.py'))
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)


def record(pid, parent, image='launcher'):
    return dict(pid=pid, parent=parent, start=pid, image=image, device=1, inode=2 if image == 'launcher' else 3)


class IdentityControls(unittest.TestCase):
    def test_complete_lifetime_chain_and_exact_recheck(self):
        records = [record(10, 1), record(11, 10), record(12, 11, 'chrome')]
        with patch.object(controls, 'children', side_effect=[[r] for r in records]), \
                patch.object(controls, 'identity', side_effect=records):
            self.assertEqual(controls.baseline(1, 1), records)

    def test_missing_or_duplicate_required_role_never_passes(self):
        root, init, chrome = record(10, 1), record(11, 10), record(12, 11, 'chrome')
        for discovery in ([], [root, root]):
            with self.subTest(discovery=discovery), patch.object(controls, 'children', return_value=discovery):
                with self.assertRaises(ValueError):
                    controls.baseline(1, 1)
        for discovery in (([root], []), ([root], [init], []), ([root], [init], [chrome, chrome])):
            with self.subTest(discovery=discovery), patch.object(controls, 'children', side_effect=discovery):
                with self.assertRaises(ValueError):
                    controls.baseline(1, 1)

    def test_negative_control_identity_replaced_during_discovery(self):
        records = [record(10, 1), record(11, 10), record(12, 11, 'chrome')]
        for index in range(3):
            replaced = [dict(r) for r in records]
            replaced[index]['start'] += 100
            with self.subTest(index=index), patch.object(controls, 'children', side_effect=[[r] for r in records]), \
                    patch.object(controls, 'identity', side_effect=replaced):
                with self.assertRaises(ValueError):
                    controls.baseline(1, 1)

    def test_alone_requires_zero_browser_roots(self):
        with patch.object(controls, 'children', return_value=[]), patch.object(controls, 'identity') as read:
            self.assertEqual(controls.baseline(1, 0), [])
            read.assert_not_called()
        with patch.object(controls, 'children', return_value=[record(10, 1)]):
            with self.assertRaises(ValueError):
                controls.baseline(1, 0)

    def test_startup_helper_churn_is_not_a_required_browser_identity(self):
        # A same-executable helper may still be alive or already gone at discovery.
        # Neither schedule changes the required browser, and no sleep/retry is used.
        main = record(12, 11, 'chrome')
        image = SimpleNamespace(st_dev=1, st_ino=3)
        for helper_gone in (False, True):
            def read(path):
                if path.name == 'children':
                    return '12 13'
                if path.parent.name == '12':
                    return '/browser/chrome\0--headless\0--remote-debugging-pipe\0'
                if helper_gone:
                    raise FileNotFoundError(2, 'SYNTHETIC_PRIVATE_MARKER')
                return '/browser/chrome\0--type=zygote\0'
            with self.subTest(helper_gone=helper_gone), patch.object(controls, 'bounded_read', side_effect=read), \
                    patch.object(Path, 'stat', return_value=image), patch.object(controls, 'identity', return_value=main) as identify:
                self.assertEqual(controls.children(11, controls.CHROME, ['/browser/chrome', '--headless', '--remote-debugging-pipe']), [main])
                identify.assert_called_once_with(12)

    def test_recorded_dead_missing_or_reparented_identity_is_not_ignored(self):
        live = dict(pid=12, parent=11, start=12, state='S')
        image = SimpleNamespace(st_dev=1, st_ino=3)
        for state in ('Z', 'X'):
            with patch.object(controls, 'bounded_read', return_value='stat'), \
                    patch.object(controls, 'parse_stat', return_value={**live, 'state': state}):
                with self.assertRaises(ValueError):
                    controls.identity(12)
        with patch.object(controls, 'bounded_read', side_effect=FileNotFoundError()):
            with self.assertRaises(FileNotFoundError):
                controls.identity(12)
        with patch.object(controls, 'bounded_read', return_value='stat'), \
                patch.object(controls, 'parse_stat', side_effect=[live, {**live, 'parent': 99}]), \
                patch.object(Path, 'stat', return_value=image):
            with self.assertRaises(ValueError):
                controls.identity(12)


if __name__ == '__main__':
    unittest.main()
