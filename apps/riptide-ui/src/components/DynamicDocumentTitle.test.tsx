import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const route = vi.hoisted(() => ({
	pathname: '/board',
	params: {} as { taskId?: string; sessionId?: string },
	data: [] as { name?: string; title?: string }[],
}))

vi.mock('@tanstack/react-db', () => ({ eq: vi.fn(), useLiveQuery: () => ({ data: route.data }) }))
vi.mock('@tanstack/react-router', () => ({
	useLocation: () => ({ pathname: route.pathname }),
	useParams: () => route.params,
}))
vi.mock('@/components/providers/SyncProvider', () => ({ useSync: () => ({}) }))
vi.mock('@/hooks/live-queries/useArtifactContent', () => ({ useArtifactContent: () => ({ artifact: null }) }))
vi.mock('@/hooks/stores/artifactViewerStore', () => ({
	useArtifactViewerStore: (select: (state: object) => unknown) => select({}),
}))

import { DynamicDocumentTitle } from './DynamicDocumentTitle'

describe('HumanLayer browser title', () => {
	beforeEach(() => {
		vi.stubEnv('VITE_PUBLIC_DEVSTACK_ID', 'local-evaluation')
		route.pathname = '/board'
		route.params = {}
		route.data = []
	})
	afterEach(() => {
		cleanup()
		vi.unstubAllEnvs()
	})

	it('uses the product name on the board even when the build has a stack label', () => {
		render(<DynamicDocumentTitle />)
		expect(document.title).toBe('HumanLayer')
	})

	it('keeps the product name while a task is loading', () => {
		route.pathname = '/tasks/task-1'
		route.params = { taskId: 'task-1' }
		render(<DynamicDocumentTitle />)
		expect(document.title).toBe('HumanLayer')
	})

	it('keeps a loaded task name with the HumanLayer suffix', () => {
		route.pathname = '/tasks/task-1'
		route.params = { taskId: 'task-1' }
		route.data = [{ name: 'Fix the title' }]
		render(<DynamicDocumentTitle />)
		expect(document.title).toBe('Fix the title | HumanLayer')
	})
})
