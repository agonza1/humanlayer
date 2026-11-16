"""Exercise the scratch export with actual fixed-newstyle NBD wire frames."""

import os
from pathlib import Path
import socket
import stat
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlparse

import probe_export
from probe_export import ProbeExport

NONCE = "0123456789abcdef" * 2
SIZE = 64 * 1024 * 1024
MARKER = f"HL40B8_NATIVE_PROBE:{NONCE}".encode()
PENDING = f"HL40B8:PENDING:{NONCE}".encode()
OPTION_MAGIC = 0x49484156454F5054


def exact(client, size):
    chunks = bytearray()
    while len(chunks) < size:
        block = client.recv(size - len(chunks))
        if not block:
            raise EOFError("short NBD reply")
        chunks.extend(block)
    return bytes(chunks)


def option(client, code, data=b""):
    client.sendall(struct.pack("!QII", OPTION_MAGIC, code, len(data)) + data)


def info_request(name, *infos):
    return struct.pack("!I", len(name)) + name + struct.pack(f"!H{len(infos)}H", len(infos), *infos)


def request(client, code, cookie, *, offset=0, length=0, flags=0, payload=b""):
    client.sendall(struct.pack("!IHHQQI", 0x25609513, flags, code, cookie, offset, length) + payload)


class ProbeExportTests(unittest.TestCase):
    def setUp(self):
        scratch = self.enterContext(tempfile.TemporaryDirectory(prefix="probe-export-test-"))
        self.path = Path(scratch) / "fixture.img"
        self.export = ProbeExport(self.path, NONCE)
        self.uri = urlparse(self.export.start())
        self.assertEqual((self.uri.scheme, self.uri.hostname, self.uri.path), ("nbd", "127.0.0.1", f"/{NONCE}"))
        self.addCleanup(self.clean_export)

    def clean_export(self):
        self.export.seal()
        self.export.release_held()
        self.export.start_drain()
        snapshot = self.export.wait_drained(3)
        self.assertIsNotNone(snapshot)
        self.assertTrue(snapshot["file_closed"])

    def connect(self, flags=3):
        client = socket.create_connection((self.uri.hostname, self.uri.port), timeout=2)
        self.addCleanup(client.close)
        self.assertEqual(struct.unpack("!QQH", exact(client, 18)), (0x4E42444D41474943, OPTION_MAGIC, 3))
        client.sendall(struct.pack("!I", flags))
        return client

    def option_reply(self, client, code, status):
        magic, option_code, reply, size = struct.unpack("!QIII", exact(client, 20))
        self.assertEqual((magic, option_code, reply), (0x0003E889045565A9, code, status))
        self.assertLessEqual(size, 4096)
        return exact(client, size)

    def go(self, client):
        option(client, 7, info_request(NONCE.encode(), 3))
        self.assertEqual(self.option_reply(client, 7, 3), struct.pack("!HQH", 0, SIZE, 13))
        self.assertEqual(self.option_reply(client, 7, 3), struct.pack("!HIII", 3, 1, 4096, 32 * 1024 * 1024))
        self.assertEqual(self.option_reply(client, 7, 1), b"")

    def reply(self, client, cookie, error=0):
        self.assertEqual(struct.unpack("!IIQ", exact(client, 16)), (0x67446698, error, cookie))

    def file_at(self, offset, size):
        fd = os.open(self.path, os.O_RDONLY)
        try:
            return os.pread(fd, size, offset)
        finally:
            os.close(fd)

    def expect_disconnect(self, client):
        try:
            self.assertEqual(client.recv(1), b"")
        except ConnectionResetError:
            pass

    def test_info_go_and_real_reads_writes(self):
        self.assertEqual(self.path.stat().st_size, SIZE)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertTrue(stat.S_ISREG(self.path.stat().st_mode))
        client = self.connect()
        option(client, 6, info_request(NONCE.encode(), 1))
        self.assertEqual(self.option_reply(client, 6, 3), struct.pack("!HQH", 0, SIZE, 13))
        self.assertEqual(self.option_reply(client, 6, 3), b"\x00\x01" + NONCE.encode())
        self.option_reply(client, 6, 1)
        self.go(client)
        request(client, 0, 10, length=len(MARKER), flags=1)
        self.reply(client, 10)
        self.assertEqual(exact(client, len(MARKER)), MARKER)
        request(client, 1, 11, offset=12345, length=3, payload=b"abc")
        self.reply(client, 11)
        self.assertEqual(self.file_at(12345, 3), b"abc")
        request(client, 0, 12, offset=12345, length=3)
        self.reply(client, 12)
        self.assertEqual(exact(client, 3), b"abc")
        request(client, 2, 13)
        self.expect_disconnect(client)
        self.assertEqual(self.export.snapshot()["completed_frontier"], 4)
        self.assertFalse(self.export.snapshot()["drained"])

    def test_wrong_export_and_legacy_padding(self):
        client = self.connect()
        option(client, 7, info_request(b"0" * 32))
        self.assertEqual(self.option_reply(client, 7, 0x80000006), b"")
        option(client, 1, b"0" * 32)
        self.expect_disconnect(client)
        client.close()
        client = self.connect(flags=1)
        option(client, 1, NONCE.encode())
        self.assertEqual(struct.unpack("!QH", exact(client, 10)), (SIZE, 13))
        self.assertEqual(exact(client, 124), bytes(124))
        request(client, 0, 16, length=len(MARKER))
        self.reply(client, 16)
        self.assertEqual(exact(client, len(MARKER)), MARKER)
        self.assertEqual(self.export.snapshot()["frontier"], 1)

    def test_rejects_unsupported_invalid_and_oversized_frames(self):
        client = self.connect()
        option(client, 8)
        self.option_reply(client, 8, 0x80000001)
        option(client, 6, b"\x00\x00\x00\x20\x00\x01")
        self.option_reply(client, 6, 0x80000003)
        self.go(client)
        request(client, 4, 20, offset=4096, length=4096)  # TRIM
        self.reply(client, 20, 22)
        request(client, 6, 21, offset=4096, length=4096)  # WRITE_ZEROES
        self.reply(client, 21, 22)
        request(client, 1, 22, offset=SIZE - 1, length=2, payload=b"xx")
        self.reply(client, 22, 22)
        request(client, 1, 23, offset=4096, length=2, flags=2, payload=b"xx")
        self.reply(client, 23, 22)
        request(client, 0, 24, offset=0, length=32 * 1024 * 1024 + 1)
        self.reply(client, 24, 22)
        self.assertEqual(self.export.snapshot()["frontier"], 0)
        request(client, 1, 25, offset=4096, length=32 * 1024 * 1024 + 1)
        self.expect_disconnect(client)
        self.assertEqual(self.file_at(4096, 2), b"\x00\x00")
        self.assertEqual(self.export.snapshot()["frontier"], 0)

    def test_seal_rejects_connection_still_negotiating(self):
        client = self.connect()
        queued = socket.create_connection((self.uri.hostname, self.uri.port), timeout=2)
        self.addCleanup(queued.close)
        snapshot = self.export.seal()
        self.assertEqual(snapshot["sealed_frontier"], 0)
        option(client, 7, info_request(NONCE.encode()))
        self.option_reply(client, 7, 0x80000007)
        self.expect_disconnect(queued)
        self.assertEqual(self.export.snapshot()["frontier"], 0)

    def test_seal_wins_against_incomplete_write_frame(self):
        client = self.connect()
        self.go(client)
        request(client, 1, 28, offset=8192, length=len(PENDING) + 1, payload=PENDING)
        self.assertEqual(self.export.seal()["sealed_frontier"], 0)
        client.sendall(b"\x00")
        self.expect_disconnect(client)
        self.assertEqual(self.export.snapshot()["pending_count"], 0)
        self.assertEqual(self.file_at(8192, len(PENDING)), bytes(len(PENDING)))

    def test_admitted_hold_survives_eof_seal_and_join(self):
        client = self.connect()
        self.go(client)
        with self.assertRaises(RuntimeError):
            self.export.release_held()
        with self.assertRaises(RuntimeError):
            self.export.start_drain()
        with self.assertRaises(TimeoutError):
            self.export.wait_workload(0)
        heartbeat = f"HL40B8:HEARTBEAT:{NONCE}:7:4242:1".encode().ljust(4096, b"\x00")
        request(client, 1, 29, offset=4096, length=len(heartbeat), payload=heartbeat, flags=1)
        self.reply(client, 29)
        payload = PENDING.ljust(4096, b"\x00")
        request(client, 1, 30, offset=8192, length=len(payload), payload=payload, flags=1)
        workload = self.export.wait_workload(2)
        self.assertEqual(workload["heartbeat"], {"counter": 7, "pid": 4242, "ppid": 1, "sequence": 1})
        self.assertEqual((workload["frontier"], workload["completed_frontier"], workload["held_seq"]), (2, 1, 2))
        client.shutdown(socket.SHUT_RDWR)
        client.close()
        sealed = self.export.seal()
        self.assertEqual(self.export.seal(), sealed)
        self.assertTrue(sealed["sealed"])
        self.assertFalse(sealed["drained"])
        self.assertFalse(sealed["held_applied"])
        self.assertEqual(sealed["pending_count"], 1)
        with self.assertRaises(ConnectionRefusedError):
            socket.create_connection((self.uri.hostname, self.uri.port), timeout=1)
        self.export.start_drain()
        self.export.start_drain()
        self.assertIsNone(self.export.wait_drained(0.05))
        self.assertEqual(self.file_at(8192, len(PENDING)), bytes(len(PENDING)))
        self.export.release_held()
        self.export.release_held()
        final = self.export.wait_drained(2)
        self.assertIsNotNone(final)
        for key in ("drained", "tcp_joined", "file_synced", "file_closed", "held_applied"):
            self.assertTrue(final[key], key)
        self.assertEqual(final["sealed_frontier"], final["completed_frontier"])
        self.assertEqual(final["pending_count"], 0)
        self.assertEqual(final["applied_marker"], PENDING.decode())
        self.assertIsNone(final["failure"])
        self.assertEqual(self.file_at(8192, len(payload)), payload)
        self.assertEqual(self.export.wait_drained(0), final)
        with self.assertRaises(RuntimeError):
            self.export.start()

    def test_fua_flush_and_final_drain_wait_for_real_sync(self):
        client = self.connect()
        self.go(client)
        entered = threading.Event()
        release = threading.Event()
        sync_file = probe_export._sync_file

        def delayed_sync(fd):
            entered.set()
            if not release.wait(2):
                raise OSError("test sync gate timed out")
            sync_file(fd)

        try:
            with patch.object(probe_export, "_sync_file", delayed_sync):
                for code, cookie in ((1, 31), (3, 32)):
                    entered.clear()
                    release.clear()
                    args = dict(offset=2048, length=1, payload=b"x", flags=1) if code == 1 else {}
                    request(client, code, cookie, **args)
                    self.assertTrue(entered.wait(1))
                    self.assertEqual(self.export.snapshot()["pending_count"], 1)
                    client.settimeout(0.05)
                    with self.assertRaises(TimeoutError):
                        client.recv(1)
                    client.settimeout(2)
                    release.set()
                    self.reply(client, cookie)
                entered.clear()
                release.clear()
                self.export.seal()
                self.export.start_drain()
                self.assertTrue(entered.wait(1))
                self.assertIsNone(self.export.wait_drained(0))
                self.assertFalse(self.export.snapshot()["file_closed"])
                release.set()
                final = self.export.wait_drained(2)
                self.assertIsNotNone(final)
                self.assertTrue(final["drained"])
        finally:
            release.set()

    def test_admitted_write_failure_remains_uncertain_after_final_sync(self):
        client = self.connect()
        self.go(client)
        with patch.object(probe_export, "_pwrite_all", side_effect=OSError("synthetic pwrite failure")):
            request(client, 1, 34, offset=2048, length=1, payload=b"x")
            self.reply(client, 34, 5)
        self.assertEqual(self.export.seal()["sealed_frontier"], 1)
        self.export.start_drain()
        final = self.export.wait_drained(2)
        self.assertIsNotNone(final)
        self.assertEqual(final["completed_frontier"], 1)
        self.assertTrue(final["file_synced"])
        self.assertTrue(final["file_closed"])
        self.assertFalse(final["drained"])
        self.assertIn("synthetic pwrite failure", final["failure"])
        self.assertEqual(self.file_at(2048, 1), b"\x00")

    def test_final_sync_failure_closes_file_but_withholds_positive_drain(self):
        self.export.seal()
        with patch.object(probe_export, "_sync_file", side_effect=OSError("synthetic final sync failure")):
            self.export.start_drain()
            final = self.export.wait_drained(2)
        self.assertIsNotNone(final)
        self.assertTrue(final["tcp_joined"])
        self.assertTrue(final["file_closed"])
        self.assertFalse(final["file_synced"])
        self.assertFalse(final["drained"])
        self.assertIn("synthetic final sync failure", final["failure"])

    def test_exclusive_file_and_nonce(self):
        before = self.file_at(0, len(MARKER))
        with self.assertRaises(FileExistsError):
            ProbeExport(self.path, NONCE).start()
        self.assertEqual(self.file_at(0, len(MARKER)), before)
        with self.assertRaises(ValueError):
            ProbeExport(self.path, NONCE.upper())


if __name__ == "__main__":
    unittest.main()
