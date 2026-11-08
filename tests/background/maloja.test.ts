import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import MalojaScrobbler from '@/core/scrobbler/maloja/maloja-scrobbler';
import ClonedSong from '@/core/object/cloned-song';
import { ServiceCallResult } from '@/core/object/service-call-result';

vi.mock('webextension-polyfill', () => {
	let data: Record<string, unknown> = {};
	return {
		default: {
			storage: {
				local: {
					get: async (key: string) =>
						structuredClone({ [key]: data[key] }),
					set: async (values: Record<string, unknown>) => {
						data = { ...data, ...structuredClone(values) };
					},
					clear: async () => {
						data = {};
					},
				},
			},
			runtime: { onMessage: { addListener: vi.fn() } },
			alarms: { get: vi.fn(), create: vi.fn(), clear: vi.fn() },
		},
	};
});

const primary = {
	userApiUrl: 'https://primary.example/apis/mlj_1/newscrobble',
	userToken: 'primary-test-key',
};
const secondary = {
	userApiUrl: 'https://secondary.example/apis/mlj_1/newscrobble',
	userToken: 'secondary-test-key',
};

const timestamp = 1730000000;
const song = new ClonedSong(
	{
		parsed: { artist: 'Artist', track: 'Song', album: 'Album' },
		processed: {},
		noRegex: {},
		flags: {},
		metadata: { label: 'Test', startTimestamp: timestamp },
		connector: { id: 'test', label: 'Test', matches: [], js: 'test.js' },
	},
	-1,
);

beforeEach(async () => {
	await browser.storage.local.clear();
	vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('keeps only failed deliveries and retries them after a background restart', async () => {
	await browser.storage.local.set({ Maloja: { properties: primary } });
	const scrobbler = new MalojaScrobbler();
	expect(await scrobbler.getAccounts()).toEqual([
		{ ...primary, id: 'legacy', pending: 0 },
	]);
	await scrobbler.changeAccount(secondary);

	let recovered = false;
	const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
		Response.json({
			status:
				url === secondary.userApiUrl && !recovered
					? 'failure'
					: 'success',
		}),
	);
	vi.stubGlobal('fetch', fetch);

	expect(await scrobbler.scrobble([song])).toEqual([
		ServiceCallResult.RESULT_OK,
	]);
	expect(
		(await scrobbler.getAccounts()).map(({ pending }) => pending),
	).toEqual([0, 1]);
	expect(fetch).toHaveBeenCalledTimes(2);
	for (const [url, init] of fetch.mock.calls) {
		expect(JSON.parse(String(init?.body))).toEqual({
			artist: 'Artist',
			title: 'Song',
			album: 'Album',
			time: timestamp,
			key:
				url === primary.userApiUrl
					? primary.userToken
					: secondary.userToken,
		});
	}

	const restarted = new MalojaScrobbler();
	await restarted.retryPending();
	expect(fetch).toHaveBeenCalledTimes(2);

	recovered = true;
	vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
	await Promise.all([restarted.retryPending(), restarted.retryPending()]);
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(fetch.mock.lastCall?.[0]).toBe(secondary.userApiUrl);
	expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body)).time).toBe(
		timestamp,
	);
	expect(
		(await restarted.getAccounts()).map(({ pending }) => pending),
	).toEqual([0, 0]);
});

it('keeps pending deliveries on key rotation and discards them on removal', async () => {
	const scrobbler = new MalojaScrobbler();
	await scrobbler.changeAccount(primary);
	const [account] = await scrobbler.getAccounts();
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({}, { status: 503 }),
	);
	vi.stubGlobal('fetch', fetch);
	await scrobbler.scrobble([song]);

	const newKey = 'rotated-test-key';
	await scrobbler.changeAccount({ ...account, userToken: newKey });
	await scrobbler.retryPending();
	expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body)).key).toBe(newKey);
	expect((await scrobbler.getAccounts())[0]).toMatchObject({
		id: account.id,
		pending: 1,
	});

	await scrobbler.changeAccount({ id: account.id, remove: true });
	vi.setSystemTime(new Date('2026-01-01T00:10:00Z'));
	await scrobbler.retryPending();
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(await scrobbler.getAccounts()).toEqual([]);
	await expect(scrobbler.getSession()).rejects.toThrow(
		ServiceCallResult.ERROR_AUTH,
	);
});
