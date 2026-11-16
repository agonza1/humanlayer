# Use remote hosts only

Turn off the local daemon if you want to use HumanLayer on your desktop while your sessions run on remote hosts. You can still create tasks, review the agent's work, and send messages from the desktop app.

## Before you turn it off

Connect a remote host using the [remote daemon guide](/guide/remote-daemons). Check that it appears online in **Settings -> Hosts**.

Finish any active work on this device before stopping its daemon. Turning off the local daemon interrupts sessions that it runs. It does not move those sessions to a remote host.

You need an online host to run sessions. You can queue work on a registered offline host, but it cannot start until that host's daemon is running again.

## Turn off the local daemon

1. Open **Settings -> Hosts** in the desktop app.
2. Find **Advanced**.
3. Turn off **Local daemon**.
4. Confirm **Stop daemon**.

HumanLayer stops the daemons that this desktop app started, including those for organizations you used earlier. It also stops starting or restarting them while the setting is off.

Each daemon stops its active sessions as part of shutting down, before it exits. You don't need to stop each session yourself. Shutdown does not wait for the agent to finish its work, so finish any work you want to keep running before you turn off the setting.

Your tasks and session history stay saved. Remote daemons and their sessions keep running.

The setting stays off when you close and reopen the desktop app. It applies to this desktop app's saved settings, not to your account on other devices. The browser does not offer this control.

## Choose a remote host

When you create a task, choose the remote host that should run it. Changing the local daemon setting does not change the host for an existing draft or session.

The stopped local host stays in the host list and becomes offline after its status updates. Turning off the setting does not delete the host or its history. If you select that offline host, queued work waits until its daemon runs again.

## Run sessions on this device again

Open **Settings -> Hosts -> Advanced** and turn on **Local daemon**. HumanLayer starts a daemon for your signed-in account and selected organization.

Wait for this device to appear online, then choose it when you create a task. Turning the setting back on does not automatically resume work that shutdown interrupted.

## If the local host stays online

The setting controls only daemons that this desktop app started. It does not stop a daemon you launched from the CLI or another copy of HumanLayer. A separate daemon can keep this device online even when the setting is off.

Stop a separately launched daemon where you started it. For a daemon running as a service, stop or disable that service; see [keep the daemon running](/guide/remote-daemons#keep-the-daemon-running).

You can also ask a local CLI agent of your choice to clean up daemon processes on this host:

```text
Stop all HumanLayer daemon / riptided processes on this host.
```

This stops all local daemons, not just those started by the desktop app, and interrupts their active sessions. A service that restarts its daemon must also be stopped or disabled.

Host status can also take time to update after shutdown, especially if the device cannot reach HumanLayer.

## If stopping fails

If HumanLayer shows **Could not stop the local daemon**, automatic startup stays off, but a local daemon may still be running. Use the retry action to stop it again.

Do not assume the process has stopped just because the switch is off. Check the stop result and the host's status before leaving work unattended.

## Review progression source boundary

The opt-in review-progression source is default off and does not change the daemon controls above. Enrollment binds one owner/task/host and verified placement. Stopping a host does not move its enrolled work or grant a replacement writer. Cross-host handoff is not supported by this integration; reconcile the original host's retained action, journal and process evidence before authorizing more execution. SDK child-cleanup proof remains unresolved, so automatic progression is not functionally accepted.

A separately authorized operator rollout must verify compatible helper output version 1 and handoff/return-ack version 1 on both repositories, exact installed helper/configuration digests, owner-private inbox and bridge identity, accepted task scope, host/placement and trusted return-route references. Unknown versions, missing pins, changed placement or revoked authority fail closed without falling back to another writer. Source revisions and passing fictional fixtures are not installed compatibility or delivery evidence.

Source delivery does not authorize installation, changing enrollment/configuration, starting or restarting daemons, live notifications or merging. Controller-owned root/static/services/API/database checks, Phase 6/7 technical/manual gates and original human acceptance remain separate. A live canary needs explicit authority for its project, host and notification surface; a merge canary additionally needs approval for that exact test PR/head.

For a separately authorized rollback, disable new enrollments/claims through the existing opt-ins and preserve task coordination rows, review journals, pending approvals, unknown action/send/merge intents and independent return receipts. Do not delete active state, reset budgets, resume on another host or infer nonexecution from a lost response. Keep the prior installed contract until explicit cutover. Reports return passively; an unsupported native-origin sender is a named limitation, never a fabricated success.
