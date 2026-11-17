import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { DeliveryAction } from '@humanlayer/riptide-api-contract/daemon/delivery'
import { sameDeliveryHeads, type DeliveryHead, type DeliveryTarget } from '@humanlayer/schemas/zod/automatic-delivery'
import z from 'zod/v4'

import type { ORPCClient } from '@/orpc/client'

const exec = promisify(execFile)
const PullRequestsSchema = z.array(
	z.object({
		number: z.number().int().positive(),
		headRefOid: z.string().regex(/^[a-f0-9]{40}$/),
		headRefName: z.string(),
		baseRefName: z.string(),
		state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
		isDraft: z.boolean(),
		mergeStateStatus: z.string(),
		reviewDecision: z.string(),
		labels: z.array(z.object({ name: z.string() })),
	}),
)

/** Host runtime adapter: uses the operator's existing gh authorization, never an App token. */
export interface DeliveryCommands {
	run: (binary: 'git' | 'gh', args: string[], cwd: string) => Promise<string>
}
const liveCommands: DeliveryCommands = {
	run: async (binary, args, cwd) => {
		return (
			await exec(binary, args, { cwd, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })
		).stdout.trim()
	},
}

async function inspectTarget(
	commands: DeliveryCommands,
	target: DeliveryTarget,
	merging: boolean,
): Promise<DeliveryHead> {
	const cwd = target.directory
	const [dirty, branch, localSha, origin] = await Promise.all([
		commands.run('git', ['status', '--porcelain'], cwd),
		commands.run('git', ['branch', '--show-current'], cwd),
		commands.run('git', ['rev-parse', 'HEAD'], cwd),
		commands.run('git', ['remote', 'get-url', 'origin'], cwd),
	])
	const normalizedOrigin = origin
		.replace(/^git@github.com:/, '')
		.replace(/^https:\/\/github.com\//, '')
		.replace(/\.git$/, '')
		.toLowerCase()
	if (dirty || branch !== target.branch || normalizedOrigin !== target.repository.toLowerCase())
		throw new Error('Local checkout has newer/uncommitted work, a different branch, or a different repository')
	const json = await commands.run(
		'gh',
		[
			'pr',
			'list',
			'--repo',
			target.repository,
			'--head',
			target.branch,
			'--base',
			target.base,
			'--state',
			'all',
			'--limit',
			'100',
			'--json',
			'number,headRefOid,headRefName,baseRefName,state,isDraft,mergeStateStatus,reviewDecision,labels',
		],
		cwd,
	)
	const prs = PullRequestsSchema.parse(JSON.parse(json))
	if (prs.length !== 1)
		throw new Error(
			'Every task branch must have exactly one relevant PR; ambiguous or missing PRs require attention',
		)
	const pr = prs[0]
	if (
		!pr ||
		pr.state === 'CLOSED' ||
		pr.headRefName !== target.branch ||
		pr.baseRefName !== target.base ||
		localSha !== pr.headRefOid
	)
		throw new Error('PR is closed without merge or its exact head differs from local work')
	const remote = await commands.run('git', ['ls-remote', 'origin', `refs/heads/${target.branch}`], cwd)
	// A deleted merged branch is fine; a network/auth failure still rejects the command.
	if (remote ? remote.split(/\s+/)[0] !== pr.headRefOid : pr.state !== 'MERGED')
		throw new Error('Remote branch has newer work or is unavailable')
	if (
		merging &&
		pr.labels.some((label) =>
			/manual[- ]merge|pr[- ]only|do[- ]not[- ]merge|human[- ]review[- ]required/i.test(label.name),
		)
	)
		throw new Error('PR labels require manual delivery')
	if (merging && pr.state !== 'MERGED') {
		if (
			pr.isDraft ||
			!['CLEAN', 'UNSTABLE'].includes(pr.mergeStateStatus) ||
			pr.reviewDecision === 'CHANGES_REQUESTED' ||
			pr.reviewDecision === 'REVIEW_REQUIRED'
		)
			throw new Error('Required checks, human approvals, or GitHub merge policy are not satisfied')
		// GitHub enforces repository-required checks at the normal merge endpoint.
		// Do not poll CI or turn optional/no-CI checks into another gate.
	}
	return { ...target, number: pr.number, sha: pr.headRefOid, merged: pr.state === 'MERGED' }
}

/** One leased action, without retrying mutations. Lost merge outcomes expire to attention. */
export async function executeDeliveryAction(
	action: DeliveryAction,
	commands: DeliveryCommands,
	authorizeMerge: () => Promise<boolean>,
): Promise<DeliveryHead[]> {
	const deadline = Date.now() + 90_000
	const heads: DeliveryHead[] = []
	for (const target of action.targets) {
		if (Date.now() > deadline) throw new Error('Delivery verification exceeded its bound')
		heads.push(await inspectTarget(commands, target, action.kind === 'merge'))
	}
	if (action.kind === 'merge') {
		if (!sameDeliveryHeads(action.heads, heads)) return heads
		for (const head of heads) {
			if (head.merged) continue
			const methods = z
				.object({
					allow_merge_commit: z.boolean(),
					allow_squash_merge: z.boolean(),
					allow_rebase_merge: z.boolean(),
				})
				.parse(JSON.parse(await commands.run('gh', ['api', `repos/${head.repository}`], head.directory)))
			const method = [
				{ flag: '--merge', allowed: methods.allow_merge_commit },
				{ flag: '--squash', allowed: methods.allow_squash_merge },
				{ flag: '--rebase', allowed: methods.allow_rebase_merge },
			].find((candidate) => candidate.allowed)?.flag
			if (!method) throw new Error('Repository does not allow a supported merge method')
			if (Date.now() > deadline || !(await authorizeMerge()))
				throw new Error('Per-task merge authorization expired or changed')
			// No --admin, --auto, branch deletion, or branch-protection bypass.
			await commands.run(
				'gh',
				[
					'pr',
					'merge',
					String(head.number),
					'--repo',
					head.repository,
					method,
					'--match-head-commit',
					head.sha,
				],
				head.directory,
			)
		}
		return Promise.all(action.targets.map((target) => inspectTarget(commands, target, false)))
	}
	return heads
}

/** In-process serialization complements the persisted lease across process restarts. */
export function createDeliveryHeartbeatContinuation(orpc: ORPCClient, onError: (error: unknown) => void) {
	let inFlight = false
	return async () => {
		if (inFlight) return
		inFlight = true
		try {
			const { action } = await orpc.delivery.claim({}, { signal: AbortSignal.timeout(15_000) })
			if (!action) return
			let heads: DeliveryHead[] = []
			let error: string | null = null
			try {
				heads = await executeDeliveryAction(
					action,
					liveCommands,
					async () =>
						(
							await orpc.delivery.validate(
								{ taskId: action.taskId, leaseId: action.leaseId },
								{ signal: AbortSignal.timeout(15_000) },
							)
						).authorized,
				)
			} catch (cause) {
				onError(cause)
				error = cause instanceof Error ? cause.message : 'Delivery worker failed'
			}
			await orpc.delivery.complete(
				{ taskId: action.taskId, leaseId: action.leaseId, heads, error },
				{ signal: AbortSignal.timeout(15_000) },
			)
		} catch (error) {
			onError(error)
		} finally {
			inFlight = false
		}
	}
}
