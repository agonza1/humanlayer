import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { NativeExecutionLinks } from './NativeExecutionLinks'

const value = {
	mode: 'main-mediated',
	stage: 'in_review',
	repository: 'owner/repo',
	directory: '/isolated',
	coderThreadId: '11111111-1111-4111-8111-111111111111',
	qaThreadId: '22222222-2222-4222-8222-222222222222',
	headSha: 'a'.repeat(40),
}
afterEach(cleanup)
it('links to both real native chats and shows their IDs without execution controls', () => {
	render(<NativeExecutionLinks value={value} />)
	expect(screen.getByRole('link', { name: 'Coder chat' })).toHaveAttribute(
		'href',
		`codex://threads/${value.coderThreadId}`,
	)
	expect(screen.getByRole('link', { name: 'QA chat' })).toHaveAttribute('href', `codex://threads/${value.qaThreadId}`)
	expect(screen.getByText(value.coderThreadId)).toBeVisible()
	expect(screen.getByText('In review')).toBeVisible()
	expect(screen.queryByRole('button')).toBeNull()
})
it('shows Done after confirmed delivery while preserving native chat links', () => {
	render(
		<NativeExecutionLinks
			value={{ ...value, stage: 'blocked', reason: 'Old blocked reason' }}
			deliveryResult={{
				status: 'merged',
				pullRequestUrl: 'https://github.com/owner/repo/pull/1',
				headSha: value.headSha,
			}}
		/>,
	)
	expect(screen.getByText('Done')).toBeVisible()
	expect(screen.queryByText('In review')).toBeNull()
	expect(screen.queryByText('Old blocked reason')).toBeNull()
	expect(screen.getByRole('link', { name: 'QA chat' })).toBeVisible()
})
it('shows blocked reason and rejects malformed link metadata', () => {
	const view = render(<NativeExecutionLinks value={{ ...value, stage: 'blocked', reason: 'Scoped QA regression' }} />)
	expect(screen.getByText('Blocked')).toBeVisible()
	expect(screen.getByText('Scoped QA regression')).toBeVisible()
	view.rerender(<NativeExecutionLinks value={{ ...value, coderThreadId: 'javascript:alert(1)' }} />)
	expect(screen.queryByRole('group')).toBeNull()
	expect(screen.queryByRole('link')).toBeNull()
})
