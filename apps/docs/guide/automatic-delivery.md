# Automatic delivery

The task owner can enable a continuation on an existing launched task. The existing daemon heartbeat drives it with the browser closed; there is no second scheduler or controller.

Implementation → stock Describe PR → independent review → repair when needed → review → authorized merge → fresh GitHub verification → archive.

Review is bounded to three passes across changed heads and restarts. A fresh managed session uses an existing automatic review when available, otherwise independent local QA. Related P0/P1/P2 findings return to the existing branches for repair. Unrelated P2/P3 findings stay in the evidence for follow-up. Unrelated urgent findings, failed or uncertain reviews and exhausted budgets stop for attention. One managed diagnostic recovery session reports the remaining blocker; it cannot reset the budget or override a human checkpoint.

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

Source tests cover exact-head merge, required repository protections, optional/no-CI checks, finding triage, bounded repairs, duplicate callbacks, stale inputs, restart uncertainty, daemon artifact reporting and archive. A successful source test does not prove a deployed canary. Record the deployed revision and an actual opt-in task's review, PR, merge and archive before describing an installation as live end to end.

For another repository, reuse its HumanLayer project, verify worker clone/push/PR/merge access and test commands, and explicitly enroll accepted work. Extend the read-only App installation separately when its PR visibility is needed. No new App, key, VM or deferred H#16/O#893 branch is required for this stock path.
