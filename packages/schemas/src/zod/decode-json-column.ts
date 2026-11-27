import type { ZodType } from 'zod/v4'

/** Sync can return a JSONB column as a string or as an already-decoded value. */
export function decodeJsonColumn<T>(schema: ZodType<T>, value: unknown): T | null {
	try {
		return schema.safeParse(typeof value === 'string' ? JSON.parse(value) : value).data ?? null
	} catch {
		return null
	}
}
