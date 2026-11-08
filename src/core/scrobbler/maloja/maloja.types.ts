export interface MalojaTrackMetadata {
	artist: string;
	title: string;
	time: number;

	key?: string;
	album?: string;
	albumartists?: string[];
}

export interface MalojaAccount {
	id: string;
	userApiUrl: string;
	userToken: string;
}

export type MalojaAccountChange =
	| { id?: string; userApiUrl: string; userToken: string }
	| { id: string; remove: true };

export interface MalojaDelivery {
	id: string;
	accountId: string;
	track: MalojaTrackMetadata;
	attempts: number;
	retryAt: number;
}
