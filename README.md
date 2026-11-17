# HumanLayer

HumanLayer runs coding agents (Claude Code, Codex, OpenCode, Pi) on your machines and lets your team steer them from one place: tasks, sessions, plans, and reviews, synced between a desktop app, a web app, and a daemon on each host.

This repo holds all of it. It's a [Turborepo](https://turborepo.com) monorepo that uses [Bun](https://bun.sh).

## What's here

- `apps/riptide-ui`: the app, as a web app and inside the desktop shells
- `apps/riptide-electron`, `apps/riptide-native`: the macOS desktop apps (Electron, Tauri)
- `apps/riptide-daemon`: the daemon that runs agent sessions on a host
- `apps/cli`: the `humanlayer` CLI, which also ships the daemon
- `apps/riptide-api`: the oRPC + Hono API
- `apps/riptide-electric-proxy`: the auth proxy in front of [Electric](https://electric-sql.com), which syncs Postgres to clients
- `apps/riptide-cloud`: the admin web app (organizations, invites, settings, install page)
- `apps/riptide-migrator`, `apps/updater-server`, `apps/stale-daemon-sweeper`, `apps/database-maintenance-function`: AWS Lambda jobs
- `apps/riptide-claude-code-plugin`, `apps/riptide-opencode-plugin`, `apps/riptide-pi-extension`: plugins that mirror Claude Code, OpenCode, and Pi sessions into HumanLayer
- `apps/riptide-humanlayer-claude-plugin`: the built-in HumanLayer skills
- `apps/riptide-rpi-claude-plugin`, `apps/linear-cli`: the Research-Plan-Implement skills and the Linear CLI
- `apps/docs`: the user docs
- `apps/devstack`: runs a full local stack per worktree
- `packages/`: shared libraries (`db`, `schemas`, `ui`, `sync`, `ai`, `billing`, ...)
- `contracts/`: the oRPC and Effect RPC contracts between the apps

## Get started

You need [Bun](https://bun.sh) and Docker. Building `apps/riptide-native` also needs Rust.

```
bun install
cp .env.example .env
bun --bun run typecheck
bun run test
```

`bun --bun run devstack help` explains how to run the whole stack locally. [CONTRIBUTING.md](CONTRIBUTING.md) lists every check a pull request must pass.
For faster local UI loading without Vite HMR, build with the existing API/sync/auth settings (`cd apps/riptide-ui && bun --bun --env-file=../../.env run build:local`), then replace only the UI dev server with `bun --bun --env-file=../../.env run serve --host 127.0.0.1 --port "$UI_PORT" --strictPort`, setting `UI_PORT` to its existing port to preserve the browser origin.

A build from source sends nothing to us: Sentry, PostHog, and the WorkOS client ID come from env, and stay off when unset. `.env.example` lists them.

## Task delivery

The stock Small workflow can advance from implementation to PR preparation when its automatic PR step is enabled. It does not require the experimental review-progression draft.

Both boards show active workflow columns, without a Done projection or browser-driven delivery polling. A stopped session or merged PR does not by itself archive a task. Archived tasks leave the active board and remain available in archived history for restoration; archiving does not delete a task or its worktree.

Project owners can set a delivery default (Off, PR with manual merge, or Automatic merge) for their new implementation tasks; both launchers allow a task-specific override. Each task snapshots that choice, so later project changes cannot alter existing work or review budgets. Task owners can also opt an existing task into automatic delivery: implementation → PR → independent review → up to three review passes with scoped repairs → authorized merge → fresh merge verification → archive. The existing daemon heartbeat drives this flow with the browser closed. Project defaults do not enroll or change existing tasks. PR-only tasks wait for a manual merge; blocked or uncertain work goes to one diagnostic recovery session and then owner attention. See [automatic delivery](apps/docs/guide/automatic-delivery.md) for configuration, limits and validation status.

## Self-hosting

HumanLayer Cloud runs this code on AWS. [`.claude/skills/self-host-humanlayer/`](.claude/skills/self-host-humanlayer/SKILL.md) holds a reference copy of our Pulumi stacks and GitHub Actions workflows, with every secret and HumanLayer-specific value replaced by a placeholder. It also covers the services, the order to deploy them in, and what you must change. Open it in Claude Code, or another agent that reads skills, and ask it to help you self-host HumanLayer.

It's a reference, not a supported install: expect to adapt it.


⚠️ note - If you use the Docker Compose file as a starter for self hosting, please note that it uses default/simple passwords that should be updated before you deploy.


## License

[Apache License 2.0](LICENSE). A few vendored folders keep their MIT licenses; [NOTICE](NOTICE) lists them.
