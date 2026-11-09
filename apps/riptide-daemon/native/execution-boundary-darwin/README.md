# HumanLayer native stop and storage proof

This disposable feasibility harness checks an actual macOS worker and one owned 64 MiB
storage export. The harness runs as a standalone command alongside the TypeScript owner
contract and compile-only Swift observation scaffold.

Build the arm64 runner and guest fixture into a fresh private directory. The build
also signs a separate read-only checker with Apple's required Virtualization
entitlement. Its compiled entry points are image inspection and URL validation.
Preparation checks the local Apple restore descriptor, VM budget and NBD URL form,
then writes a hashed packet for the operator to review before the first install or
boot.

```sh
sh build-proof.sh /absolute/private/build-directory
python3 -B native_proof.py prepare /absolute/private/build-directory \
  /absolute/restore/download-readback.json /absolute/private/packet/boot-packet.json
```

The packet pins the Apple macOS 27.0.1 build `26A434`, exact local asset identities
and digests, and one run directory. It budgets four vCPUs, 8 GiB RAM, a 44 GiB sparse
system disk, a 64 MiB probe disk and an 8 GiB host space reserve. The install checks
free space while it runs and requests cancellation at the reserve. A small installer
disk or an unsupported device can still prevent the feasibility run.

After the operator approves the exact packet, the run signs only a scratch copy of the
runner with Virtualization and network-client entitlements. It installs one local guest,
then opens that guest using a private display, read-only fixture media and the marked
NBD disk. The guest has zero NICs and host shares. Complete the guest Setup Assistant
with a local account and run the printed command in its Terminal, substituting the
64 MiB probe disk from `diskutil list`. The fixture checks the virtual machine model,
disk geometry and per-run marker before writing.

The fixture's reparented process writes a heartbeat. Its parent issues a second write
which the export admits and holds before writing the backing file. The host closes
admission, requests native stop, checks that the held write remains pending, and tests
stale reconnect rejection. It then releases the already admitted write and requires
the real I/O worker, file sync and descriptor close to finish at the same frontier
within the first stop deadline. The result records the observed scope.

The proof covers the native stop and this export. The macOS system disk and auxiliary
storage use the framework's file attachments. Full backend cleanup, Docker parity and
host and remote work require their own evidence before task progression can use it.

Run the focused host checks from this directory with
`python3 -B -m unittest -v test_probe_export.py test_native_proof.py`.
These tests use real temporary files and loopback frames with a controlled native
witness.

[Apple Virtualization](https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon) · [NBD protocol revision](https://github.com/NetworkBlockDevice/nbd/blob/6725f91e6a33bc9f62d31d82798c04ec1cde1c73/doc/proto.md)
