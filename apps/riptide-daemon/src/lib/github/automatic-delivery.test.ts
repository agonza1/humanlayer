import { describe, it } from '@effect/vitest'
import type { DeliveryAction } from '@humanlayer/riptide-api-contract/daemon/delivery'
import { deliveryReviewVerdict, type DeliveryReview } from '@humanlayer/schemas/zod/automatic-delivery'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { executeDeliveryAction, type DeliveryCommands } from './automatic-delivery'

describe('Exact-head delivery host adapter', () => {
	const target = { repository: 'test/repo', branch: 'feature', base: 'main', directory: '/tmp/repo' }
	const sha = 'a'.repeat(40)
	const action: DeliveryAction = {
		taskId: 'task',
		leaseId: 'lease',
		kind: 'merge',
		targets: [target],
		heads: [{ ...target, number: 1, sha, merged: false }],
	}
	for (const priority of ['P0', 'P1', 'P2', 'P3'] as const) {
		it.effect(`triages unrelated verified ${priority} without losing evidence`, () =>
			Effect.sync(() => {
				const review: DeliveryReview = {
					sessionId: 'reviewer',
					source: 'local-qa',
					verdict: 'repair',
					automaticMergeAllowed: true,
					humanCheckpointsSatisfied: true,
					heads: action.heads,
					findings: [
						{
							priority,
							verified: true,
							related: false,
							detail: 'Follow-up: https://github.com/test/repo/issues/2',
						},
					],
					evidence: 'Reproduction and follow-up linked in findings',
				}
				expect(deliveryReviewVerdict(review)).toBe(
					priority === 'P0' || priority === 'P1' ? 'attention' : 'clean',
				)
				expect(review.findings[0]?.detail).toContain('/issues/2')
			}),
		)
	}
	function fake(
		options: {
			dirty?: boolean
			sha?: string
			blocked?: boolean
			failed?: boolean
			labels?: string[]
			noCi?: boolean
			optionalFailure?: boolean
			mergeCommit?: boolean
		} = {},
	) {
		let merged = false
		const mutations: string[][] = []
		const commands: DeliveryCommands = {
			run: async (binary, args) => {
				if (binary === 'gh' && args[0] === 'api')
					return JSON.stringify({
						allow_merge_commit: options.mergeCommit !== false,
						allow_squash_merge: true,
						allow_rebase_merge: true,
					})
				if (binary === 'gh' && args[1] === 'checks')
					return JSON.stringify(
						options.noCi || options.optionalFailure ? [] : [{ bucket: options.failed ? 'fail' : 'pass' }],
					)
				if (binary === 'git') {
					if (args[0] === 'status') return options.dirty ? ' M file' : ''
					if (args[0] === 'branch') return target.branch
					if (args[0] === 'rev-parse') return options.sha ?? sha
					if (args[0] === 'remote') return 'git@github.com:test/repo.git'
					if (args[0] === 'ls-remote') return `${options.sha ?? sha}\trefs/heads/feature`
				}
				if (binary === 'gh' && args[1] === 'list')
					return JSON.stringify([
						{
							number: 1,
							headRefOid: options.sha ?? sha,
							headRefName: 'feature',
							baseRefName: 'main',
							state: merged ? 'MERGED' : 'OPEN',
							isDraft: false,
							mergeStateStatus: options.blocked || options.failed ? 'BLOCKED' : 'CLEAN',
							reviewDecision: 'APPROVED',
							labels: (options.labels ?? []).map((name) => ({ name })),
							statusCheckRollup: [
								{ status: 'COMPLETED', conclusion: options.failed ? 'FAILURE' : 'SUCCESS' },
							],
						},
					])
				if (binary === 'gh' && args[1] === 'merge') {
					mutations.push(args)
					merged = true
					return ''
				}
				throw new Error(`Unexpected command: ${binary} ${args.join(' ')}`)
			},
		}
		return { commands, mutations }
	}
	it.effect('reauthorizes and merges only the reviewed exact head, then freshly verifies', () =>
		Effect.promise(async () => {
			const f = fake()
			let authorizations = 0
			const result = await executeDeliveryAction(action, f.commands, async () => {
				authorizations++
				return true
			})
			expect(authorizations).toBe(1)
			expect(f.mutations).toHaveLength(1)
			expect(f.mutations[0]).toContain('--match-head-commit')
			expect(f.mutations[0]).toContain(sha)
			expect(f.mutations[0]).toContain('--merge')
			expect(f.mutations[0]).not.toContain('--admin')
			expect(result[0]?.merged).toBe(true)
		}),
	)
	for (const options of [{ noCi: true }, { optionalFailure: true }, { mergeCommit: false }]) {
		it.effect(`honors practical repository policy ${JSON.stringify(options)}`, () =>
			Effect.promise(async () => {
				const f = fake(options)
				const result = await executeDeliveryAction(action, f.commands, async () => true)
				expect(result[0]?.merged).toBe(true)
				expect(f.mutations[0]).toContain(options.mergeCommit === false ? '--squash' : '--merge')
			}),
		)
	}
	for (const options of [{ dirty: true }, { blocked: true }, { failed: true }, { labels: ['manual-merge'] }]) {
		it.effect(`does not merge when ${JSON.stringify(options)}`, () =>
			Effect.promise(async () => {
				const f = fake(options)
				await expect(executeDeliveryAction(action, f.commands, async () => true)).rejects.toThrow()
				expect(f.mutations).toHaveLength(0)
			}),
		)
	}
	it.effect('returns changed heads for a new review without merging', () =>
		Effect.promise(async () => {
			const f = fake({ sha: 'b'.repeat(40) })
			const heads = await executeDeliveryAction(action, f.commands, async () => true)
			expect(heads[0]?.sha).toBe('b'.repeat(40))
			expect(f.mutations).toHaveLength(0)
		}),
	)
	it.effect('does not merge after authorization is revoked', () =>
		Effect.promise(async () => {
			const f = fake()
			await expect(executeDeliveryAction(action, f.commands, async () => false)).rejects.toThrow('authorization')
			expect(f.mutations).toHaveLength(0)
		}),
	)
})
