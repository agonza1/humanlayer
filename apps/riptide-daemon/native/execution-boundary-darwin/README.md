# Execution boundary feasibility scaffold

This directory contains compile-only Swift source for a future HumanLayer execution
adapter. It represents the framework’s reported compute state with the exact stop
scope. A stopped state does not prove authority fencing, device or storage drain,
host settlement, or remote job termination.

On Apple silicon, pass a new, existing scratch directory to the compiler:

```sh
sh compile-only.sh /absolute/existing/output-directory
```

The command emits a Swift module, with no executable or entitlement. Nothing here
creates, installs, boots or stops a VM, or downloads an image. Nothing imports the
module into the daemon.

The TypeScript sibling under `src/effects/services/execution-boundary/` exercises
the owner and receipt contracts with controlled ports. It relies on an atomic,
durable journal and enforcing owner ports that fence actual starts and join their
work. Neither a production journal nor any native, host, storage or remote port is
provided here. Its assessment applies only to the declared capability manifest,
and never grants publication, retry, replacement or merge authority.

Recovery in this slice only resumes an already sealed, unassessed stop. Late
evidence never upgrades a retained uncertain assessment. The next slice must
prove native stop and storage drain with a real driver and disposable environment.
