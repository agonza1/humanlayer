import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	postLocalSlackDeliveryBlocker,
	resolveLocalSlackAlertRoute,
	resolveStandingLocalSlackAlertRoute,
} from '../src/lib/local-slack-alert-relay'

const scope = {
	routeId: '01942730-8d4f-7368-afa4-a59b596df526',
	taskId: '01942730-8d4f-7368-afa4-a59b596df527',
	organizationId: 'org_fixture',
	ownerId: 'user_fixture',
}
const alert = {
	...scope,
	alertId: '01942730-8d4f-7368-afa4-a59b596df528',
	teamId: 'TTEST',
	channelId: 'DTEST',
}
const origin = 'http://127.0.0.1:51969'
const projectId = '01942730-8d4f-7368-afa4-a59b596df531'
const secondProjectId = '01942730-8d4f-7368-afa4-a59b596df532'
const otherProjectId = '01942730-8d4f-7368-afa4-a59b596df533'
const secondTaskId = '01942730-8d4f-7368-afa4-a59b596df530'
const standingScope = { ...scope, projectId }
const providerSource = [
	"import { appendFileSync, readFileSync } from 'node:fs';",
	"const request = JSON.parse(readFileSync(0, 'utf8'));",
	"const override = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
	"appendFileSync(process.argv[2] + '.requests', JSON.stringify(request) + '\\n');",
	"if (request.taskUrl !== 'http://127.0.0.1:51969/tasks/' + request.taskId || request.recipientUserId !== 'URECIPIENT') process.exit(1);",
	'const { teamId, channelId, botUserId, taskId, alertId, routeId, projectId, schemaVersion } = request;',
	'const standing = schemaVersion === 2 ? { schemaVersion, routeId, projectId } : {};',
	"console.log(JSON.stringify({ status:'delivered', teamId, channelId, botUserId, taskId, alertId, messageTs:'1710000000.000001', ...standing, ...override }));",
].join('\n')
const confirmed = { status: 'delivered', receipt: 'TTEST/DTEST/1710000000.000001' }

describe('local Slack delivery alert relay', () => {
	let directory: string
	let providerConfig: string
	let providerRequests: string
	let grantPath: string
	let grant: {
		schemaVersion: number
		projectIds: string[]
		routeId: string
		organizationId: string
		ownerId: string
		appOrigin: string
		teamId: string
		channelId: string
		botUserId: string
		recipientUserId: string
		executable: string
		script: string
		providerConfigFile: string
	}

	function standingAlert(taskLabel = 'Prepare publication', taskId = scope.taskId) {
		const route = resolveStandingLocalSlackAlertRoute({ ...standingScope, taskId })
		if (!route) throw new Error('The expected standing grant was not resolved')
		return {
			...alert,
			taskId,
			routeId: route.routeId,
			standing: {
				projectId,
				revision: route.revision,
				taskLabel,
				blocker: 'pr-not-ready' as const,
			},
		}
	}

	function readRequests() {
		return readFileSync(providerRequests, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
	}

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'local-slack-alert-relay-'))
		providerConfig = join(directory, 'provider.json')
		providerRequests = providerConfig + '.requests'
		const script = join(directory, 'provider.mjs')
		writeFileSync(script, providerSource)
		writeFileSync(providerConfig, '{}')
		const route = {
			routeId: scope.routeId,
			organizationId: scope.organizationId,
			ownerId: scope.ownerId,
			appOrigin: origin,
			teamId: alert.teamId,
			channelId: alert.channelId,
			botUserId: 'UBOT',
			recipientUserId: 'URECIPIENT',
			executable: process.execPath,
			script,
			providerConfigFile: providerConfig,
		}
		const pin = join(directory, 'route.json')
		writeFileSync(pin, JSON.stringify({ ...route, taskId: scope.taskId }), { mode: 0o600 })
		grant = { ...route, schemaVersion: 2, projectIds: [projectId, secondProjectId] }
		grantPath = join(directory, 'standing-route.json')
		writeFileSync(grantPath, JSON.stringify(grant), { mode: 0o600 })
		vi.stubEnv('APP_ORIGIN', origin)
		vi.stubEnv('HUMANLAYER_LOCAL_SLACK_ALERT_RELAY_FILE', pin)
		vi.stubEnv('HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE', grantPath)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(directory, { recursive: true, force: true })
	})

	it('requires the pinned task, owner, organization and loopback origin', async () => {
		expect(resolveLocalSlackAlertRoute(scope)).toEqual({ channelId: alert.channelId, teamId: alert.teamId })
		expect(resolveLocalSlackAlertRoute({ ...scope, ownerId: 'different-owner' })).toBeNull()
		expect(resolveLocalSlackAlertRoute({ ...scope, organizationId: 'different-org' })).toBeNull()
		expect(resolveLocalSlackAlertRoute({ ...scope, taskId: alert.alertId })).toBeNull()
		await expect(postLocalSlackDeliveryBlocker({ ...alert, channelId: 'DOTHER' })).resolves.toEqual({
			status: 'unavailable',
		})
		vi.stubEnv('APP_ORIGIN', 'https://example.com')
		expect(resolveLocalSlackAlertRoute(scope)).toBeNull()
	})

	it('confirms a matching provider receipt and keeps a mismatched response unconfirmed', async () => {
		await expect(postLocalSlackDeliveryBlocker(alert)).resolves.toEqual(confirmed)
		expect(readRequests()).toEqual([
			{
				...alert,
				botUserId: 'UBOT',
				recipientUserId: 'URECIPIENT',
				taskUrl: origin + '/tasks/' + scope.taskId,
			},
		])
		writeFileSync(providerConfig, '{"botUserId":"UOTHER"}')
		await expect(postLocalSlackDeliveryBlocker(alert)).resolves.toEqual({ status: 'unknown' })
	})

	it('keeps a receipt for a different alert ID unconfirmed even when the sender and destination match', async () => {
		writeFileSync(providerConfig, '{"alertId":"01942730-8d4f-7368-afa4-a59b596df529"}')
		await expect(postLocalSlackDeliveryBlocker(alert)).resolves.toEqual({ status: 'unknown' })
	})

	it('resolves the standing route only for the granted organization, owner, and project', async () => {
		const route = resolveStandingLocalSlackAlertRoute(standingScope)
		expect(route).toEqual({
			teamId: alert.teamId,
			channelId: alert.channelId,
			routeId: scope.routeId,
			revision: expect.stringMatching(/^[0-9a-f]{64}$/),
		})
		expect(resolveStandingLocalSlackAlertRoute({ ...standingScope, taskId: secondTaskId })).toEqual(route)
		expect(resolveStandingLocalSlackAlertRoute({ ...standingScope, projectId: secondProjectId })).toEqual(route)
		expect(resolveStandingLocalSlackAlertRoute({ ...standingScope, ownerId: 'different-owner' })).toBeNull()
		expect(resolveStandingLocalSlackAlertRoute({ ...standingScope, organizationId: 'different-org' })).toBeNull()
		expect(resolveStandingLocalSlackAlertRoute({ ...standingScope, projectId: otherProjectId })).toBeNull()
		expect(resolveStandingLocalSlackAlertRoute({ ...standingScope, taskId: '../outside' })).toBeNull()

		const input = standingAlert()
		await expect(
			postLocalSlackDeliveryBlocker({ ...input, standing: { ...input.standing, projectId: otherProjectId } }),
		).resolves.toEqual({ status: 'unavailable' })
		expect(existsSync(providerRequests)).toBe(false)
	})

	it('rejects non-private, linked, and non-loopback standing manifests', () => {
		const linkedGrant = join(directory, 'linked-route.json')
		symlinkSync(grantPath, linkedGrant)
		vi.stubEnv('HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE', linkedGrant)
		expect(resolveStandingLocalSlackAlertRoute(standingScope)).toBeNull()
		vi.stubEnv('HUMANLAYER_LOCAL_STANDING_SLACK_ALERT_RELAY_FILE', grantPath)

		chmodSync(grantPath, 0o640)
		expect(resolveStandingLocalSlackAlertRoute(standingScope)).toBeNull()
		chmodSync(grantPath, 0o600)
		vi.stubEnv('APP_ORIGIN', 'https://example.com')
		writeFileSync(grantPath, JSON.stringify({ ...grant, appOrigin: 'https://example.com' }))
		expect(resolveStandingLocalSlackAlertRoute(standingScope)).toBeNull()
	})

	it('retains a stable grant revision across list ordering and rejects stale or revoked reservations before sending', async () => {
		const input = standingAlert()
		writeFileSync(grantPath, JSON.stringify({ ...grant, projectIds: [...grant.projectIds].reverse() }))
		expect(resolveStandingLocalSlackAlertRoute(standingScope)?.revision).toBe(input.standing.revision)
		writeFileSync(grantPath, JSON.stringify({ ...grant, recipientUserId: 'UNEWRECIPIENT' }))
		expect(resolveStandingLocalSlackAlertRoute(standingScope)?.revision).not.toBe(input.standing.revision)
		await expect(postLocalSlackDeliveryBlocker(input)).resolves.toEqual({ status: 'unavailable' })
		rmSync(grantPath)
		await expect(postLocalSlackDeliveryBlocker(input)).resolves.toEqual({ status: 'unavailable' })
		expect(existsSync(providerRequests)).toBe(false)
	})

	it('sends only versioned protocol fields and a bounded plain-text label for each eligible task', async () => {
		const input = standingAlert('\n  Ready <@UOWNER> & cue\u202e \n')
		const longLabel = 'x'.repeat(119) + '😀end'
		const second = standingAlert(longLabel, secondTaskId)
		await expect(postLocalSlackDeliveryBlocker(input)).resolves.toEqual(confirmed)
		await expect(postLocalSlackDeliveryBlocker(second)).resolves.toEqual(confirmed)
		const request = {
			...alert,
			botUserId: 'UBOT',
			recipientUserId: 'URECIPIENT',
			taskUrl: origin + '/tasks/' + scope.taskId,
			schemaVersion: 2,
			projectId,
			taskLabel: 'Ready @UOWNER cue',
			blocker: 'pr-not-ready',
		}
		expect(readRequests()).toEqual([
			request,
			{
				...request,
				taskId: secondTaskId,
				taskUrl: origin + '/tasks/' + secondTaskId,
				taskLabel: 'x'.repeat(119),
			},
		])
	})

	it('keeps version, grant, project, task, destination, and sender mismatches unconfirmed', async () => {
		const input = standingAlert()
		for (const mismatch of [
			{ schemaVersion: 1 },
			{ routeId: secondProjectId },
			{ projectId: otherProjectId },
			{ taskId: secondTaskId },
			{ alertId: secondTaskId },
			{ teamId: 'TOTHER' },
			{ channelId: 'DOTHER' },
			{ botUserId: 'UOTHER' },
		]) {
			writeFileSync(providerConfig, JSON.stringify(mismatch))
			await expect(postLocalSlackDeliveryBlocker(input)).resolves.toEqual({ status: 'unknown' })
		}
	})
})
