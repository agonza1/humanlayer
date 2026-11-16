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

## Native process identity on the host

The non-VM process driver captures a kernel audit token for a PID whose real and
effective UID match the supervisor's lease. It signals that token through
`libproc`. A stale token stays a failure. The driver has no PID-only fallback.

Run the disposable check as an ordinary user on macOS. The supervisor needs
permission to inspect task-name ports.

```sh
sh test-process-identity.sh /absolute/new/private-directory
```

The fixture launches and reaps one child, including a new session and an exec.
It checks that a mismatched expected UID and the pre-exec token are refused. The
current token delivers the signal on macOS build `26A434`. The supervisor still
needs to prove UID membership, seal admission, and verify the cohort is empty.
Storage and delegated writers have separate proof requirements.

## Private worker workspace on the host

The trusted child enters a pinned workspace directory after permanently dropping
to the reserved UID and GID. It verifies the kernel group list, the loss of saved
root credentials and access to the directory by path under the worker identity.
The supervisor supplies the directory descriptor and owns the worker lifecycle.

Build and preflight the disposable fixture as an ordinary user.

```sh
sh build-workspace-proof.sh /absolute/new/private-directory
/absolute/new/private-directory/workspace-proof --preflight
```

The administrator fixture stages a tracked source file in a fresh local Git
workspace, writes and renames a file there, and verifies that the sandbox denies
access to a sibling directory owned by the same worker. The parent checks the
write, reaps the child and removes its fixture paths. Production needs its own
workspace provisioning and a trusted supervisor that joins this handoff to the
launch journal.

## Dormant journal-to-private-worker adapter

`private-darwin-launcher.ts` binds the journal's exact activation intent to the command, workspace device/inode, private UID/GID, sandbox policy, environment and pinned native driver digest. The supervisor supplies already provisioned identities and a private workspace; this code does not allocate credentials or install a privileged service. The default native port refuses an ordinary-user supervisor. Injected tests are not privilege evidence.

`build-worker-launch.sh` compiles the standalone trusted-child entry point without installing or signing it. The driver calls the verified `darwin_enter_worker_workspace`, closes inherited private descriptors and denies worker read/write access to the actual supervisor journal directory in addition to the supplied sandbox policy. Target environment values are installed only after the sandbox starts, not in the privileged runner's loader environment. The driver is not set-ID and no caller invokes sudo. Any operator use requires separate exact authorization, protected driver placement and full-run workspace/credential ownership.

The default port requires root-owned, non-group/other-writable ancestry for the executable and rejects extended ACLs on the executable and every ancestor using stock Darwin `/bin/ls -lde` with a clean C-locale environment. Diagnostics or unfamiliar output fail closed. It hashes an opened no-follow driver descriptor and checks its pathname still identifies that object. Worker credentials cannot replace a component under these checked permissions. Trusted supervisor installation/update must stay quiescent through launch; no privileged auto-update is installed. Recovery inspection reads the record and dispatch claim in one SQLite snapshot and returns its revision. It is an observation, never fresh launch authority.

The same canonical, root-owned, non-worker-writable, ACL-free ancestry requirement applies to the supervisor journal directory, not just the executable. The default port also verifies the journal directory and file device/inode identities captured at SQLite connection setup, private modes, root ownership and a single-link ACL-free journal file before admission. Capture is pathname-based, not an identity extracted from SQLite's descriptor: trusted supervisor provisioning and updates must remain quiescent from connection setup through launch and for the lifetime of the worker's path-based sandbox denial. A journal under a worker-replaceable ancestor is refused even if its immediate directory is private and root-owned. Ordinary-user tests simulate only a root-owned leaf under real writable ancestors; they do not change ownership or launch a privileged process.

The journal records its dispatch claim before launch and serializes handoff admission against stop. A replay or crash after the claim remains activation-unknown, including when no child handle survives; read-only inspection retains the exact intent and current stop identity without restarting a worker. An accepted native wrapper is not confirmed target readiness, descendant containment or I/O drain. The daemon does not import this adapter into production launch paths. Workload parity, ambiguous-launch reconciliation by an enforcing owner, pending I/O, Docker and delegated writers remain separate gates. No VM is required by this source slice.
