import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { postLocalSlackDeliveryBlocker, resolveLocalSlackAlertRoute } from '../src/lib/local-slack-alert-relay'

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

describe('local Slack delivery alert relay', () => {
	let directory: string
	let providerConfig: string

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'local-slack-alert-relay-'))
		providerConfig = join(directory, 'provider.json')
		const script = join(directory, 'provider.mjs')
		writeFileSync(
			script,
			`
				import { readFileSync } from 'node:fs';
				const request = JSON.parse(readFileSync(0, 'utf8'));
				const override = JSON.parse(readFileSync(process.argv[2], 'utf8'));
				if (request.taskUrl !== 'http://127.0.0.1:51969/tasks/01942730-8d4f-7368-afa4-a59b596df527' || request.recipientUserId !== 'URECIPIENT') process.exit(1);
				const { teamId, channelId, botUserId, taskId, alertId } = request;
				console.log(JSON.stringify({status:'delivered', teamId, channelId, botUserId, taskId, alertId, messageTs:'1710000000.000001', ...override}));
			`,
		)
		writeFileSync(providerConfig, '{}')
		const pin = join(directory, 'route.json')
		writeFileSync(
			pin,
			JSON.stringify({
				...alert,
				appOrigin: origin,
				botUserId: 'UBOT',
				recipientUserId: 'URECIPIENT',
				executable: process.execPath,
				script,
				providerConfigFile: providerConfig,
			}),
			{ mode: 0o600 },
		)
		vi.stubEnv('APP_ORIGIN', origin)
		vi.stubEnv('HUMANLAYER_LOCAL_SLACK_ALERT_RELAY_FILE', pin)
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
		await expect(postLocalSlackDeliveryBlocker(alert)).resolves.toEqual({
			status: 'delivered',
			receipt: 'TTEST/DTEST/1710000000.000001',
		})
		writeFileSync(providerConfig, '{"botUserId":"UOTHER"}')
		await expect(postLocalSlackDeliveryBlocker(alert)).resolves.toEqual({ status: 'unknown' })
	})
})
