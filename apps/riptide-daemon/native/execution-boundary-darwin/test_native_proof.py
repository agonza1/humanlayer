"""Run the host proof sequence with real storage and a controlled native witness."""

import json
import socket
import struct
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from native_proof import has_pending_marker, pending_at_fence, stop_and_drain
from probe_export import ProbeExport
from test_probe_export import NONCE, PENDING, exact, option, request

DIGEST = "a" * 64
PACKET = {"nonce": NONCE, "stopID": "retained-stop", "challenge": "c" * 32}


class NativeWitness:
    def __init__(self, export, stale=False):
        self.export = export
        self.stale = stale
        self.frontier = None

    def command(self, line):
        self.frontier = int(line.removeprefix("stop "))
        if not pending_at_fence(self.export.snapshot(), NONCE, self.frontier):
            raise AssertionError("Stop command must follow seal with a pending write")

    def event(self, timeout):
        if timeout <= 0:
            return None
        return {
            "event": "native-stopped", "nonce": NONCE, "boundaryDigest": DIGEST, "controllerEpoch": 1,
            "stopID": PACKET["stopID"], "fenceSequence": self.frontier, "proofRevision": 1,
            "challenge": "different" if self.stale else PACKET["challenge"], "frameworkState": "stopped",
        }


class NativeSequenceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="native-proof-test-")))
        self.disk = self.root / "probe.img"
        self.intent = self.root / "stop-intent.json"
        self.export = ProbeExport(self.disk, NONCE)
        self.uri = self.export.start()
        self.addCleanup(self.cleanup_export)
        endpoint = urlparse(self.uri)
        client = self.enterContext(socket.create_connection((endpoint.hostname, endpoint.port), timeout=2))
        exact(client, 18)
        client.sendall(struct.pack("!I", 3))
        option(client, 1, NONCE.encode("ascii"))
        self.assertEqual(struct.unpack("!QH", exact(client, 10)), (64 << 20, 13))
        heartbeat = ("HL40B8:HEARTBEAT:" + NONCE + ":1:100:1\n").encode("ascii")
        request(client, 1, 11, offset=4096, length=4096, payload=heartbeat.ljust(4096, b"\0"))
        self.assertEqual(struct.unpack("!IIQ", exact(client, 16)), (0x67446698, 0, 11))
        request(client, 1, 12, offset=8192, length=4096, payload=PENDING.ljust(4096, b"\0"))
        self.export.wait_workload(2)

    def cleanup_export(self):
        self.export.seal()
        self.export.start_drain()
        self.export.release_held()
        self.assertIsNotNone(self.export.wait_drained(3))

    def test_held_write_stays_pending_until_after_the_matched_native_witness(self):
        report = {}
        self.assertFalse(has_pending_marker(self.disk, NONCE))
        stop_and_drain(NativeWitness(self.export), self.export, self.uri, self.disk, PACKET, DIGEST,
                       self.intent, report)
        self.assertEqual(json.loads(self.intent.read_text())["fenceSequence"], 2)
        self.assertEqual(report["pendingAfterNativeStop"]["pending_count"], 1)
        self.assertTrue(report["drained"]["file_closed"])
        self.assertTrue(has_pending_marker(self.disk, NONCE))

    def test_stale_native_witness_never_releases_the_held_write(self):
        report = {}
        with self.assertRaisesRegex(RuntimeError, "matching"):
            stop_and_drain(NativeWitness(self.export, stale=True), self.export, self.uri, self.disk,
                           PACKET, DIGEST, self.intent, report)
        self.assertNotIn("nativeStop", report)
        self.assertNotIn("drained", report)
        self.assertTrue(pending_at_fence(self.export.snapshot(), NONCE, 2))
        self.assertFalse(has_pending_marker(self.disk, NONCE))


if __name__ == "__main__":
    unittest.main()
