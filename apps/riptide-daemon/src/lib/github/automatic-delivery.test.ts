import { tmpdir } from 'node:os'

import { describe, it } from '@effect/vitest'
import type { DeliveryAction } from '@humanlayer/riptide-api-contract/daemon/delivery'
import { deliveryReviewVerdict, type DeliveryReview } from '@humanlayer/schemas/zod/automatic-delivery'
import { Effect } from 'effect'
import { expect, vi } from 'vitest'

import { executeDeliveryAction, inspectCommittedImplementation, type DeliveryCommands } from './automatic-delivery'

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
	for (const [failure, message] of [
		['dirty', 'Local checkout'],
		['empty', 'No committed implementation'],
		['diverged', 'not an ancestor'],
		['closed', 'incompatible'],
	] as const) {
		it.effect(`blocks ${failure} interrupted implementation evidence`, () =>
			Effect.promise(async () => {
				const baseSha = 'b'.repeat(40)
				const remoteSha = 'c'.repeat(40)
				const commands: DeliveryCommands = {
					run: async (binary, args) => {
						if (binary === 'gh')
							return JSON.stringify([
								{
									number: 1,
									headRefOid: remoteSha,
									headRefName: target.branch,
									baseRefName: target.base,
									state: 'CLOSED',
									isDraft: false,
									mergeStateStatus: '',
									reviewDecision: '',
									labels: [],
								},
							])
						if (args[0] === 'status') return failure === 'dirty' ? ' M file' : ''
						if (args[0] === 'branch') return target.branch
						if (args[0] === 'rev-parse') return sha
						if (args[0] === 'remote') return 'git@github.com:test/repo.git'
						if (args[0] === 'ls-remote')
							return `${baseSha}\trefs/heads/main\n${remoteSha}\trefs/heads/feature`
						if (args[0] === 'rev-list') return failure === 'empty' ? '' : sha
						if (args[0] === 'merge-base') {
							if (args[1] === '--is-ancestor' && failure === 'diverged')
								throw new Error('not an ancestor')
							return baseSha
						}
						throw new Error(`Unexpected command: ${binary} ${args.join(' ')}`)
					},
				}
				await expect(inspectCommittedImplementation([target], commands)).rejects.toThrow(message)
			}),
		)
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

describe('Read-only GitHub delivery observation', () => {
	const target = {
		repository: 'test/krisp',
		branch: 'codex/calendar-repair',
		base: 'main',
		directory: '/nonexistent/dirty-checkout',
	}
	const oldSha = 'a'.repeat(40)
	const hostedSha = 'b'.repeat(40)
	const observed: DeliveryAction = { taskId: 'task', leaseId: 'lease', kind: 'observe', targets: [target], heads: [] }
	const hostedPr = {
		number: 33,
		state: 'OPEN',
		headRefOid: hostedSha,
		headRefName: target.branch,
		baseRefName: target.base,
		headRepository: { nameWithOwner: target.repository },
		isDraft: false,
	}
	const hostedRef = { name: target.branch, prefix: 'refs/heads/', target: { oid: hostedSha } }

	function fakeObservation(repository: Record<string, unknown> = {}, errors?: unknown[]) {
		const run = vi.fn<DeliveryCommands['run']>(async (binary, args, cwd) => {
			if (binary === 'git' && args[0] === 'status') return ' M .gitignore'
			if (binary === 'git' && args[0] === 'branch') return target.branch
			if (binary === 'git' && args[0] === 'rev-parse') return oldSha
			if (binary === 'git' && args[0] === 'remote') return 'https://github.com/test/krisp.git'
			expect(binary).toBe('gh')
			expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com'])
			expect(cwd).toBe(tmpdir())
			return JSON.stringify({
				errors,
				data: {
					repository: {
						nameWithOwner: target.repository,
						byTarget: { totalCount: 1, nodes: [hostedPr] },
						branch: hostedRef,
						...repository,
					},
				},
			})
		})
		return { run }
	}

	it.effect('observes a Krisp PR published from another checkout and preserves the dirty checkout guard', () =>
		Effect.promise(async () => {
			const commands = fakeObservation()
			const authorize = vi.fn(async () => true)
			expect(await executeDeliveryAction(observed, commands, authorize)).toEqual([
				{ ...target, sha: hostedSha, number: hostedPr.number, merged: false, draft: false },
			])
			expect(commands.run).toHaveBeenCalledExactlyOnceWith(
				'gh',
				expect.arrayContaining([
					'owner=test',
					'name=krisp',
					'base=main',
					'ref=refs/heads/codex/calendar-repair',
					'known=false',
				]),
				tmpdir(),
			)
			await expect(executeDeliveryAction({ ...observed, kind: 'merge' }, commands, authorize)).rejects.toThrow(
				'Local checkout has newer/uncommitted work',
			)
			expect(authorize).not.toHaveBeenCalled()
		}),
	)

	for (const branch of [hostedRef, null]) {
		it.effect(
			branch
				? 'observes an exact externally merged PR'
				: 'observes an exact Meetily merge after its branch is deleted',
			() =>
				Effect.promise(async () => {
					const tracking = { ...target, number: 17, sha: hostedSha, merged: false, draft: false }
					const commands = fakeObservation({
						byNumber: { ...hostedPr, number: tracking.number, state: 'MERGED' },
						branch,
					})
					const authorize = vi.fn(async () => true)
					const heads = await executeDeliveryAction({ ...observed, heads: [tracking] }, commands, authorize)
					expect(heads).toEqual([{ ...tracking, merged: true }])
					expect(commands.run).toHaveBeenCalledExactlyOnceWith(
						'gh',
						expect.arrayContaining(['known=true', 'number=17']),
						tmpdir(),
					)
					expect(authorize).not.toHaveBeenCalled()
				}),
		)
	}

	for (const [label, repository, expectedError] of [
		[
			'ambiguous PRs',
			{ byTarget: { totalCount: 2, nodes: [hostedPr, { ...hostedPr, number: 34 }] } },
			'More than one GitHub PR',
		],
		[
			'a fork PR',
			{ byTarget: { totalCount: 1, nodes: [{ ...hostedPr, headRepository: { nameWithOwner: 'test/fork' } }] } },
			'does not match the delivery target',
		],
		[
			'a closed unmerged PR',
			{ byTarget: { totalCount: 1, nodes: [{ ...hostedPr, state: 'CLOSED' }] } },
			'does not match the delivery target',
		],
		['a stale PR head', { branch: { ...hostedRef, target: { oid: oldSha } } }, 'branch does not match'],
		['a deleted open branch', { branch: null }, 'branch does not match'],
		['an unrelated ref prefix', { branch: { ...hostedRef, prefix: 'refs/tags/' } }, 'branch does not match'],
	] as const) {
		it.effect(`rejects ${label}`, () =>
			Effect.promise(async () => {
				const authorize = vi.fn(async () => true)
				await expect(executeDeliveryAction(observed, fakeObservation(repository), authorize)).rejects.toThrow(
					expectedError,
				)
				expect(authorize).not.toHaveBeenCalled()
			}),
		)
	}

	it.effect('rejects a different PR when the delivery target already has a tracked number', () =>
		Effect.promise(async () => {
			const commands = fakeObservation({ byNumber: { ...hostedPr, number: 34 } })
			const tracking = { ...target, number: 33, sha: oldSha, merged: false }
			await expect(
				executeDeliveryAction({ ...observed, heads: [tracking] }, commands, async () => true),
			).rejects.toThrow('does not match the delivery target')
		}),
	)

	it.effect('does not treat failed GitHub access or a partial response as a deleted merged branch', () =>
		Effect.promise(async () => {
			const tracking = { ...target, number: 33, sha: hostedSha, merged: false }
			const attempt = { ...observed, heads: [tracking] }
			const commands = fakeObservation({ byNumber: { ...hostedPr, state: 'MERGED' }, branch: null }, [
				{ type: 'FORBIDDEN' },
			])
			await expect(executeDeliveryAction(attempt, commands, async () => true)).rejects.toThrow()
			commands.run.mockRejectedValueOnce(new Error('GitHub is unavailable'))
			await expect(executeDeliveryAction(attempt, commands, async () => true)).rejects.toThrow(
				'GitHub is unavailable',
			)
		}),
	)
})
