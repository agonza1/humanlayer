import { describe, expect, it } from 'vitest'

import { taskSelectSchema } from './tasks'

const revision = taskSelectSchema.pick({ workflow_revision: true })

describe('task workflow revision decoding', () => {
	it('defaults historical rows to an unenrolled zero revision', () => {
		expect(revision.parse({})).toEqual({ workflow_revision: 0n })
	})
	it('retains bigint revisions without number truncation', () => {
		expect(revision.parse({ workflow_revision: 9007199254740993n })).toEqual({
			workflow_revision: 9007199254740993n,
		})
	})
	it('rejects negative revisions', () => {
		expect(revision.safeParse({ workflow_revision: -1n }).success).toBe(false)
	})
})
