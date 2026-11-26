import { describe, expect, it } from 'vitest'

import { describeBoardTask, type BoardSessionInput } from '../src/task-board'
import type { AutomaticDelivery, DeliveryHead } from '../src/zod/automatic-delivery'
import type { TaskAttention } from '../src/zod/task-attention'

const target = {
	repository: 'example/meetily',
	branch: 'codex/recording-controls',
	base: 'main',
	directory: '/work/meetily',
}
const mergedHead: DeliveryHead = {
	...target,
	number: 17,
	sha: 'a'.repeat(40),
	merged: true,
	draft: false,
}
const sourceSessionId = '00000000-0000-4000-8000-000000000001'
const attention = 'Main recovery ended. Check the workspace.'
const blockerAlert = {
	id: '00000000-0000-4000-8000-000000000002',
	slack: { status: 'delivered', receipt: 'slack-receipt' },
	origin: { status: 'unavailable' },
	slackRoute: 'standing',
} as const satisfies AutomaticDelivery['blockerAlert']
const idle: BoardSessionInput = {
	id: sourceSessionId,
	archived: false,
	status: 'ready_for_input',
	labels: [{ name: 'rpi:implementation', title: 'implementation' }],
	last_activity_at: 10,
}

function delivery(heads: DeliveryHead[]): AutomaticDelivery {
	return {
		version: 1,
		authorizedBy: 'task-owner',
		authorizedAt: 1,
		mode: 'pr-only',
		hostId: 'approved-host',
		sourceSessionId,
		targets: [target],
		policyAcknowledgement: 'Stop at the reviewed PR.',
		phase: 'attention',
		passes: 3,
		recoveryAttempts: 1,
		managedSessionId: null,
		managedAt: 20,
		deliverySessionIds: [],
		workRevision: 'existing-revision',
		heads: [{ ...mergedHead, merged: false }],
		reviews: [],
		attention,
		attentionDuringPublication: true,
		attentionObservation: { checkedAt: 30, heads },
		blockerAlert,
		lease: null,
	}
}

describe('board projection of read-only PR observation', () => {
	it('shows merged recorder work in review with acceptance pending and the existing alert gap', () => {
		const current = delivery([mergedHead])
		const original = JSON.stringify(current)
		expect(describeBoardTask({ automatic_delivery: current }, [idle])).toMatchObject({
			columnId: 'in-review',
			workflowLabel: { name: 'rpi:review' },
			status: 'ready_for_input',
			delivery: {
				status: 'blocked',
				stage: 'in-review',
				reason: 'PR merged on GitHub. Verify remaining acceptance before completing this task.',
				alert: { slack: 'delivered', origin: 'unavailable', slackRoute: 'standing' },
			},
		})
		expect(JSON.stringify(current)).toBe(original)
	})

	it.each([
		{ heads: [], status: 'ready_for_input' },
		{ heads: [{ ...mergedHead, merged: false }], status: 'ready_for_input' },
		{ heads: [mergedHead], status: 'running' },
		{ heads: [mergedHead], status: 'ready_for_input', activity: 40 },
	])('keeps the original blocker without current merged evidence and idle work', ({ heads, status, activity }) => {
		const session = { ...idle, status, last_activity_at: activity ?? idle.last_activity_at }
		expect(describeBoardTask({ automatic_delivery: delivery(heads) }, [session])).toMatchObject({
			columnId: 'implementation',
			status,
			delivery: { status: 'blocked', reason: attention },
		})
	})
})

const externalWait: TaskAttention = {
	id: '019abcde-1234-7abc-8abc-123456789abc',
	revision: 2,
	authorizedBy: 'task-owner',
	kind: 'external_wait',
	reason: 'The carrier has not confirmed the counting window.',
	responsible: 'Carrier support',
	nextAction: 'Confirm the counting window.',
	evidence: 'Provider ticket 42',
	openedAt: 12,
	updatedAt: 18,
	followUpAt: 200,
	notice: {
		id: '00000000-0000-4000-8000-000000000003',
		slack: { status: 'delivered', receipt: 'private-route-id' },
		origin: { status: 'unavailable' },
		reservedAt: 201,
	},
}

it('keeps an external wait and delivery blocker on the same phase with independent check and update times', () => {
	const current = {
		...delivery([mergedHead]),
		blockerAlert: { ...blockerAlert, openedAt: 11 },
		attentionObservation: { checkedAt: 30, changedAt: 25, heads: [mergedHead] },
	}
	const board = describeBoardTask(
		{
			resource_owner_user_id: 'task-owner',
			automatic_delivery: current,
			task_attention: JSON.stringify(externalWait),
		},
		[idle],
	)
	expect(board.columnId).toBe('in-review')
	expect(board.lastUpdatedAtMs).toBe(10)
	expect(board.attention).toMatchObject([
		{
			kind: 'external_wait',
			source: 'task',
			id: externalWait.id,
			responsible: 'Carrier support',
			updatedAt: 18,
			followUpAt: 200,
			lastNoticeAt: 201,
			alert: { slack: 'delivered', origin: 'unavailable' },
		},
		{ kind: 'blocked', source: 'delivery', openedAt: 11, updatedAt: 25, lastCheckedAt: 30 },
	])
	expect(JSON.stringify(board.attention)).not.toContain('private-route-id')
})

it('omits resolved and transferred attention and keeps genuine session approval visible', () => {
	const approval = { ...idle, status: 'needs_approval' }
	const resolved = describeBoardTask({ task_attention: { ...externalWait, resolvedAt: 100 } }, [approval])
	const transferred = describeBoardTask({ resource_owner_user_id: 'different-owner', task_attention: externalWait }, [
		approval,
	])
	const expected = [{ kind: 'owner_input', source: 'session', id: approval.id }]
	expect(resolved.attention).toMatchObject(expected)
	expect(transferred.attention).toMatchObject(expected)
	expect(transferred.columnId).toBe('implementation')
})
