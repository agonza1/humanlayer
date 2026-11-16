import { sql } from 'drizzle-orm'
import { bigint, boolean, check, foreignKey, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createSelectSchema } from 'drizzle-zod'
import z from 'zod/v4'

import { jsonbParser } from '../utils/jsonb-parser'
import type {
	ReviewProgressionBinding,
	ReviewProgressionPlacement,
	ReviewScopeInputs,
	ReviewContinuation,
	ReviewOutcome,
	ReviewPrBinding,
	ReviewReportReceipt,
} from '../zodschemas/review-progression'
import {
	ReviewContinuationSchema,
	ReviewOutcomeSchema,
	ReviewPrBindingSchema,
	ReviewProgressionBindingSchema,
	ReviewProgressionPlacementSchema,
	ReviewScopeInputsSchema,
	ReviewProgressionDigestSchema,
	ReviewReportReceiptSchema,
} from '../zodschemas/review-progression'
import { organizations } from './organizations'
import { sessions } from './sessions'
import { tasks } from './tasks'

export const reviewProgression = pgTable(
	'review_progression',
	{
		task_id: uuid()
			.primaryKey()
			.references(() => tasks.id, { onDelete: 'cascade' }),
		organization_id: uuid()
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		resource_owner_user_id: text().notNull(),
		host_id: text().notNull(),
		source_session_id: uuid()
			.notNull()
			.references(() => sessions.id, { onDelete: 'cascade' }),
		enrollment_id: text().notNull(),
		return_route_ref: text().notNull(),
		placement: jsonb().$type<ReviewProgressionPlacement>().notNull(),
		accepted_launch_digest: text().notNull(),
		accepted_launch: jsonb().$type<Record<string, unknown>>().notNull(),
		scope_inputs: jsonb().$type<ReviewScopeInputs>().notNull(),
		verified_binding: jsonb().$type<ReviewProgressionBinding>(),
		binding_digest: text(),
		stage: text().notNull().default('awaiting_delivery'),
		planning_suspended: boolean().notNull().default(false),
		wake_revision: bigint({ mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		action_id: uuid(),
		consumed_revision: bigint({ mode: 'bigint' })
			.notNull()
			.default(sql`-1`),
		claim_generation: bigint({ mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		claim_id: uuid(),
		claimed_revision: bigint({ mode: 'bigint' }),
		claim_expires_at: bigint({ mode: 'bigint' }),
		continuation: jsonb().$type<ReviewContinuation>().notNull().default({ kind: 'stop' }),
		next_wake_at: bigint({ mode: 'bigint' }),
		verified_pr_binding: jsonb().$type<ReviewPrBinding>(),
		last_outcome: jsonb().$type<ReviewOutcome>(),
		last_ack: jsonb().$type<{ claimId: string; generation: string; revision: string; digest: string }>(),
		report_receipts: jsonb().$type<ReviewReportReceipt[]>().notNull().default([]),
		workflow_mutation_receipts: jsonb()
			.$type<
				Array<{
					digest: string
					expectedRevision: string
					revision: string
					result: { transactionId: string; success: boolean }
				}>
			>()
			.notNull()
			.default([]),
		writer_receipts: jsonb()
			.$type<
				Array<{
					key: string
					digest: string
					inputDigest: string
					sessionId: string
					eventId: string
					messageId: string | null
					executionDigest: string
					result: Record<string, unknown>
				}>
			>()
			.notNull()
			.default([]),
		admitted_execution: jsonb().$type<{ sessionId: string; digest: string }>(),
		created_at: bigint({ mode: 'bigint' })
			.notNull()
			.default(sql`(extract(epoch from now()) * 1000)::bigint`),
		updated_at: bigint({ mode: 'bigint' })
			.notNull()
			.default(sql`(extract(epoch from now()) * 1000)::bigint`),
	},
	(t) => [
		foreignKey({
			name: 'review_progression_org_task_fk',
			columns: [t.organization_id, t.task_id],
			foreignColumns: [tasks.organization_id, tasks.id],
		}).onDelete('cascade'),
		index('review_progression_org_host_idx').on(t.organization_id, t.host_id),
		index('review_progression_source_session_idx').on(t.source_session_id),
		check('review_progression_binding_pair', sql`(${t.verified_binding} is null) = (${t.binding_digest} is null)`),
		check('review_progression_launch_digest', sql`${t.accepted_launch_digest} ~ '^[0-9a-f]{64}$'`),
		check(
			'review_progression_claim_tuple',
			sql`(${t.claim_id} is null and ${t.claimed_revision} is null and ${t.claim_expires_at} is null) or (${t.claim_id} is not null and ${t.claimed_revision} is not null and ${t.claim_expires_at} is not null)`,
		),
		check(
			'review_progression_revision_bounds',
			sql`${t.wake_revision} >= 0 and ${t.consumed_revision} >= -1 and ${t.consumed_revision} <= ${t.wake_revision} and ${t.claim_generation} >= 0 and (${t.claimed_revision} is null or (${t.claimed_revision} >= 0 and ${t.claimed_revision} <= ${t.wake_revision}))`,
		),
	],
)

export type ReviewProgression = typeof reviewProgression.$inferSelect
const wireBigint = z.union([z.bigint(), z.string().regex(/^-?(0|[1-9][0-9]*)$/)]).transform((value) => BigInt(value))
export const reviewProgressionSelectSchema = createSelectSchema(reviewProgression, {
	wake_revision: wireBigint,
	consumed_revision: wireBigint,
	claim_generation: wireBigint,
	claimed_revision: wireBigint.nullable(),
	claim_expires_at: wireBigint.nullable(),
	next_wake_at: wireBigint.nullable(),
	created_at: wireBigint,
	updated_at: wireBigint,
	placement: jsonbParser(ReviewProgressionPlacementSchema),
	scope_inputs: jsonbParser(ReviewScopeInputsSchema),
	accepted_launch: jsonbParser(z.record(z.string(), z.unknown())),
	verified_binding: jsonbParser(ReviewProgressionBindingSchema.nullable()),
	continuation: jsonbParser(ReviewContinuationSchema),
	verified_pr_binding: jsonbParser(ReviewPrBindingSchema.nullable()),
	last_outcome: jsonbParser(ReviewOutcomeSchema.nullable()),
	last_ack: jsonbParser(
		z
			.strictObject({
				claimId: z.uuid(),
				generation: z.string().regex(/^(0|[1-9][0-9]*)$/),
				revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
				digest: ReviewProgressionDigestSchema,
			})
			.nullable(),
	),
	report_receipts: jsonbParser(z.array(ReviewReportReceiptSchema).max(64)).default([]),
	admitted_execution: jsonbParser(
		z.strictObject({ sessionId: z.uuid(), digest: ReviewProgressionDigestSchema }).nullable(),
	),
	writer_receipts: jsonbParser(
		z
			.array(
				z.strictObject({
					key: z.string(),
					digest: ReviewProgressionDigestSchema,
					inputDigest: ReviewProgressionDigestSchema,
					sessionId: z.uuid(),
					eventId: z.uuid(),
					messageId: z.uuid().nullable(),
					executionDigest: ReviewProgressionDigestSchema,
					result: z.record(z.string(), z.unknown()),
				}),
			)
			.max(32),
	),
	workflow_mutation_receipts: jsonbParser(
		z
			.array(
				z.strictObject({
					digest: ReviewProgressionDigestSchema,
					expectedRevision: z.string(),
					revision: z.string(),
					result: z.strictObject({ transactionId: z.string(), success: z.boolean() }),
				}),
			)
			.max(32),
	),
})
