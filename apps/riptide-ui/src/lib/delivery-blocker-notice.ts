export function deliveryBlockerNotice(eventType: string, content: string | null | undefined): string | null {
	if (eventType !== 'system' || !content) return null
	try {
		const value: unknown = JSON.parse(content)
		if (
			value &&
			typeof value === 'object' &&
			'kind' in value &&
			value.kind === 'delivery_blocker' &&
			'reason' in value &&
			typeof value.reason === 'string' &&
			value.reason.trim()
		)
			return value.reason
	} catch {
		return null
	}
	return null
}
