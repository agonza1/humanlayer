# Local automatic delivery

This opt-in development coordinator connects a HumanLayer implementation session to independent Codex QA and GitHub publication. It uses the local API and an existing authenticated daemon; it does not launch services, create accounts, or require an Anthropic API key. Codex still needs its normal OAuth connection and internet access.

Keep configuration and state outside repositories. Example configuration:

```json
{
  "apiOrigin": "http://127.0.0.1:51971",
  "sessionFile": "/absolute/private/workos-session-dev.json",
  "stateFile": "/absolute/private/local-delivery-state.json",
  "directory": "/absolute/isolated/project-worktree",
  "repository": "owner/repository",
  "baseBranch": "main",
  "branch": "codex/your-feature",
  "initialHeadSha": "the-40-character-commit-before-task-creation",
  "hostId": "the-authenticated-daemon-host-id",
  "activatedAt": 1792868400000,
  "taskPrefix": "[auto] ",
  "pollMs": 5000
}
```

Create a clean feature branch from the intended base, record `git rev-parse HEAD` as `initialHeadSha`, and record `git branch --show-current` as `branch`. These pin the checkout before the implementation starts; a no-op coder cannot publish existing branch changes. Set `activatedAt` to the current Unix time in milliseconds before creating the first automatic task. The state file pins this configuration; changing its delivery boundary requires a new state file. The WorkOS session must belong to the same organization as the UI and daemon. `gh auth status` must show access to the configured GitHub repository on the host. Credentials are never passed to a model prompt.

Run from the HumanLayer checkout with Bun:

```sh
bun apps/cli/src/index.ts local-delivery --config /absolute/private/local-delivery.json
```

Add `--once` to reconcile one iteration. The normal command polls until interrupted. SIGINT or SIGTERM finishes the current reconciliation, wakes the polling wait, and removes its owned lock before exit. Its output contains task IDs, phase, pause reason, and merged PR URL. QA itself appears as a separate session under the task in HumanLayer. After merge, `delivery.md` appears among the task artifacts with the PR link, exact reviewed commit, QA summary, and unrelated bug criticality. Receipt upload failure keeps the merged outcome and retries the same named artifact on later polls; restarting also backfills receipts for earlier merged records without publishing or merging again.

In the UI, create a task with a name starting with `[auto] `, select the configured host and exact isolated directory, choose Codex, and give the agent a bounded implementation request, relevant checks, and an instruction to commit on its feature branch. Turn off the stock implementation-to-PR automation: this coordinator owns QA and publication. Use one task and feature branch per checkout; use separate worktrees for parallel work. Neither historical tasks nor tasks without the prefix are adopted. Removing the prefix or archiving the task pauses automatic delivery at the next reconciliation. A renamed old task is still historical.

The coordinator waits for the implementation session to finish, requires a clean committed change, and launches a fresh Codex QA session. QA focuses on the requested change and must return an exact-commit JSON verdict. In-scope defects block delivery. Unrelated defects are retained with criticality in the local verdict for later backlog triage; no external bug tickets are created automatically.

A passing review must match the unchanged commit, branch, and merge base. Before publication and merge the coordinator rechecks the checkout and active sessions, verifies the GitHub remote, reconciles an existing PR, and uses `gh pr merge --squash --match-head-commit`. GitHub repository merge requirements still apply. It does not inspect CI or alter branch protection. The original feature branch remains available after merge.

State is written atomically with owner-only permissions. A lock prevents two coordinators sharing a state file. Session IDs are persisted before launch; after a lost response the exact ID is reconciled rather than launching duplicate QA. Existing PRs and merge results are reconciled before another publication attempt.

A failed review, dirty or changed checkout, multiple tasks sharing a checkout, ambiguous launch, or rejected merge pauses that task with a reason. There is no automatic repair in this first slice. Inspect the task, QA, checkout, and PR before restarting a delivery; do not delete state to retry an uncertain action. For a known failed task, fix it in a new, separately named automatic task and feature worktree. For a crash, restart the same configuration/state. If the process was killed and left a `.lock` directory, verify the recorded PID in `.lock/owner.json` has exited before removing only that lock directory.

This is local host automation, not an agent sandbox. QA's read-only role is requested in its prompt and checked by commit/status invariants; the model backend's OS permissions come from the daemon's own confinement. Keep worker provider credentials and host GitHub credentials separately scoped.

### Board completion

A confirmed merge is projected to the task's owner-only `deliveryResult` through
`tasks.update`, with the PR URL and exact reviewed commit. Both board interfaces
and the grouped list use this durable task result ahead of session workflow
labels, placing merged tasks in **Done** without changing session history.
The board update (`boardPublished`, with `boardReason` while pending) and
`delivery.md` receipt have independent durable acknowledgements:
a failure in either is retried on the next poll or restart and never repeats the
GitHub merge. Existing merged state files are backfilled even when their receipt
was already published or their sessions are no longer present. Only records with
a matching passing QA verdict and PR evidence can publish completion.

After upgrading, apply the generated database migration and restart the API and
local-delivery service. Run the service once with the original configuration and
state file to reconcile an older merged delivery; do not delete or reset its state.


Recorded merged deliveries also appear in the task's pull-request panel and in the
pull-request inbox under **All**, even without a GitHub App installation. Their
read-only summary links to GitHub and shows the reviewed commit; checks, reviews,
and branch controls are available only through the native GitHub integration.

For execution in native Codex chats instead of HumanLayer sessions, use the
[Main-mediated native bridge pilot](native-bridge.md).
