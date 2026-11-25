# Automatic delivery

A project owner can choose a delivery default for new accepted work, or the task owner can enable a continuation on an existing launched task. The existing daemon heartbeat drives it with the browser closed; there is no second scheduler or controller.

Implementation → stock Describe PR → independent review → repair when needed → review → authorized merge → fresh GitHub verification → archive.

Review is bounded to three passes across changed heads and restarts. A fresh managed session uses an existing automatic review when available, otherwise independent local QA. Related P0/P1/P2 findings return to the existing branches for repair. Unrelated P2/P3 findings stay in the evidence for follow-up. Unrelated urgent findings, failed or uncertain reviews and exhausted budgets stop for attention. One managed diagnostic recovery session reports the remaining blocker; it cannot reset the budget or override a human checkpoint.

## Project defaults

In Settings → Projects, choose **Delivery default** on your project:

- **Off** keeps the existing workflow and its stage auto-advance settings.
- **PR with manual merge** opens the PR, reviews and repairs it, then waits for your merge before verified archival.
- **Automatic merge** uses the same review/repair loop, merges when the task and repository policies allow, then verifies and archives.

All existing projects start Off. A new task snapshots its owner's project default at launch. Changing the project later does not alter existing tasks, reviews or budgets. Shared-project defaults do not grant another user merge authority. Explicit task instructions and required human checkpoints still apply.

Both task launchers offer **Inherit project default**, **Off**, **PR with manual merge**, and **Automatic merge** for project tasks. The choice applies to that task only. Research and planning sessions stay outside delivery; enrollment waits for an implementation session and the selected host's complete, matching repository materializations. Repository branches, bases and absolute paths come from the task workspace; no manual path configuration is needed. Pending or failed setup remains visible in the existing workspace status and cannot advance delivery.

The stock CLI uses the same settings:

```sh
humanlayer --local api projects v2 update --project-id PROJECT_UUID --delivery-mode pr-only
# Add --delivery-override off, pr-only, merge, or inherit to the normal tasks v2 create command.
```

These settings do not install credentials, change worker permissions, or enroll existing tasks. Automatic delivery supports up to 10 GitHub repositories on task branches. Unsupported recipes are rejected at launch with an Off alternative; they cannot stall the delivery loop. Directory-only launches retain their existing behavior. Task-level initial configuration below remains available for existing tasks.

## Enable a task

Use the existing authenticated CLI for the selected installation. First verify the accepted task, source session, host and exact workspace repository paths. The owner acknowledges the task's merge authority and repository/company policies; this setting does not grant a missing human approval.

```sh
humanlayer --local api tasks delivery configure \
  --task-id TASK_UUID --source-session-id IMPLEMENTATION_SESSION_UUID \
  --mode merge \
  --targets '{"repository":"owner/repo","branch":"task-branch","base":"main","directory":"/absolute/task/workspace"}' \
  --policy-acknowledgement 'Automatic merge is authorized for this accepted task; required human checkpoints are satisfied.'
```

Supply one target object per repository. Inspect state with `humanlayer --local api tasks delivery get --task-id TASK_UUID`. Configuration is owner-only and off by default. It replaces the task's old automatic PR handoff to prevent competing successors. Existing tasks are not enrolled automatically, and the initial configuration cannot reset its review budget. Use `--mode disabled` with the retained configuration arguments to stop new automatic delivery actions. An already submitted GitHub operation can finish; inspect its result before resuming work.

`pr-only` performs review/repair and waits for a manual merge before verification and archive. `archive-only` starts with already merged PRs, obtains independent evidence and never merges. Manual-merge and PR-only task instructions and required human checkpoints remain binding.

## Publication and blocker alerts

The board and `humanlayer board` show the separate Describe PR session as queued, running or blocked on the same task. Describe PR stays in Implementation while publication is in progress. A session waiting for approval or capacity can resume and proceed to independent Review after GitHub verification.

On an active task, the owner can opt the task into specific alert routes independently of automatic delivery. Use the Slack automation ID for an enabled automation you own in the task workspace. Find IDs with `humanlayer --local api integrations slack list-automations`. Use the session ID from the task's originating HumanLayer conversation.

```sh
humanlayer --local api tasks delivery configure-alerts --task-id TASK_UUID \
  --routes '{"slackAutomationId":"AUTOMATION_UUID","origin":{"kind":"session","sessionId":"SESSION_UUID"}}'
```

For a task that originated in an existing Slack notification thread, set `origin` to `{"kind":"slack","automationId":"AUTOMATION_UUID"}`. HumanLayer resolves the ready thread for that automation on this task. A route object without a Slack mode replaces the previous bindings. When only one requested route is authorized and available, HumanLayer keeps that route and shows the other gap on a blocked task. When none of the requested routes can be bound, the command returns an error. Pass `--routes '{}'` to clear the bindings. This configuration also works on existing enrolled tasks and preserves the current review budget and evidence. Delivery Off still allows visibility and explicitly authorized alerts.

The task shows each route's outcome. A Slack receipt needs a matching Slack response. A HumanLayer receipt references the notice stored on the originating session. When both routes point to the same Slack thread, a single post supplies both receipts. A missing native session or unsupported external chat, including a Codex conversation, appears as unavailable while any other authorized route still runs. An uncertain Slack result stays unconfirmed so that a lost response cannot cause a duplicate post.

### Standing Slack route for local personal projects

The task owner can authorize a private Slack DM for their tasks in selected personal projects. Eligible active tasks inherit that route, including older tasks and tasks with automatic delivery Off. The local host relay can use the reviewed Slack bridge to deliver these DMs while HumanLayer's native Slack integration is disconnected.

Set `HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE` to the absolute path of a host-owned mode-0600 JSON grant file. The grant uses `schemaVersion: 2` and lists the permitted project UUIDs in `projectIds`. It specifies the route ID, HumanLayer organization and owner IDs, loopback app origin, Slack workspace, sender, private DM and recipient, plus the absolute paths to the executable, provider script and provider config file. The provider config uses the same version, route, scope and destination with the path to the reviewed bridge launch configuration. Credentials remain in the bridge's private host configuration. The existing task-specific grant uses its existing format and environment variable.

Use the same organization, owner, route ID, project allowlist and private DM identities in both grant files. Apply an approved grant by atomically installing the matching files and starting the existing local API with the standing route configured. Replace the files and rotate the route ID when changing or repairing the grant. Startup and reconnect reconcile active blockers in batches. Slack retries are limited to confirmed unsent blockers with a newly available or changed route. Delivered and unconfirmed sends keep their existing receipts and blocker identity.

An explicit task Slack route overrides the standing route. Existing empty or origin-only bindings preserve their Slack opt-out, and task mutes take precedence. Change only the Slack mode to keep the existing authorized origin.

```sh
humanlayer --local api tasks delivery configure-alerts --task-id TASK_UUID \
  --routes '{"slackMode":"inherit"}'
humanlayer --local api tasks delivery configure-alerts --task-id TASK_UUID \
  --routes '{"slackMode":"off"}'
```

On a blocked task, the board and board CLI report the effective Slack route and the outcome of each alert. The DM includes a safe task reference, the blocker and the next action so the owner can act while the local board is unreachable. For rollout, verify a confirmed receipt on an ordinary opted-in task with no task-specific Slack binding.

## Idle implementation

HumanLayer records the next action when implementation stops. On startup and reconnect, it reconciles older active cards in batches. Both boards and the board CLI show current-head verification, the stock Describe PR handoff, or a blocker with the owner's next action. Host and workflow deadlines keep pending work visible when a host stops responding.

For an enrolled task whose implementation session fails after committing, the assigned host first checks for committed work on the authorized branches. A clean checkout with verified commits can proceed to the stock Describe PR handoff, where publication is pinned to those SHAs. Independent review starts only after the matching PR heads are verified. Dirty work, unavailable or conflicting Git evidence, explicit interruption, and a lost session with unknown writer status still require attention. Read-only recovery can be reclaimed after a host restart. The existing review budget and merge policy still apply.

An existing task can enter Review after the stock host inspector verifies the task workspace, repository, branch, and exact PR heads. Independent review, merge, and archival use the existing task authorization and verification gates. Turning delivery off leaves inspection read-only. A legacy Describe PR opt-in can recover a missed handoff using the same task, workspace, and worker admission.

The 24-hour card tint remains a display cue.

## Credentials and completion

The host uses its existing GitHub CLI access. It checks repository/branch identity, a clean checkout and exact local/remote/PR heads. A normal GitHub merge enforces repository-required protections without another CI polling loop or an admin bypass. Merge commits are preferred when allowed; other repository-supported merge methods are used when necessary. The read-only GitHub App does not receive write permissions.

Review JSON is written through the existing task artifact tool as `delivery-review-SESSION_UUID.json`. The daemon syncs it under the designated session identity; no owner CLI login is copied into workers. The API validates task, host, session and reviewed heads before accepting it.

Only all-merged, independently reviewed task branches with unchanged task work and no active or pending sessions can be archived. Reservations survive restarts; an uncertain merge outcome stops for inspection. Archive uses existing reversible task/session archival and diff-stream cleanup. It does not delete worktrees or history. Both active boards have no Done column; archived tasks remain in archived history and can be restored.

## Restore an archived task

Archival preserves task and session history and worktrees. Restore a task and its associated sessions with the stock CLI:

```sh
humanlayer --local api tasks archive --task-id TASK_UUID --archived false --cascade-to-sessions true
```

Restoring does not reset the delivery review budget or restart archived automatic delivery.

## Validation and rollout

CodeLayer Bash calls explicitly select ordinary execution or verification. Verification uses one lane per repository checkout, including subagents; ordinary tools and separate task checkouts remain concurrent. The verification runtime sets `HUMANLAYER_VERIFICATION_CONCURRENCY` to 2 by default for local Turbo/Vitest workers and verification compiler jobs. Root build/typecheck/unit-test scripts apply the Turbo cap only when this variable is explicitly set; hosted CI retains its prior Turbo and Vitest defaults otherwise. Local Vitest defaults to 2 workers. Do not background multiple checks inside a shell command.

Verification records command, directory, scope, finding generation, exact Git revision and outcome in the worktree's Git metadata, scoped to the task. Only the Describe PR session may reuse a successful clean unchanged revision; changed commits, dirty inputs, new affected findings, failures, timeouts and cancellations require execution again. Independent QA never reuses implementation evidence. This does not replace required exact-head hosted CI or authorize publication, merge, archive or production promotion.

On Bash timeout or cancellation, CodeLayer tracks owned descendants by ancestry and process identity, including children in other process groups. It terminates gracefully, escalates after a bounded grace period even if the shell exited, and waits for cleanup before returning. Process inspection must be available; unavailable inspection fails before command launch rather than pretending cleanup is safe.

Source tests cover exact-head merge, required repository protections, optional/no-CI checks, finding triage, bounded repairs, duplicate callbacks, stale inputs, restart uncertainty, daemon artifact reporting and archive. A successful source test does not prove a deployed canary. Record the deployed revision and an actual opt-in task's review, PR, merge and archive before describing an installation as live end to end.

For another repository, reuse its HumanLayer project, verify worker clone/push/PR/merge access and test commands, and explicitly enroll accepted work. Extend the read-only App installation separately when its PR visibility is needed. No new App, key, VM or deferred H#16/O#893 branch is required for this stock path.

On macOS, process inspection uses the installed Command Line Tools or Xcode Python directly, avoiding the `/usr/bin/python3` launcher’s `xcrun` cache writes inside a sandbox. Other installations can set `HUMANLAYER_PROCESS_INSPECTOR_PYTHON` to an absolute non-launcher Python path. Process-metadata access must still be authorized by the installed sandbox; this setting does not change its permissions.

A confirmed macOS inspector timeout gets one retry with a five-second deadline. Permission failures are not retried; persistent failures retain subprocess code, signal and diagnostic text, and no command starts without a successful ownership inspection.
