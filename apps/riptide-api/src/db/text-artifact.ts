import { artifactOperationsLog } from '@humanlayer/db/tables/artifact-operations-log'
import { artifactVersions } from '@humanlayer/db/tables/artifact-versions'
import { artifacts, type Artifact } from '@humanlayer/db/tables/artifacts'
import { sessions } from '@humanlayer/db/tables/sessions'
import type { UpsertArtifactInputSchema } from '@humanlayer/riptide-api-contract/daemon/artifacts/upsert'
import { and, eq, sql } from 'drizzle-orm'
import type { z } from 'zod/v4'

import type { PostgresDbTransactionClient } from '../effects/services/postgres/postgres-db.service'
import type { TaskWithAuth } from './task-auth'

export async function findTaskArtifact(tx: PostgresDbTransactionClient, taskId: string, fileName: string) {
	const [artifact] = await tx
		.select()
		.from(artifacts)
		.where(and(eq(artifacts.task_id, taskId), eq(artifacts.file_name, fileName)))
		.limit(1)
	return artifact
}

export function findDesignSession(db: PostgresDbTransactionClient, sessionId: string, organizationId: string) {
	return db
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.organization_id, organizationId),
				sql`(${sessions.labels} @> '[{"name":"rpi:design"}]'::jsonb
			or ${sessions.labels} @> '[{"name":"rpi:design-prd"}]'::jsonb
			or ${sessions.labels} @> '[{"name":"rpi:design-tdd"}]'::jsonb)`,
			),
		)
		.limit(1)
}

type TextWrite = z.infer<typeof UpsertArtifactInputSchema> & { contentHash: string }

/** Both callers hold the same task lock across lookup, version snapshot, update and operation log. */
export async function persistTextArtifact(
	tx: PostgresDbTransactionClient,
	existing: Artifact | undefined,
	task: TaskWithAuth,
	userId: string,
	write: TextWrite,
	now: number,
	checkpointReceipt = false,
) {
	const owner = {
		task_id: task.id,
		task_slug: task.slug,
		organization_id: task.organization_id,
		resource_owner_user_id: task.resource_owner_user_id ?? userId,
		created_by: userId,
	}
	const text = { content: write.content, content_hash: write.contentHash, frontmatter: write.frontmatter ?? {} }
	let artifactId: string
	let versionNumber: number | undefined
	if (existing) {
		artifactId = existing.id
		if (existing.content_hash !== write.contentHash) {
			const [row] = await tx
				.select({ max: sql<number>`max(${artifactVersions.version_number})` })
				.from(artifactVersions)
				.where(eq(artifactVersions.artifact_id, artifactId))
			versionNumber = (row?.max ?? 0) + 1
			await tx.insert(artifactVersions).values({
				...owner,
				artifact_id: artifactId,
				version_number: versionNumber,
				content: existing.content,
				content_hash: existing.content_hash,
			})
		}
		await tx
			.update(artifacts)
			.set({
				...text,
				task_slug: owner.task_slug,
				last_updated_at: BigInt(now),
				is_deleted: false,
				storage_type: 'postgres',
				s3_key: null,
				content_type: null,
				file_size_bytes: null,
			})
			.where(eq(artifacts.id, artifactId))
	} else {
		const [row] = await tx
			.insert(artifacts)
			.values({ ...owner, ...text, file_name: write.fileName, id: write.id })
			.returning({ id: artifacts.id })
		if (!row) throw new Error('insert returned no row')
		artifactId = row.id
	}
	if (write.operationType && (checkpointReceipt || write.operationContents)) {
		await tx.insert(artifactOperationsLog).values({
			...owner,
			id: checkpointReceipt ? artifactId : undefined,
			artifact_id: artifactId,
			session_id: write.sessionId ?? null,
			operation_type: write.operationType,
			operation_contents: checkpointReceipt ? { contentHash: write.contentHash } : write.operationContents,
			version_created: versionNumber !== undefined,
		})
	}
	return { artifactId, versionNumber, created: !existing, resourceOwnerUserId: owner.resource_owner_user_id }
}
