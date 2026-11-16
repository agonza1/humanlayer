"""Single-client loopback NBD export for the synthetic native storage probe.

Wire format: NetworkBlockDevice/nbd doc/proto.md at
6725f91e6a33bc9f62d31d82798c04ec1cde1c73. The in-process frontier covers
this export incarnation and its backing file.
"""

from __future__ import annotations

import fcntl
import os
from pathlib import Path
import re
import socket
import stat
import struct
import threading

SIZE = 64 * 1024 * 1024
MAX_PAYLOAD = 32 * 1024 * 1024
MAX_OPTION = 4096
HEARTBEAT_OFFSET = 4096
PENDING_OFFSET = 8192

_NBD_MAGIC = 0x4E42444D41474943
_OPTION_MAGIC = 0x49484156454F5054
_OPTION_REPLY_MAGIC = 0x0003E889045565A9
_REQUEST_MAGIC = 0x25609513
_REPLY_MAGIC = 0x67446698
_FIXED_NEWSTYLE = 1
_NO_ZEROES = 2
_TRANSMISSION_FLAGS = 1 | 4 | 8  # HAS_FLAGS, SEND_FLUSH, SEND_FUA
_EXPORT_NAME, _ABORT, _INFO, _GO = 1, 2, 6, 7
_ACK, _REP_INFO = 1, 3
_UNSUP, _INVALID, _UNKNOWN, _SHUTDOWN = (0x80000000 | n for n in (1, 3, 6, 7))
_READ, _WRITE, _DISC, _FLUSH = range(4)
_FUA = 1
_EIO, _EINVAL = 5, 22  # Wire errno values.


class _Disconnect(Exception):
    pass


def _receive(sock: socket.socket, length: int) -> bytearray:
    data = bytearray(length)
    remaining = memoryview(data)
    while remaining:
        size = sock.recv_into(remaining)
        if size == 0:
            raise _Disconnect
        remaining = remaining[size:]
    return data


def _pwrite_all(fd: int, data: bytes | bytearray, offset: int) -> None:
    remaining = memoryview(data)
    while remaining:
        size = os.pwrite(fd, remaining, offset)
        if size <= 0:
            raise OSError("zero-length pwrite")
        offset += size
        remaining = remaining[size:]


def _pread_exact(fd: int, length: int, offset: int) -> bytes:
    chunks = []
    while length:
        data = os.pread(fd, length, offset)
        if not data:
            raise OSError("unexpected backing file EOF")
        chunks.append(data)
        offset += len(data)
        length -= len(data)
    return b"".join(chunks)


def _sync_file(fd: int) -> None:
    if hasattr(fcntl, "F_FULLFSYNC"):
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
    else:
        os.fsync(fd)


def _shutdown(sock: socket.socket) -> None:
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass  # An already disconnected socket can still be joined and closed.


def _option_reply(sock: socket.socket, option: int, reply: int, data: bytes = b"") -> None:
    sock.sendall(struct.pack("!QIII", _OPTION_REPLY_MAGIC, option, reply, len(data)) + data)


def _reply(sock: socket.socket, cookie: int, error: int = 0, data: bytes = b"") -> None:
    sock.sendall(struct.pack("!IIQ", _REPLY_MAGIC, error, cookie))
    if data:
        sock.sendall(data)


class ProbeExport:
    """Own one new scratch file, listener, and serial NBD request worker."""

    def __init__(self, path: Path, nonce: str):
        if not re.fullmatch(r"[0-9a-f]{32}", nonce):
            raise ValueError("nonce must be 32 lowercase hex characters")
        self.path = Path(path)
        self.nonce = nonce
        self._export_name = nonce.encode("ascii")
        self._marker = f"HL40B8_NATIVE_PROBE:{nonce}".encode("ascii")
        self._pending_prefix = f"HL40B8:PENDING:{nonce}".encode("ascii")
        self._heartbeat_pattern = re.compile(
            rb"HL40B8:HEARTBEAT:" + self._export_name
            + rb":([0-9]{1,20}):([0-9]{1,10}):([0-9]{1,10})(?=[\x00\n\r ]|\Z)"
        )
        self._changed = threading.Condition()
        self._release = threading.Event()
        self._uri: str | None = None
        self._listener: socket.socket | None = None
        self._client: socket.socket | None = None
        self._worker: threading.Thread | None = None
        self._drain_worker: threading.Thread | None = None
        self._fd: int | None = None
        self._frontier = 0
        self._completed_frontier = 0
        self._sealed_frontier: int | None = None
        self._pending_seq: int | None = None
        self._held_seq: int | None = None
        self._held_applied = False
        self._heartbeat: dict[str, int] | None = None
        self._failure: str | None = None
        self._listener_closed = False
        self._tcp_joined = False
        self._file_synced = False
        self._file_closed = False
        self._drain_finished = False
        self._drained = False

    def start(self) -> str:
        with self._changed:
            if self._sealed_frontier is not None:
                raise RuntimeError("sealed export cannot restart")
            if self._uri is not None:
                return self._uri
            flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            fd = os.open(self.path, flags, 0o600)
            listener = None
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise OSError("backing file is not regular")
                os.fchmod(fd, 0o600)
                os.ftruncate(fd, SIZE)
                _pwrite_all(fd, self._marker, 0)
                _sync_file(fd)
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                uri = f"nbd://127.0.0.1:{listener.getsockname()[1]}/{self.nonce}"
                worker = threading.Thread(
                    target=self._serve, args=(listener, fd), name="probe-nbd", daemon=True
                )
                worker.start()
            except BaseException:
                if listener is not None:
                    listener.close()
                os.close(fd)
                raise
            self._listener = listener
            self._fd = fd
            self._worker = worker
            self._uri = uri
            return uri

    def snapshot(self) -> dict:
        with self._changed:
            return self._snapshot_locked()

    def _snapshot_locked(self) -> dict:
        return {
            "nonce": self.nonce,
            "frontier": self._frontier,
            "completed_frontier": self._completed_frontier,
            "sealed": self._sealed_frontier is not None,
            "sealed_frontier": self._sealed_frontier,
            "pending_count": int(self._pending_seq is not None),
            "held_seq": self._held_seq,
            "held_applied": self._held_applied,
            "applied_marker": self._pending_prefix.decode("ascii") if self._held_applied else None,
            "heartbeat": self._heartbeat.copy() if self._heartbeat is not None else None,
            "drained": self._drained,
            "failure": self._failure,
            "tcp_joined": self._tcp_joined,
            "file_synced": self._file_synced,
            "file_closed": self._file_closed,
        }

    def wait_workload(self, timeout: float) -> dict:
        with self._changed:
            ready = self._changed.wait_for(
                lambda: self._workload_ready() or self._failure is not None
                or self._sealed_frontier is not None,
                timeout,
            )
            if self._failure is not None:
                raise RuntimeError(self._failure)
            if self._sealed_frontier is not None:
                raise RuntimeError("export sealed while waiting for workload")
            if not ready:
                raise TimeoutError("waiting for completed heartbeat and admitted held write")
            return self._snapshot_locked()

    def _workload_ready(self) -> bool:
        return (
            self._heartbeat is not None
            and self._held_seq is not None
            and self._pending_seq == self._held_seq
        )

    def seal(self) -> dict:
        with self._changed:
            if self._listener is None:
                raise RuntimeError("export has not started")
            if self._sealed_frontier is None:
                self._sealed_frontier = self._frontier
                # accept() can have returned just before shutdown. The worker
                # checks this same seal under the lock before owning that socket.
                _shutdown(self._listener)
                try:
                    self._listener.close()
                    self._listener_closed = True
                except OSError as exc:
                    self._record_failure("close listener", exc)
                self._changed.notify_all()
            return self._snapshot_locked()

    def start_drain(self) -> None:
        with self._changed:
            self._require_sealed()
            if self._drain_worker is not None:
                return
            if self._client is not None:
                _shutdown(self._client)
            drain = threading.Thread(target=self._finish_drain, name="probe-nbd-drain", daemon=True)
            drain.start()
            self._drain_worker = drain

    def release_held(self) -> None:
        with self._changed:
            self._require_sealed()
            self._release.set()

    def _require_sealed(self) -> None:
        if self._sealed_frontier is None:
            raise RuntimeError("seal export admission first")

    def wait_drained(self, timeout: float) -> dict | None:
        with self._changed:
            if not self._changed.wait_for(lambda: self._drain_finished, timeout):
                return None
            return self._snapshot_locked()

    def _finish_drain(self) -> None:
        worker, fd = self._worker, self._fd
        if worker is None or fd is None:
            raise RuntimeError("drain requires an owned worker and file")
        worker.join()
        synced = closed = False
        try:
            # The serial TCP worker owns all pwrite/pread/FUA/flush work. Join
            # it first, then fully sync and close the actual backing descriptor.
            _sync_file(fd)
            synced = True
        except OSError as exc:
            self._record_failure("final sync", exc)
        try:
            os.close(fd)
            closed = True
        except OSError as exc:
            self._record_failure("close backing file", exc)
        with self._changed:
            self._tcp_joined = True
            self._file_synced = synced
            self._file_closed = closed
            self._drained = (
                self._failure is None
                and self._listener_closed
                and self._pending_seq is None
                and self._sealed_frontier == self._frontier == self._completed_frontier
                and synced and closed
            )
            self._drain_finished = True
            self._changed.notify_all()

    def _record_failure(self, stage: str, error: Exception) -> None:
        with self._changed:
            if self._failure is None:
                self._failure = f"{stage}: {error}"
            self._changed.notify_all()

    def _serve(self, listener: socket.socket, fd: int) -> None:
        try:
            while True:
                try:
                    client, _ = listener.accept()
                except OSError:
                    with self._changed:
                        if self._sealed_frontier is not None:
                            return
                    raise
                with client:
                    with self._changed:
                        if self._sealed_frontier is not None or self._failure is not None:
                            return
                        # This single worker serves the entire connection before
                        # accepting another. The backlog grants no export access.
                        self._client = client
                    try:
                        if self._negotiate(client):
                            self._requests(client, fd)
                    except (_Disconnect, OSError):
                        pass  # TCP end alone is never the drain predicate.
                    finally:
                        with self._changed:
                            self._client = None
        except Exception as exc:
            self._record_failure("TCP worker", exc)

    def _negotiate(self, client: socket.socket) -> bool:
        client.sendall(struct.pack("!QQH", _NBD_MAGIC, _OPTION_MAGIC, _FIXED_NEWSTYLE | _NO_ZEROES))
        flags, = struct.unpack("!I", _receive(client, 4))
        if not flags & _FIXED_NEWSTYLE or flags & ~(_FIXED_NEWSTYLE | _NO_ZEROES):
            return False
        while True:
            magic, option, length = struct.unpack("!QII", _receive(client, 16))
            if magic != _OPTION_MAGIC or length > MAX_OPTION:
                return False
            data = _receive(client, length)
            if option == _ABORT:
                _option_reply(client, option, _INVALID if data else _ACK)
                return False
            if option == _EXPORT_NAME:
                if self._export_error(data) is not None:
                    return False  # EXPORT_NAME has no option error reply.
                client.sendall(struct.pack("!QH", SIZE, _TRANSMISSION_FLAGS))
                if not flags & _NO_ZEROES:
                    client.sendall(bytes(124))
                return True
            if option not in (_INFO, _GO):
                _option_reply(client, option, _UNSUP)
                continue
            if len(data) < 6:
                _option_reply(client, option, _INVALID)
                continue
            name_length, = struct.unpack_from("!I", data)
            end = 4 + name_length
            if end + 2 > len(data):
                _option_reply(client, option, _INVALID)
                continue
            count, = struct.unpack_from("!H", data, end)
            if end + 2 + 2 * count != len(data):
                _option_reply(client, option, _INVALID)
                continue
            error = self._export_error(data[4:end])
            if error is not None:
                _option_reply(client, option, error)
                if error == _SHUTDOWN:
                    return False
                continue
            infos = struct.unpack_from(f"!{count}H", data, end + 2)
            _option_reply(client, option, _REP_INFO, struct.pack("!HQH", 0, SIZE, _TRANSMISSION_FLAGS))
            if 1 in infos:
                _option_reply(client, option, _REP_INFO, struct.pack("!H", 1) + self._export_name)
            if 3 in infos:
                _option_reply(client, option, _REP_INFO, struct.pack("!HIII", 3, 1, 4096, MAX_PAYLOAD))
            _option_reply(client, option, _ACK)
            if option == _GO:
                return True

    def _export_error(self, name: bytearray) -> int | None:
        with self._changed:
            if self._sealed_frontier is not None or self._failure is not None:
                return _SHUTDOWN
            return None if name == self._export_name else _UNKNOWN

    def _requests(self, client: socket.socket, fd: int) -> None:
        while True:
            magic, flags, command, cookie, offset, length = struct.unpack(
                "!IHHQQI", _receive(client, 28)
            )
            if magic != _REQUEST_MAGIC or (command == _WRITE and length > MAX_PAYLOAD):
                return  # A bad magic or oversized WRITE cannot be safely framed.
            payload = _receive(client, length) if command == _WRITE else None
            data_command = command in (_READ, _WRITE)
            valid = not flags & ~_FUA and (
                (data_command and 0 < length <= MAX_PAYLOAD and offset + length <= SIZE)
                or (command in (_DISC, _FLUSH) and offset == 0 and length == 0)
            )
            if not valid:
                if command == _DISC:
                    return
                _reply(client, cookie, _EINVAL)
                continue
            marker = offset == PENDING_OFFSET and payload is not None and payload.startswith(self._pending_prefix)
            admitted = self._admit(marker)
            if admitted is None:
                return
            seq, held = admitted
            if held:
                self._release.wait()
            data = b""
            heartbeat = None
            error = 0
            try:
                if command == _READ:
                    data = _pread_exact(fd, length, offset)
                elif command == _WRITE:
                    _pwrite_all(fd, payload, offset)
                    if held:
                        with self._changed:
                            self._held_applied = True
                    if flags & _FUA:
                        _sync_file(fd)
                    if offset == HEARTBEAT_OFFSET:
                        heartbeat = self._parse_heartbeat(payload, seq)
                elif command == _FLUSH:
                    _sync_file(fd)
            except OSError as exc:
                self._record_failure("admitted NBD I/O", exc)
                error = _EIO
            self._complete(seq, heartbeat)
            if command == _DISC:
                return
            _reply(client, cookie, error, data)
            if error:
                return

    def _admit(self, hold: bool) -> tuple[int, bool] | None:
        with self._changed:
            # The full, bounded payload is present before reaching this point.
            # This lock makes the accepted sequence and seal a single frontier.
            if self._sealed_frontier is not None or self._failure is not None:
                return None
            self._frontier += 1
            seq = self._frontier
            self._pending_seq = seq
            held = hold and self._held_seq is None
            if held:
                self._held_seq = seq
            self._changed.notify_all()
            return seq, held

    def _complete(self, seq: int, heartbeat: dict[str, int] | None) -> None:
        with self._changed:
            if self._pending_seq != seq or self._completed_frontier + 1 != seq:
                raise RuntimeError("non-contiguous NBD completion")
            self._completed_frontier = seq
            self._pending_seq = None
            if heartbeat is not None:
                self._heartbeat = heartbeat
            self._changed.notify_all()

    def _parse_heartbeat(self, payload: bytearray, seq: int) -> dict[str, int] | None:
        match = self._heartbeat_pattern.match(payload)
        if match is None:
            return None
        counter, pid, ppid = map(int, match.groups())
        if pid <= 0 or ppid <= 0 or pid == ppid:
            return None
        return {"counter": counter, "pid": pid, "ppid": ppid, "sequence": seq}
