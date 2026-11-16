#!/usr/bin/env python3
"""Prepare or execute one explicitly approved, local macOS feasibility proof."""

import argparse
import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import socket
import stat
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from probe_export import ProbeExport

GIB = 1 << 30
BUILD = "26A434"
IMAGE_BYTES = 26_637_307_067
IMAGE_URL = (
    "https://updates.cdn-apple.com/2026FallFCS/59241290-5d51-4ca8-9df4-31624b9a4eac/"
    "UniversalMac_27.0.1_26A434_Restore.ipsw"
)
IMAGE_ETAG = '"8faf3ef623fa1c181712440496ccc188-3175"'
SYSTEM_DISK = 44 * GIB
HOST_RESERVE = 8 * GIB
START_FREE = SYSTEM_DISK + HOST_RESERVE + GIB
RUN_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C"}


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def canonical(path):
    path = Path(path).absolute()
    require(path.resolve(strict=True) == path, "Proof input must have a canonical path")
    return path


def identity(path):
    info = Path(path).stat()
    require(stat.S_ISREG(info.st_mode), "Proof input must be a regular file")
    return {"device": info.st_dev, "inode": info.st_ino, "size": info.st_size, "mtime": info.st_mtime_ns}


def write_new_json(path, record):
    data = (json.dumps(record, indent=2, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    return hashlib.sha256(data).hexdigest()


def probe(binary, *args):
    result = subprocess.run(
        [str(binary), *args], capture_output=True, text=True, timeout=60, env=RUN_ENV, check=False
    )
    require(result.returncode == 0, "Native preflight failed: " + result.stdout.strip() + result.stderr.strip())
    return json.loads(result.stdout)


def prepared_asset(path):
    path = canonical(path)
    return {"path": str(path), "identity": identity(path), "sha256": sha256(path)}


def check_free(path, minimum):
    free = shutil.disk_usage(path).free
    require(free >= minimum, "Task volume has insufficient free space for this proof and host reserve")
    return free


def prepare(build_directory, download_record, output):
    build_dir = canonical(build_directory)
    output = Path(output).absolute()
    bundle = canonical(output.parent)
    require(not output.exists(), "Boot packet already exists")
    require(bundle.stat().st_uid == os.getuid() and bundle.stat().st_mode & 0o077 == 0,
            "Boot packet requires a private owner directory")
    download = json.loads(Path(download_record).read_text())
    image = canonical(download["asset"])
    require(
        download["url"] == IMAGE_URL and download["etag"] == IMAGE_ETAG
        and download["expectedBytes"] == IMAGE_BYTES and download["build"] == BUILD
        and identity(image)["size"] == IMAGE_BYTES
        and re.fullmatch(r"[a-f0-9]{64}", download["localSha256"]) is not None,
        "Download record does not match the pinned Apple asset",
    )
    binary = build_dir / "HLNativeProof"
    image_check = build_dir / "HLImageCheck"
    assets = {name: prepared_asset(path) for name, path in {
        "runner": binary,
        "imageCheck": image_check,
        "fixtureISO": build_dir / "fixture.iso",
        "entitlements": build_dir / "proof-entitlements.plist",
        "launcher": Path(__file__),
        "storage": Path(__file__).with_name("probe_export.py"),
    }.items()}
    image_receipt = probe(image_check, "inspect-image", str(image))
    require(
        image_receipt.get("event") == "restore-image" and image_receipt.get("build") == BUILD
        and all(image_receipt.get(key) is True for key in ("supported", "frameworkSupported", "hardwareModelSupported"))
        and 0 < image_receipt.get("minimumCPU", 0) <= 4
        and 0 < image_receipt.get("minimumMemory", 0) <= 8 * GIB
        and image_receipt.get("proofCPU") == 4
        and image_receipt.get("proofMemory") == 8 * GIB
        and image_receipt.get("proofDisk") == SYSTEM_DISK,
        "Local Virtualization image compatibility was not established",
    )
    nonce = secrets.token_hex(16)
    endpoint = "nbd://127.0.0.1:10809/" + nonce
    require(probe(image_check, "validate-export", endpoint, nonce) == {"event": "export-uri-validated"},
            "Framework did not validate the private NBD URL form")
    boot_root = bundle / ("run-" + nonce)
    require(not boot_root.exists(), "Run directory already exists")
    packet = {
        "version": 1,
        "purpose": "one disposable macOS native stop and probe export drain",
        "runDirectory": str(boot_root),
        "nonce": nonce,
        "stopID": str(uuid.uuid4()),
        "challenge": secrets.token_hex(16),
        "image": {"path": str(image), "identity": identity(image), "sha256": download["localSha256"],
                  "url": IMAGE_URL, "etag": IMAGE_ETAG, "build": BUILD},
        "localImageCompatibility": image_receipt,
        "assets": assets,
        "resources": {"virtualMachines": 1, "cpu": 4, "memoryBytes": 8 * GIB, "systemDiskBytes": SYSTEM_DISK,
                      "probeDiskBytes": 64 << 20, "hostReserveBytes": HOST_RESERVE,
                      "freeBytesAtPrepare": check_free(bundle, START_FREE)},
        "scope": {"guestNICs": 0, "hostShares": 0, "certifiedStorage": "64 MiB probe export only",
                  "bootDiskAndAuxiliaryIO": "not attested by the export"},
    }
    digest = write_new_json(output, packet)
    print(json.dumps({"packet": str(output), "sha256": digest, "image": image_receipt,
                      "runDirectory": str(boot_root), "resources": packet["resources"]}))


def verify_packet(path, expected):
    path = canonical(path)
    require(sha256(path) == expected, "Boot packet differs from the reviewed bytes")
    data = json.loads(path.read_text())
    require(data.get("version") == 1 and re.fullmatch(r"[a-f0-9]{32}", data.get("nonce", "")),
            "Invalid proof packet")
    run_dir = path.parent / ("run-" + data["nonce"])
    require(Path(data["runDirectory"]) == run_dir and not run_dir.exists(),
            "Expected a fresh run directory for this packet")
    require(data["assets"]["launcher"]["path"] == str(canonical(Path(__file__))),
            "Run this packet with its recorded launcher")
    require(data["assets"]["storage"]["path"] == str(canonical(Path(__file__).with_name("probe_export.py"))),
            "Run this packet with its recorded export")
    for asset in [*data["assets"].values(), data["image"]]:
        source = canonical(asset["path"])
        require(identity(source) == asset["identity"] and sha256(source) == asset["sha256"],
                "A prepared asset changed before boot")
    check_free(path.parent, START_FREE)
    return data, run_dir


class NativeChild:
    def __init__(self, binary, args, log):
        self.events = queue.Queue()
        self.process = subprocess.Popen(
            [str(binary), *args], env=RUN_ENV, text=True,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
        )
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            while True:
                line = self.process.stdout.readline(8192)
                if not line:
                    break
                self.events.put(json.loads(line))
        except (ValueError, OSError) as error:
            self.events.put({"event": "failed", "detail": str(error)})
        finally:
            self.events.put(None)

    def command(self, line):
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def event(self, timeout):
        try:
            event = self.events.get(timeout=max(timeout, 0))
        except queue.Empty:
            return None
        require(event is not None, "Native runner exited before its expected event")
        require(isinstance(event, dict), "Unexpected native event type")
        require(event.get("event") != "failed", "Native runner failed: " + str(event.get("detail", "")))
        return event

    def finish(self, timeout):
        require(self.process.wait(timeout=timeout) == 0, "Native runner exited unsuccessfully")
        self.reader.join(timeout=1)
        self.process.stdin.close()
        self.process.stdout.close()

    def abandon(self, grace):
        if self.process.poll() is None:
            try:
                self.command("cancel")
            except OSError:
                pass
            try:
                self.process.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        self.process.stdin.close()
        self.process.stdout.close()


def matching_stop(event, packet, boundary_digest, frontier):
    return event == {
        "event": "native-stopped", "nonce": packet["nonce"], "boundaryDigest": boundary_digest,
        "controllerEpoch": 1, "stopID": packet["stopID"], "fenceSequence": frontier,
        "proofRevision": 1, "challenge": packet["challenge"], "frameworkState": "stopped",
    } and all(type(event[key]) is int for key in ("controllerEpoch", "fenceSequence", "proofRevision"))


def pending_at_fence(snapshot, nonce, frontier):
    heartbeat = snapshot.get("heartbeat")
    return (
        snapshot.get("nonce") == nonce and snapshot.get("sealed") is True
        and snapshot.get("frontier") == frontier == snapshot.get("sealed_frontier") == snapshot.get("held_seq")
        and snapshot.get("pending_count") == 1 and snapshot.get("held_applied") is False
        and snapshot.get("drained") is False and snapshot.get("file_closed") is False
        and isinstance(heartbeat, dict) and heartbeat.get("ppid") == 1
        and snapshot.get("failure") is None
    )


def drained_at_fence(snapshot, nonce, frontier):
    return (
        snapshot.get("nonce") == nonce and snapshot.get("sealed") is True
        and snapshot.get("frontier") == frontier == snapshot.get("sealed_frontier") == snapshot.get("completed_frontier")
        and snapshot.get("held_seq") == frontier and snapshot.get("pending_count") == 0
        and snapshot.get("failure") is None
        and all(snapshot.get(key) is True for key in ("held_applied", "drained", "tcp_joined", "file_synced", "file_closed"))
    )


def require_reconnect_rejected(uri):
    endpoint = urlparse(uri)
    try:
        connection = socket.create_connection((endpoint.hostname, endpoint.port), timeout=1)
    except ConnectionRefusedError:
        return
    with connection:
        raise RuntimeError("Sealed export still accepted a TCP connection")


def has_pending_marker(path, nonce):
    marker = ("HL40B8:PENDING:" + nonce).encode("ascii")
    with path.open("rb") as disk:
        disk.seek(8192)
        return disk.read(len(marker)) == marker


def stop_and_drain(child, export, uri, disk, packet, expected_digest, stop_record, report):
    nonce = packet["nonce"]
    deadline = time.monotonic() + 30
    sealed = export.seal()
    frontier = sealed["sealed_frontier"]
    require(isinstance(frontier, int) and frontier > 0 and pending_at_fence(sealed, nonce, frontier),
            "Detached writer and held write were not observed at the sealed frontier")
    report["sealed"] = sealed
    require(not has_pending_marker(disk, nonce), "Pending write was already applied before the test release")
    write_new_json(stop_record, {
        "nonce": nonce, "boundaryDigest": expected_digest, "stopID": packet["stopID"],
        "fenceSequence": frontier, "challenge": packet["challenge"], "deadlineMonotonic": deadline,
    })
    child.command("stop " + str(frontier))
    native = child.event(deadline - time.monotonic())
    require(matching_stop(native, packet, expected_digest, frontier),
            "Native stop lacked a matching, completed framework observation")
    report["nativeStop"] = native

    export.start_drain()
    require(export.wait_drained(0.25) is None, "Export reported drain while the admitted write was held")
    held = export.snapshot()
    require(pending_at_fence(held, nonce, frontier), "Storage was no longer pending after native stop")
    require_reconnect_rejected(uri)
    report["pendingAfterNativeStop"] = held
    export.release_held()
    drained = export.wait_drained(max(deadline - time.monotonic(), 0))
    require(drained is not None and time.monotonic() < deadline and drained_at_fence(drained, nonce, frontier),
            "Export did not finish I/O, flush and close at the retained frontier")
    require(has_pending_marker(disk, nonce), "Held write did not reach the backing file")
    require_reconnect_rejected(uri)
    report["drained"] = drained
    report["probeDiskSha256"] = sha256(disk)


def run(path, expected_digest):
    packet, run_dir = verify_packet(path, expected_digest)
    run_dir.mkdir(mode=0o700)
    os.umask(0o077)
    root = run_dir / "macos"
    root.mkdir(mode=0o700)
    binary = run_dir / "HLNativeProof"
    shutil.copy2(packet["assets"]["runner"]["path"], binary)
    log_path = run_dir / "native-stderr.log"
    disk = run_dir / "probe.img"
    child = None
    export = None
    phase = "sign"
    report = {"bootPacketSha256": expected_digest, "status": "uncertain"}
    nonce = packet["nonce"]

    with log_path.open("x") as log:
        try:
            subprocess.run(
                ["/usr/bin/codesign", "--force", "--sign", "-", "--entitlements",
                 packet["assets"]["entitlements"]["path"], str(binary)],
                timeout=60, env=RUN_ENV, check=True, stderr=log,
            )
            subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(binary)],
                           timeout=30, env=RUN_ENV, check=True, stderr=log)
            phase = "install"
            child = NativeChild(binary, ["install", packet["image"]["path"], str(root), BUILD], log)
            limit = time.monotonic() + 30 * 60
            while True:
                check_free(root, HOST_RESERVE)
                require(time.monotonic() < limit, "Installer reached its time limit")
                event = child.event(0.5)
                if event is not None:
                    require(event == {"event": "installed", "build": BUILD}, "Unexpected installer event")
                    break
            child.finish(15)
            child = None

            phase = "boot"
            export = ProbeExport(disk, nonce)
            uri = export.start()
            child = NativeChild(binary, ["boot", str(root), packet["assets"]["fixtureISO"]["path"], uri,
                                         nonce, expected_digest, packet["stopID"], packet["challenge"]], log)
            require(child.event(180) == {"event": "running", "nonce": nonce}, "VM did not report a scoped start")
            print("Complete guest setup with a local account. Open Terminal and use diskutil list.")
            print("For the marked 64 MiB disk, run the guest command with its actual rdisk number.")
            print('sudo /Volumes/HL40B8FIXTURE/guest-fixture /dev/rdiskN ' + nonce, flush=True)

            phase = "workload"
            workload_limit = time.monotonic() + 15 * 60
            while True:
                check_free(root, HOST_RESERVE)
                require(child.process.poll() is None, "VM runner exited before the workload")
                left = workload_limit - time.monotonic()
                require(left > 0, "Guest workload reached its time limit")
                try:
                    report["workload"] = export.wait_workload(min(left, 0.5))
                    break
                except TimeoutError:
                    continue
            phase = "stop"
            stop_and_drain(child, export, uri, disk, packet, expected_digest, run_dir / "stop-intent.json", report)
            phase = "finish"
            child.command("finish")
            require(child.event(10) == {"event": "finished", "nonce": nonce}, "Native runner did not finish cleanly")
            child.finish(10)
            child = None
            report["status"] = "native-stop-and-probe-export-observed"
            report["bootDiskAndAuxiliaryIO"] = "outside probe export evidence"
        except (Exception, KeyboardInterrupt) as error:
            report.update({"phase": phase, "detail": str(error)})
            raise
        finally:
            if export is not None and report["status"] == "uncertain":
                try:
                    export.seal()
                    export.start_drain()
                    export.release_held()
                    report["exportAfterAbort"] = export.wait_drained(10) or export.snapshot()
                except Exception as error:
                    report["exportAbortError"] = str(error)
            if child is not None:
                try:
                    child.abandon(60 if phase == "install" else 10)
                except Exception as error:
                    report["nativeAbortError"] = str(error)
            write_new_json(run_dir / "result.json", report)
            print(json.dumps({"result": str(run_dir / "result.json"), "status": report["status"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare", help="validate inputs and create a packet without starting a VM")
    prep.add_argument("build_directory", type=Path)
    prep.add_argument("download_record", type=Path)
    prep.add_argument("packet", type=Path)
    launch = sub.add_parser("run", help="run the already approved exact packet")
    launch.add_argument("packet", type=Path)
    launch.add_argument("sha256")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.build_directory, args.download_record, args.packet)
    else:
        run(args.packet, args.sha256)


if __name__ == "__main__":
    main()
