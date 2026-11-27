import { execFile } from 'node:child_process'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { DeliveryAction } from '@humanlayer/riptide-api-contract/daemon/delivery'
import {
	DELIVERY_CHECKOUT_BLOCKER,
	sameDeliveryHeads,
	type DeliveryCommit,
	type DeliveryHead,
	type DeliveryInspectionIssue,
	type DeliveryTarget,
} from '@humanlayer/schemas/zod/automatic-delivery'
import z from 'zod/v4'

import type { ORPCClient } from '@/orpc/client'

import { getArtifactStoragePath } from '../artifact-location'

const exec = promisify(execFile)

class DeliveryInspectionError extends Error {
	constructor(
		readonly issue: DeliveryInspectionIssue,
		message: string,
	) {
		super(message)
	}
}
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

const ObservedPullRequestSchema = PullRequestsSchema.element
	.pick({
		number: true,
		headRefOid: true,
		headRefName: true,
		baseRefName: true,
		state: true,
		isDraft: true,
	})
	.extend({
		headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
	})

const ObservedRepositorySchema = z.object({
	errors: z.array(z.unknown()).max(0).optional(),
	data: z.object({
		repository: z.object({
			nameWithOwner: z.string(),
			byNumber: ObservedPullRequestSchema.nullable().optional(),
			byTarget: z
				.object({
					totalCount: z.number().int().nonnegative(),
					nodes: z.array(ObservedPullRequestSchema).max(2).nullable(),
				})
				.optional(),
			branch: z
				.object({
					name: z.string(),
					prefix: z.string(),
					target: z.object({ oid: z.string().regex(/^[a-f0-9]{40}$/) }).nullable(),
				})
				.nullable(),
		}),
	}),
})

const OBSERVE_PULL_REQUEST_QUERY = `
query ObserveDeliveryPullRequest(
	$owner: String!, $name: String!, $branch: String!, $base: String!, $ref: String!, $known: Boolean!, $number: Int!
) {
	repository(owner: $owner, name: $name) {
		nameWithOwner
		byNumber: pullRequest(number: $number) @include(if: $known) { ...DeliveryPullRequest }
		byTarget: pullRequests(headRefName: $branch, baseRefName: $base, first: 2) @skip(if: $known) {
			totalCount
			nodes { ...DeliveryPullRequest }
		}
		branch: ref(qualifiedName: $ref) { name prefix target { oid } }
	}
}
fragment DeliveryPullRequest on PullRequest {
	number headRefOid headRefName baseRefName state isDraft headRepository { nameWithOwner }
}
`

/** Host runtime adapter: uses the operator's existing gh authorization, never an App token. */
export interface DeliveryCommands {
	run: (binary: 'git' | 'gh', args: string[], cwd: string) => Promise<string>
}
const liveCommands: DeliveryCommands = {
	run: async (binary, args, cwd) => {
		const { stdout } = await exec(binary, args, {
			cwd,
			timeout: 10_000,
			maxBuffer: 2 * 1024 * 1024,
			encoding: 'utf8',
		})
		return binary === 'git' && args[0] === 'status' ? stdout : stdout.trim()
	},
}

async function isOnlyTaskArtifactLink(commands: DeliveryCommands, directory: string, status: string, taskId?: string) {
	// Git reports paths relative to the repository root. Allow one generated,
	// untracked link only. Full porcelain output keeps every other file visible.
	const relative = /^\?\? (\.humanlayer\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]*)\0$/.exec(status)?.[1]
	if (!relative || !status.endsWith('\0') || !taskId || !z.uuidv7().safeParse(taskId).success) return false
	try {
		const [root, physicalDirectory] = await Promise.all([
			commands.run('git', ['rev-parse', '--show-toplevel'], directory),
			realpath(directory),
		])
		if (physicalDirectory !== root) return false
		if (!(await lstat(join(root, '.humanlayer'))).isDirectory()) return false
		if (!(await lstat(join(root, '.humanlayer', 'tasks'))).isDirectory()) return false
		const path = join(root, relative)
		const expected = getArtifactStoragePath(taskId)
		return (
			(await lstat(path)).isSymbolicLink() &&
			(await readlink(path)) === expected &&
			(await lstat(expected)).isDirectory()
		)
	} catch {
		return false
	}
}

async function inspectCheckout(commands: DeliveryCommands, target: DeliveryTarget, taskId?: string): Promise<string> {
	const cwd = target.directory
	const [status, branch, localSha, origin] = await Promise.all([
		commands.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd),
		commands.run('git', ['branch', '--show-current'], cwd),
		commands.run('git', ['rev-parse', 'HEAD'], cwd),
		commands.run('git', ['remote', 'get-url', 'origin'], cwd),
	])
	const normalizedOrigin = origin
		.replace(/^git@github.com:/, '')
		.replace(/^https:\/\/github.com\//, '')
		.replace(/\.git$/, '')
		.toLowerCase()
	if (
		branch !== target.branch ||
		normalizedOrigin !== target.repository.toLowerCase() ||
		(status && !(await isOnlyTaskArtifactLink(commands, cwd, status, taskId)))
	)
		throw new DeliveryInspectionError('checkout', DELIVERY_CHECKOUT_BLOCKER)
	return localSha
}

async function readPullRequests(commands: DeliveryCommands, target: DeliveryTarget) {
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
		target.directory,
	)
	return PullRequestsSchema.parse(JSON.parse(json))
}

export async function inspectCommittedImplementation(
	targets: DeliveryTarget[],
	commands: DeliveryCommands,
	taskId?: string,
): Promise<DeliveryCommit[]> {
	const deadline = Date.now() + 90_000
	const commits: DeliveryCommit[] = []
	for (const target of targets) {
		if (Date.now() > deadline) throw new Error('Implementation recovery inspection exceeded its bound')
		const { directory, branch, base } = target
		if (branch === base) throw new Error('Implementation recovery requires a separate task branch')
		const sha = await inspectCheckout(commands, target, taskId)
		const baseRef = `refs/heads/${base}`
		const branchRef = `refs/heads/${branch}`
		const refs = await commands.run('git', ['ls-remote', '--refs', 'origin', baseRef, branchRef], directory)
		const refSha = (ref: string) =>
			refs
				.split('\n')
				.find((line) => line.split('\t')[1] === ref)
				?.split('\t')[0]
		const baseSha = refSha(baseRef)
		const remoteSha = refSha(branchRef)
		if (!baseSha) throw new Error('Could not verify the base branch for implementation recovery')
		// An unavailable object or unrelated history fails closed. No fetch writes to the task checkout.
		await commands.run('git', ['merge-base', baseSha, sha], directory)
		const unique = await commands.run('git', ['rev-list', '--max-count=1', sha, '--not', baseSha], directory)
		if (!unique) throw new Error('No committed implementation exists beyond the base')
		if (remoteSha) await commands.run('git', ['merge-base', '--is-ancestor', remoteSha, sha], directory)
		const prs = await readPullRequests(commands, target)
		if (
			prs.length > 1 ||
			prs.some(
				(pr) =>
					pr.state !== 'OPEN' ||
					pr.headRefName !== branch ||
					pr.baseRefName !== base ||
					pr.headRefOid !== remoteSha,
			)
		)
			throw new Error('Existing PR state is ambiguous or incompatible with the recovered implementation')
		commits.push({ ...target, sha })
	}
	return commits
}

async function inspectTarget(
	commands: DeliveryCommands,
	target: DeliveryTarget,
	merging: boolean,
	taskId: string,
): Promise<DeliveryHead> {
	const cwd = target.directory
	const localSha = await inspectCheckout(commands, target, taskId)
	const prs = await readPullRequests(commands, target)
	if (prs.length !== 1)
		throw new DeliveryInspectionError(
			prs.length ? 'pr-ambiguous' : 'pr-missing',
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
		throw new DeliveryInspectionError(
			'pr-head-mismatch',
			'PR is closed without merge or its exact head differs from local work',
		)
	const remote = await commands.run('git', ['ls-remote', 'origin', `refs/heads/${target.branch}`], cwd)
	// A deleted merged branch is fine; a network/auth failure still rejects the command.
	if (remote ? remote.split(/\s+/)[0] !== pr.headRefOid : pr.state !== 'MERGED')
		throw new DeliveryInspectionError('remote-head-mismatch', 'Remote branch has newer work or is unavailable')
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
	return { ...target, number: pr.number, sha: pr.headRefOid, merged: pr.state === 'MERGED', draft: pr.isDraft }
}

async function observeTarget(
	commands: DeliveryCommands,
	target: DeliveryTarget,
	trackedHeads: DeliveryHead[],
): Promise<DeliveryHead> {
	const repository = target.repository.toLowerCase()
	const [owner, name] = target.repository.split('/')
	const tracked = trackedHeads.filter(
		(head) =>
			head.repository.toLowerCase() === repository && head.branch === target.branch && head.base === target.base,
	)
	if (tracked.length > 1)
		throw new DeliveryInspectionError('pr-ambiguous', 'More than one PR is tracked for the same delivery target')
	const expected = tracked[0]
	// Supply all coordinates explicitly and stay outside the task checkout.
	// In particular, a stale or dirty directory is never authority for a GitHub read or write.
	const response = await commands.run(
		'gh',
		[
			'api',
			'graphql',
			'--hostname',
			'github.com',
			'-f',
			`query=${OBSERVE_PULL_REQUEST_QUERY}`,
			'-f',
			`owner=${owner}`,
			'-f',
			`name=${name}`,
			'-f',
			`branch=${target.branch}`,
			'-f',
			`base=${target.base}`,
			'-f',
			`ref=refs/heads/${target.branch}`,
			'-F',
			`known=${expected !== undefined}`,
			'-F',
			`number=${expected?.number ?? 0}`,
		],
		tmpdir(),
	)
	const { nameWithOwner, byNumber, byTarget, branch } = ObservedRepositorySchema.parse(JSON.parse(response)).data
		.repository
	if (!expected && ((byTarget?.totalCount ?? 0) > 1 || (byTarget?.nodes?.length ?? 0) > 1))
		throw new DeliveryInspectionError('pr-ambiguous', 'More than one GitHub PR matches the delivery target')
	const pr = expected ? byNumber : byTarget?.totalCount === 1 ? byTarget.nodes?.[0] : undefined
	if (!pr)
		throw new DeliveryInspectionError('pr-missing', 'No matching GitHub PR is available for the delivery target')
	if (
		nameWithOwner.toLowerCase() !== repository ||
		pr.headRepository?.nameWithOwner.toLowerCase() !== repository ||
		pr.headRefName !== target.branch ||
		pr.baseRefName !== target.base ||
		(expected && expected.number !== pr.number) ||
		pr.state === 'CLOSED'
	)
		throw new DeliveryInspectionError('pr-head-mismatch', 'GitHub PR does not match the delivery target')
	if (
		branch
			? branch.prefix !== 'refs/heads/' || branch.name !== target.branch || branch.target?.oid !== pr.headRefOid
			: pr.state !== 'MERGED'
	)
		throw new DeliveryInspectionError('remote-head-mismatch', 'GitHub branch does not match the exact PR head')
	return { ...target, number: pr.number, sha: pr.headRefOid, merged: pr.state === 'MERGED', draft: pr.isDraft }
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
		const head =
			action.kind === 'observe'
				? await observeTarget(commands, target, action.heads)
				: await inspectTarget(commands, target, action.kind === 'merge', action.taskId)
		heads.push(head)
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
		return Promise.all(action.targets.map((target) => inspectTarget(commands, target, false, action.taskId)))
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
			const { action } = await orpc.delivery.claim(
				{ supportsObservation: true, supportsMergedPublicationRecovery: true },
				{ signal: AbortSignal.timeout(15_000) },
			)
			if (!action) return
			let heads: DeliveryHead[] = []
			let recoveredCommits: DeliveryCommit[] | undefined
			let error: string | null = null
			let inspectionIssue: DeliveryInspectionIssue | undefined
			try {
				if (action.kind === 'recover')
					recoveredCommits = await inspectCommittedImplementation(action.targets, liveCommands, action.taskId)
				else
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
				inspectionIssue = cause instanceof DeliveryInspectionError ? cause.issue : undefined
				error = cause instanceof Error ? cause.message : 'Delivery worker failed'
			}
			await orpc.delivery.complete(
				{ taskId: action.taskId, leaseId: action.leaseId, heads, error, inspectionIssue, recoveredCommits },
				{ signal: AbortSignal.timeout(15_000) },
			)
		} catch (error) {
			onError(error)
		} finally {
			inFlight = false
		}
	}
}
