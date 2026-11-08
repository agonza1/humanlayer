import { describe, expect, it } from 'vitest'

import {
	ReviewProgressionBindingSchema,
	ReviewProgressionEnrollmentSchema,
	ReviewProgressionPlacementSchema,
	ReviewContinuationSchema,
	ReviewPrBindingSchema,
	ReviewOutcomeSchema,
} from '../zodschemas/review-progression'
import { reviewProgressionSelectSchema } from './review-progression'

const id = '019fcc4b-88cd-742f-970e-cd072c8b79f0'

describe('review progression closed bindings', () => {
	it('keeps confirmed reporting receipts closed, bounded and separate from execution receipts', () => {
		const fields = reviewProgressionSelectSchema.pick({ report_receipts: true })
		const receipt = {
			requestId: 'a'.repeat(64),
			outcomeKey: 'b'.repeat(64),
			destinationSlot: 'artifact',
			receiptIdentity: id,
			contentDigest: 'c'.repeat(64),
		}
		expect(fields.parse({})).toEqual({ report_receipts: [] })
		expect(fields.parse({ report_receipts: JSON.stringify([receipt]) })).toEqual({ report_receipts: [receipt] })
		expect(fields.safeParse({ report_receipts: Array(65).fill(receipt) }).success).toBe(false)
		expect(fields.safeParse({ report_receipts: [{ ...receipt, command: 'run' }] }).success).toBe(false)
		expect(fields.safeParse({ report_receipts: [{ ...receipt, destinationSlot: 'native_origin' }] }).success).toBe(
			false,
		)
	})
	it('retains decimal coordination revisions without number conversion', () => {
		const fields = reviewProgressionSelectSchema.pick({
			wake_revision: true,
			consumed_revision: true,
			claim_generation: true,
			claimed_revision: true,
			claim_expires_at: true,
			next_wake_at: true,
		})
		const value = fields.parse({
			wake_revision: '9007199254740993',
			consumed_revision: '-1',
			claim_generation: '9007199254740995',
			claimed_revision: null,
			claim_expires_at: null,
			next_wake_at: null,
		})
		expect(value.wake_revision).toBe(9007199254740993n)
		expect(value.claim_generation).toBe(9007199254740995n)
		expect(value.consumed_revision).toBe(-1n)
		expect(fields.safeParse({ ...value, wake_revision: 9007199254740992 }).success).toBe(false)
	})
	it('parses Electric JSON text through closed nested schemas', () => {
		const schema = reviewProgressionSelectSchema.pick({
			continuation: true,
			last_outcome: true,
			verified_pr_binding: true,
		})
		expect(
			schema.parse({ continuation: '{"kind":"stop"}', last_outcome: 'null', verified_pr_binding: null }),
		).toEqual({ continuation: { kind: 'stop' }, last_outcome: null, verified_pr_binding: null })
		expect(
			schema.safeParse({
				continuation: '{"kind":"stop","command":"run"}',
				last_outcome: null,
				verified_pr_binding: null,
			}).success,
		).toBe(false)
		expect(schema.safeParse({ continuation: '{', last_outcome: null, verified_pr_binding: null }).success).toBe(
			false,
		)
	})
	it('accepts only closed continuations and source-bound PR evidence', () => {
		expect(ReviewContinuationSchema.parse({ kind: 'stop' })).toEqual({ kind: 'stop' })
		expect(ReviewContinuationSchema.safeParse({ kind: 'wait', nextWakeAt: 'never' }).success).toBe(false)
		expect(ReviewContinuationSchema.safeParse({ kind: 'stop', actionId: id }).success).toBe(false)
		const binding = {
			repository: 'example/product',
			pr: 7,
			branch: 'codex/test',
			headSha: 'a'.repeat(40),
			scopeSha256: 'b'.repeat(64),
			sourceSessionId: id,
		}
		expect(ReviewPrBindingSchema.parse(binding)).toEqual(binding)
		expect(ReviewPrBindingSchema.safeParse({ ...binding, pr: true }).success).toBe(false)
		expect(ReviewPrBindingSchema.safeParse({ ...binding, authority: 'task artifact' }).success).toBe(false)
		expect(
			ReviewOutcomeSchema.safeParse({
				status: 'needs_decision',
				reason: 'unknown_writer',
				context: null,
				continuation: { kind: 'stop' },
				command: 'run',
			}).success,
		).toBe(false)
	})
	it.each(['../config', '/private/config', 'https://example.com', '--execute', 'a b', 'route\n', 'a'.repeat(81)])(
		'rejects non-opaque enrollment reference %j',
		(value) => {
			expect(
				ReviewProgressionEnrollmentSchema.safeParse({ enrollmentId: value, returnRouteRef: 'origin_1' })
					.success,
			).toBe(false)
		},
	)
	it('requires real discriminated placement and rejects invented legacy workspace IDs', () => {
		const legacy = {
			kind: 'legacy_directory',
			projectId: null,
			workspaceId: null,
			setupRowId: id,
			workspaceSpecDigest: null,
		}
		expect(ReviewProgressionPlacementSchema.parse(legacy)).toEqual(legacy)
		expect(ReviewProgressionPlacementSchema.safeParse({ ...legacy, workspaceId: id }).success).toBe(false)
		expect(ReviewProgressionPlacementSchema.safeParse({ ...legacy, setupRowId: null }).success).toBe(false)
		expect(
			ReviewProgressionPlacementSchema.safeParse({
				kind: 'project_workspace',
				projectId: id,
				workspaceId: id,
				setupRowId: id,
			}).success,
		).toBe(false)
	})
	it('does not accept transport or execution fields in enrollment or binding', () => {
		expect(
			ReviewProgressionEnrollmentSchema.safeParse({
				enrollmentId: 'personal',
				returnRouteRef: 'origin',
				argv: ['sh'],
			}).success,
		).toBe(false)
		const binding = {
			workingDirectory: '/isolated/repo',
			repositoryDirectory: '/isolated/repo',
			repository: 'example/product',
			branch: 'codex/test',
			helperConfigDigest: 'a'.repeat(64),
		}
		expect(ReviewProgressionBindingSchema.parse(binding)).toEqual(binding)
		expect(
			ReviewProgressionBindingSchema.safeParse({ ...binding, destination: 'https://example.com' }).success,
		).toBe(false)
	})
})
