'use strict';

import { ServiceCallResult } from '@/core/object/service-call-result';
import type { BaseSong } from '@/core/object/song';
import browser from 'webextension-polyfill';
import type { ScrobblerModels } from '@/core/storage/wrapper';
import type { SessionData } from '@/core/scrobbler/base-scrobbler';
import BaseScrobbler from '@/core/scrobbler/base-scrobbler';
import type {
	MalojaAccount,
	MalojaAccountChange,
	MalojaDelivery,
	MalojaTrackMetadata,
} from '@/core/scrobbler/maloja/maloja.types';

export const MALOJA_RETRY_ALARM = 'retryMalojaDeliveries';

/**
 * Module for communication with Maloja
 */

export default class MalojaScrobbler extends BaseScrobbler<'Maloja'> {
	private writes: Promise<unknown> = Promise.resolve();
	private inFlight = new Set<string>();
	public isLocalOnly = true;

	/** @override */
	protected getStorageName(): 'Maloja' {
		return 'Maloja';
	}

	/** @override */
	public getLabel(): 'Maloja' {
		return 'Maloja';
	}

	/** @override */
	public getStatusUrl(): string {
		return '';
	}

	/** @override */
	public getUserDefinedProperties(): string[] {
		return ['userApiUrl', 'userToken', 'pending'];
	}

	/** @override */
	public async getProfileUrl(): Promise<string> {
		return Promise.resolve('');
	}

	/** @override */
	public async getAuthUrl(): Promise<string> {
		return Promise.resolve('');
	}
	/** @override */
	protected getBaseProfileUrl(): string {
		return '';
	}

	/** @override */
	public getSongInfo(): Promise<Record<string, never>> {
		return Promise.resolve({});
	}

	public toggleLove(): Promise<ServiceCallResult> {
		return Promise.resolve(ServiceCallResult.ERROR_OTHER);
	}

	/** @override */
	public async getSession(): Promise<SessionData> {
		if (!(await this.getAccounts()).length) {
			throw new Error(ServiceCallResult.ERROR_AUTH);
		}
		return { sessionID: 'Maloja' };
	}

	/** @override */
	public isReadyForGrantAccess(): Promise<boolean> {
		return Promise.resolve(false);
	}

	/** @override */
	public sendNowPlaying(): Promise<ServiceCallResult> {
		// Maloja does not support "now playing" scrobbles.
		return Promise.resolve(ServiceCallResult.RESULT_OK);
	}

	/** @override */
	async sendPaused(): Promise<ServiceCallResult> {
		return Promise.resolve(ServiceCallResult.RESULT_OK);
	}

	/** @override */
	async sendResumedPlaying(): Promise<ServiceCallResult> {
		return Promise.resolve(ServiceCallResult.RESULT_OK);
	}

	/** Read the legacy single account until the account list is first saved. */
	private accountsFrom(
		data: NonNullable<ScrobblerModels['Maloja']>,
	): MalojaAccount[] {
		if (data.accounts) {
			return data.accounts;
		}
		const legacy = data.properties;
		return legacy?.userApiUrl && legacy.userToken
			? [{ ...legacy, id: 'legacy' }]
			: [];
	}

	private async read(): Promise<NonNullable<ScrobblerModels['Maloja']>> {
		const { Maloja } = await browser.storage.local.get('Maloja');
		return (Maloja as ScrobblerModels['Maloja']) ?? {};
	}

	// Only the background worker writes this model. Network requests run outside the write queue.
	private serialize<T>(write: () => Promise<T>): Promise<T> {
		const next = this.writes.then(write);
		this.writes = next.catch(() => undefined);
		return next;
	}

	public async getAccounts() {
		const data = await this.read();
		return this.accountsFrom(data).map((account) => ({
			...account,
			pending:
				data.pending?.filter(
					({ accountId }) => accountId === account.id,
				).length ?? 0,
		}));
	}

	public async changeAccount(change: MalojaAccountChange): Promise<void> {
		await this.serialize(async () => {
			const data = await this.read();
			const accounts = this.accountsFrom(data);
			const existing = accounts.find(({ id }) => id === change.id);
			if (change.id && !existing) {
				throw new Error('Unknown Maloja account');
			}

			let pending = data.pending ?? [];
			if ('remove' in change) {
				accounts.splice(
					accounts.findIndex(({ id }) => id === change.id),
					1,
				);
				pending = pending.filter(
					({ accountId }) => accountId !== change.id,
				);
			} else {
				const url = new URL(change.userApiUrl.trim());
				const userToken = change.userToken.trim();
				if (
					!['http:', 'https:'].includes(url.protocol) ||
					url.username ||
					url.password ||
					!userToken
				) {
					throw new Error('Invalid Maloja API URL or key');
				}
				if (
					accounts.some(
						(account) =>
							account !== existing &&
							account.userApiUrl === url.href &&
							account.userToken === userToken,
					)
				) {
					throw new Error('Duplicate Maloja account');
				}

				const sameEndpoint = existing?.userApiUrl === url.href;
				const account = {
					id: sameEndpoint ? existing.id : crypto.randomUUID(),
					userApiUrl: url.href,
					userToken,
				};
				if (existing) {
					accounts[accounts.indexOf(existing)] = account;
					pending = sameEndpoint
						? pending.map((job) =>
								job.accountId === existing.id
									? { ...job, attempts: 0, retryAt: 0 }
									: job,
							)
						: pending.filter(
								({ accountId }) => accountId !== existing.id,
							);
				} else {
					accounts.push(account);
				}
			}
			await browser.storage.local.set({ Maloja: { accounts, pending } });
		});
	}

	/** @override */
	public async scrobble(songs: BaseSong[]): Promise<ServiceCallResult[]> {
		try {
			const jobs = await this.serialize(async () => {
				const data = await this.read();
				const accounts = this.accountsFrom(data);
				const jobs = songs.flatMap((song) =>
					accounts.map(({ id }) => ({
						id: crypto.randomUUID(),
						accountId: id,
						track: this.makeTrackMetadata(song),
						attempts: 0,
						retryAt: 0,
					})),
				);
				if (jobs.length) {
					await this.ensureRetryAlarm();
					await browser.storage.local.set({
						Maloja: {
							...data,
							pending: [...(data.pending ?? []), ...jobs],
						},
					});
				}
				return jobs;
			});
			if (!jobs.length) {
				return songs.map(() => ServiceCallResult.ERROR_OTHER);
			}

			// The shared cache records acceptance. Per-account delivery is tracked separately.
			await this.deliver(jobs).catch(() =>
				this.debugLog('Unable to update delivery queue', 'error'),
			);
			return songs.map(() => ServiceCallResult.RESULT_OK);
		} catch {
			this.debugLog('Unable to queue scrobbles', 'error');
			return songs.map(() => ServiceCallResult.ERROR_OTHER);
		}
	}

	private async ensureRetryAlarm(): Promise<void> {
		if (!(await browser.alarms.get(MALOJA_RETRY_ALARM))) {
			browser.alarms.create(MALOJA_RETRY_ALARM, { periodInMinutes: 1 });
		}
	}

	public async retryPending(): Promise<void> {
		const data = await this.serialize(async () => {
			const data = await this.read();
			if (data.pending?.length) {
				await this.ensureRetryAlarm();
			} else {
				await browser.alarms.clear(MALOJA_RETRY_ALARM);
			}
			return data;
		});
		const due = (data.pending ?? []).filter(
			({ retryAt }) => retryAt <= Date.now(),
		);
		await this.deliver(
			this.accountsFrom(data).flatMap(({ id }) =>
				due.filter(({ accountId }) => accountId === id).slice(0, 10),
			),
		);
	}

	private async deliver(jobs: MalojaDelivery[]): Promise<void> {
		if (!jobs.length) {
			return;
		}
		const deliveries = await this.serialize(async () => {
			const data = await this.read();
			const accounts = new Map(
				this.accountsFrom(data).map((account) => [account.id, account]),
			);
			const pending = new Map(data.pending?.map((job) => [job.id, job]));
			return jobs.flatMap(({ id }) => {
				const job = pending.get(id);
				const account = job && accounts.get(job.accountId);
				if (
					!job ||
					!account ||
					job.retryAt > Date.now() ||
					this.inFlight.has(id)
				) {
					return [];
				}
				this.inFlight.add(id);
				return [{ job, account }];
			});
		});
		await Promise.all(
			deliveries.map(async ({ job, account }) => {
				const { id } = job;
				try {
					const delivered = await this.sendRequest(
						job.track,
						account,
					);
					await this.serialize(async () => {
						const current = await this.read();
						const currentAccount = this.accountsFrom(current).find(
							({ id }) => id === account.id,
						);
						if (
							!currentAccount ||
							(!delivered &&
								currentAccount.userToken !== account.userToken)
						) {
							return;
						}
						const remaining = current.pending ?? [];
						const attempts = job.attempts + 1;
						const retryAt =
							Date.now() +
							Math.min(2 ** job.attempts, 60) * 60_000;
						await browser.storage.local.set({
							Maloja: {
								...current,
								pending: delivered
									? remaining.filter(
											(entry) => entry.id !== id,
										)
									: remaining.map((entry) =>
											entry.id === id
												? {
														...entry,
														attempts,
														retryAt,
													}
												: entry,
										),
							},
						});
					});
				} finally {
					this.inFlight.delete(id);
				}
			}),
		);
	}

	private async sendRequest(
		track: MalojaTrackMetadata,
		account: MalojaAccount,
	): Promise<boolean> {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			this.REQUEST_TIMEOUT,
		);
		try {
			const response = await fetch(account.userApiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...track, key: account.userToken }),
				redirect: 'error',
				signal: controller.signal,
			});
			if (!response.ok) {
				return false;
			}
			const result = (await response.json()) as { status?: string };
			return result.status === 'success' || result.status === 'ok';
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	private makeTrackMetadata(song: BaseSong) {
		const trackMeta: MalojaTrackMetadata = {
			artist: song.getArtist() ?? '',
			title: song.getTrack() ?? '',
			time: song.metadata.startTimestamp,
		};

		const album = song.getAlbum();
		if (album) {
			trackMeta.album = album;
		}

		const albumArtist = song.getAlbumArtist();
		if (albumArtist) {
			trackMeta.albumartists = [albumArtist];
		}

		return trackMeta;
	}
}
