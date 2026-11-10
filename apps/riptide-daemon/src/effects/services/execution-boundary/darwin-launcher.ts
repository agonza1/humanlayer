import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { digest, type ActivationIntent, type ActivationOutcome } from './contract'
import type { SqliteBoundaryJournal } from './sqlite-journal'

interface DarwinLaunch {
	readonly command: readonly [string, ...string[]]
	readonly cwd: string
	readonly sandboxProfile: string
	readonly env: Readonly<Record<string, string>>
	readonly uid: number
	readonly gid: number
}

export function darwinLaunchDigest(plan: DarwinLaunch): string {
	const environment = Object.keys(plan.env)
		.sort()
		.map((name) => [name, plan.env[name]])
	return digest([plan.command, plan.cwd, plan.sandboxProfile, environment, plan.uid, plan.gid])
}

// Only the trusted supervisor supplies plans. Its workspace and execution
// identity must already be provisioned before dispatch. The handle covers the
// immediate child and carries no claim about the rest of the worker cohort.
export function launchDarwinWorker(
	journal: SqliteBoundaryJournal,
	intent: ActivationIntent,
	plan: DarwinLaunch,
): {
	outcome: ActivationOutcome
	child?: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
} {
	const launch = structuredClone(plan)
	if (
		process.platform !== 'darwin' ||
		launch.uid <= 0 ||
		launch.uid !== process.getuid?.() ||
		launch.uid !== process.geteuid?.() ||
		launch.gid !== process.getgid?.() ||
		launch.gid !== process.getegid?.() ||
		intent.reservation.operationDigest !== darwinLaunchDigest(launch) ||
		!isAbsolute(launch.cwd) ||
		!isAbsolute(launch.command[0]) ||
		!launch.sandboxProfile.trim()
	) {
		return { outcome: 'not-accepted' }
	}

	let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
	try {
		const outcome = journal.dispatch(intent, () => {
			if (realpathSync(launch.cwd) !== launch.cwd) return 'not-accepted'
			child = Bun.spawn(['/usr/bin/sandbox-exec', '-p', launch.sandboxProfile, ...launch.command], {
				cwd: launch.cwd,
				env: launch.env,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
			})
			// Admission owns the wrapper immediately. Its exit and output
			// are separate observations of sandbox and target startup.
			return 'accepted'
		})
		return { outcome, child }
	} catch {
		// Preserve the child if SQLite fails after spawn. The durable claim
		// prevents a retry from creating a second worker.
		return { outcome: 'activation-unknown', child }
	}
}
