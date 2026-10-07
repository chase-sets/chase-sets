import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('variants', Path(__file__).with_name('native-variants.py'))
variants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(variants)
SOURCE = Path(__file__).with_name('launcher.c').read_text()


class NativeVariantFixtures(unittest.TestCase):
    def test_native_clients_run_after_isolation_with_no_external_parent_sender(self):
        changed = variants.variant(SOURCE, 'direct-clients')
        self.assertIn('            no_network();\n            synthetic_egress();', changed)
        self.assertIn('int expected = family == AF_INET ? ENETUNREACH : EADDRNOTAVAIL;', changed)
        self.assertIn('blocked = blocked && result == -1 && observed == expected;', changed)
        self.assertIn('require(blocked, "external-interface");', changed)
        self.assertIn('SOCK_NONBLOCK | SOCK_CLOEXEC', changed)
        self.assertIn('198.51.100.1', changed)
        self.assertIn('2001:db8::1', changed)
        self.assertEqual(changed.count('unshare(CLONE_NEWNET | CLONE_NEWNS'), 1)
    def test_exact_mutation_anchors_refuse_drift(self):
        for source in ('', 'a a'):
            with self.assertRaises(ValueError):
                variants.replace_once(source, 'a', 'b')

    def test_ready_and_reap_variants_preserve_governing_time_budgets(self):
        for name in ('ready-outer', 'ready-nested', 'reap-outer', 'reap-nested'):
            changed = variants.variant(SOURCE, name)
            for budget in ('monotonic_ms() - started < 1000', 'poll(&dead, 1, 250)', 'monotonic_ms() - started < 1500'):
                self.assertIn(budget, changed)
            self.assertIn('seed_fence();', changed)
            self.assertIn('prctl(PR_SET_DUMPABLE, 0)', changed)

    def test_transition_stalls_are_probe_only_and_cover_outer_and_nested(self):
        for scope in ('outer', 'nested'):
            for number in range(1, 7):
                name = f'stall-{scope}-B{number}'
                changed = variants.variant(SOURCE, name)
                self.assertEqual(changed.count('SYNTHETIC_TRANSITION:'), 1)
                condition = 'nested' if scope == 'nested' else '!nested'
                self.assertIn(f'if (synthetic_probe && {condition})', changed)
                self.assertIn('synthetic_probe = probe;', changed)
                self.assertIn('seed_fence();', changed)

    def test_syscall_stimuli_do_not_change_filter_and_require_observed_sigsys(self):
        fence = SOURCE[SOURCE.index('static void seed_fence'):SOURCE.index('static void seed_main')]
        for name in ('open', 'socket', 'connect', 'recvmsg', 'setns', 'unshare', 'mount', 'clone', 'prctl', 'x32'):
            changed = variants.variant(SOURCE, 'sf-' + name)
            self.assertIn(fence, changed)
            self.assertIn('(synthetic_status.si_code == CLD_KILLED || synthetic_status.si_code == CLD_DUMPED)', changed)
            self.assertIn('synthetic_status.si_status == SIGSYS, "namespace-seed"', changed)
            self.assertLess(changed.index('seed_fence();'), changed.index('    for (;;) syscall(SYS_pause);'))

    def test_mapping_and_first_error_controls_remain_closed(self):
        self.assertEqual(variants.variant(SOURCE, 'map-write').count('seed_map(seed, "uid_map", mapping);'), 2)
        self.assertIn('require(false && ancestry, "namespace-identity")', variants.variant(SOURCE, 'b3-failure'))
        with self.assertRaises((KeyError, ValueError)):
            variants.variant(SOURCE, 'SYNTHETIC_PRIVATE')

    def test_ancestry_stimulus_is_explicitly_unfenced_but_preserves_the_ancestry_predicate(self):
        changed = variants.variant(SOURCE, 'ancestry')
        self.assertIn('unshare(CLONE_NEWUSER)', changed)
        self.assertNotIn('    seed_fence();', changed)
        self.assertIn('require(ancestry, "namespace-identity");', changed)
        self.assertNotIn('false && ancestry', changed)
        self.assertIn('ready.st_uid == ADMITTED_UID && *synthetic_nested == 1', changed)


if __name__ == '__main__':
    unittest.main()
