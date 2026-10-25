# Native Codex chat bridge pilot

HumanLayer keeps the task, board phases and artifacts. Main creates separate native
Codex Coder and QA chats using the Codex app's supported tools, reads their results,
and records each verified handoff with this command. The chats remain visible in
the Codex UI. No HumanLayer agent sessions or session labels are fabricated.

This is a **Main-mediated pilot**, not an unattended dispatcher. The CLI never
starts or polls Codex, accesses internal SDK pipes, publishes code, or merges PRs.
One Main controller owns each configured task. Native chat work must be scoped to
the exact isolated repository directory in the configuration. Main verifies the
chat identity, final messages, working tree and implementation SHA before syncing.

Keep configuration and update files outside repositories and do not commit session
credentials or private prompts. Configuration:

```json
{
  "apiOrigin": "http://127.0.0.1:51971",
  "sessionFile": "/absolute/private/owner-session.json",
  "taskId": "33333333-3333-4333-8333-333333333333",
  "repository": "owner/repository",
  "directory": "/absolute/isolated/worktree"
}
```

An implementation update records the real native thread IDs and request:

```json
{
  "execution": {
    "mode": "main-mediated",
    "stage": "implementation",
    "repository": "owner/repository",
    "directory": "/absolute/isolated/worktree",
    "coderThreadId": "11111111-1111-4111-8111-111111111111",
    "qaThreadId": "22222222-2222-4222-8222-222222222222"
  },
  "artifacts": [{ "fileName": "native-request.md", "content": "The bounded task request and acceptance checks." }]
}
```

Run from the HumanLayer checkout:

```sh
bun apps/cli/src/index.ts native-bridge --config /absolute/private/config.json --update /absolute/private/update.json
```

The task must be active, launched and owned by the authenticated user. The CLI
checks the configured repository, directory and existing binding before writing
anything. It upserts the supplied artifacts and a `native-execution.md` snapshot,
then updates the owner-only task `nativeExecution`. Repeating the exact command
after an upload or lost-response failure is safe. Board projection never advances
before its handoff evidence is stored. The CLI does not automatically retry writes.

After Coder commits, Main reads and verifies its result, sends the exact SHA and
checks to the independent QA chat, and syncs `stage: "in_review"` with `headSha`,
`qaThreadId`, `native-coder-result.md` and `native-qa-request.md`. After QA finishes,
Main records its full scoped verdict in `native-qa-result.md` at the same review
stage. An unrelated bug retains criticality in that result; it does not silently
expand the requested change.

The pilot advances only from implementation to review to blocked. Coder, existing
QA ID, repository and directory cannot be rebound; a recorded SHA cannot change.
Backward updates are rejected before artifact writes. A blocked snapshot requires
a reason and is terminal in this CLI; use a new task for repair. The task owner
can explicitly clear incorrect metadata using `tasks.update({ nativeExecution:
null })`, outside the normal pilot path.

Main alone publishes the reviewed commit and confirms the remote merge. Then the
existing owner-only `deliveryResult` API records its PR URL and exact SHA, and
`delivery.md` records the final outcome. **Done** wins over native execution state
on both boards, grouped list and live chat links. A review result alone is not Done.
The historical `native-execution.md` remains a handoff snapshot. Native Coder/QA
links and their visible IDs appear in task navigation/details; if a browser cannot
open a `codex://threads/` link, find the displayed ID in Codex.

Apply generated migration `0145_low_sharon_carter.sql` and restart the local API
before using this field. No new Codex SDK server, credentials or background worker
is required for this pilot. HumanLayer's existing `[auto]` delivery lane remains
separate; use a different task prefix such as `[native]`.
