import errno
import io
import json
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock
from contextlib import ExitStack, redirect_stdout

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('peer', Path(__file__).with_name('peer-observe.py'))
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


class PeerObservations(unittest.TestCase):
    def test_holder_access_refusal_is_explicit_nonconstruction(self):
        output = io.StringIO()
        with mock.patch.object(peer, 'bounded_read', side_effect=PermissionError(errno.EACCES, 'SYNTHETIC_PRIVATE')):
            with redirect_stdout(output):
                peer.hold((10, 20))
        self.assertEqual(json.loads(output.getvalue()), {'constructed': False, 'reason': 'EACCES'})

    def test_holder_releases_only_its_fd_after_rechecking_namespace_identity(self):
        output = io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(peer, 'bounded_read', return_value=''))
            stack.enter_context(mock.patch.object(peer, 'parse_stat', return_value={'start': 20}))
            stack.enter_context(mock.patch.object(peer.os, 'O_CLOEXEC', 0o2000000, create=True))
            stack.enter_context(mock.patch.object(peer.os, 'open', return_value=7))
            stack.enter_context(mock.patch.object(peer.os, 'getpid', return_value=99))
            stack.enter_context(mock.patch.object(peer.os, 'fstat', return_value=mock.Mock(st_dev=4, st_ino=8)))
            closed = stack.enter_context(mock.patch.object(peer.os, 'close'))
            stream = mock.Mock()
            stream.buffer.read.return_value = b''
            stack.enter_context(mock.patch.object(sys, 'stdin', stream))
            stack.enter_context(mock.patch.object(peer.select, 'select', return_value=([stream], [], [])))
            with redirect_stdout(output):
                peer.hold((10, 20))
        lines = output.getvalue().splitlines()
        self.assertEqual(json.loads(lines[0]), {'constructed': True, 'device': 4, 'inode': 8, 'pid': 99, 'start': 20})
        self.assertEqual(lines[1], 'provider-boundary-peer-holder:released;namespace-valid=true')
        closed.assert_called_once_with(7)
    def test_only_closed_pid_start_or_namespace_identity_pairs_are_accepted(self):
        self.assertEqual(peer.pairs('10:20,30:40'), [(10, 20), (30, 40)])
        for text in ('', 'SYNTHETIC_PRIVATE', '10:20:', '1:2,' * 257):
            with self.assertRaises(ValueError):
                peer.pairs(text)

    def test_readable_peer_handle_is_closed_and_not_claimed_revoked(self):
        with mock.patch.object(peer, 'bounded_read', return_value=''), mock.patch.object(peer, 'parse_stat', return_value={'start': 20}), mock.patch.object(peer.os, 'O_CLOEXEC', 0o2000000, create=True), mock.patch.object(peer.os, 'open', return_value=7), mock.patch.object(peer.os, 'close') as close:
            self.assertEqual(peer.reach([(10, 20)]), [{'pid': 10, 'start': 20, 'observation': 'readable'}])
            close.assert_called_once_with(7)

    def test_access_refusal_and_unknown_are_not_absence(self):
        for error, expected in ((errno.EACCES, 'EACCES'), (errno.EPERM, 'EPERM'), (errno.EIO, 'unknown')):
            with mock.patch.object(peer, 'bounded_read', side_effect=OSError(error, 'SYNTHETIC_PRIVATE')):
                self.assertEqual(peer.reach([(10, 20)])[0]['observation'], expected)

    def test_identity_reuse_does_not_open_the_new_process_namespace(self):
        with mock.patch.object(peer, 'bounded_read', return_value=''), mock.patch.object(peer, 'parse_stat', return_value={'start': 21}), mock.patch.object(peer.os, 'open') as opened:
            self.assertEqual(peer.reach([(10, 20)])[0]['observation'], 'gone')
            opened.assert_not_called()

    def test_unparseable_stat_is_unknown_not_absent(self):
        with mock.patch.object(peer, 'bounded_read', return_value='malformed'):
            self.assertEqual(peer.reach([(10, 20)])[0]['observation'], 'unknown')


if __name__ == '__main__':
    unittest.main()
