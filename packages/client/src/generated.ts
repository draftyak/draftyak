export interface paths {
	"/api/v1/accounts": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["pageAccounts"];
		put?: never;
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/accounts/{accountId}": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getAccount"];
		put?: never;
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/settings": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getOwnerSettings"];
		put: operations["putOwnerSettings"];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
}
export type webhooks = Record<string, never>;
export interface components {
	schemas: {
		/**
		 * @description read_only has no send or organize path.
		 * @enum {string}
		 */
		__draftyak_defs_000001: "full" | "read_only";
		/**
		 * @description active syncs; paused doesn't, until its cause clears; credential_lost waits for a reconnect until deletionDeadline; disconnecting cancels, revokes and purges.
		 * @enum {string}
		 */
		__draftyak_defs_000002: "active" | "paused" | "credential_lost" | "disconnecting";
		__draftyak_defs_000003: {
			/** @description An owner-chosen account alias. */
			alias: string;
			/** @constant */
			channel: "chat";
			/** @description An instant as UTC milliseconds since the epoch, a safe integer. */
			createdAt: number;
			/** @description When a credential_lost account is purged unless reconnected; otherwise null. */
			deletionDeadline: number | null;
			/** @description The version of the disclosure the owner agreed to for it. */
			disclosureVersion: number;
			/** @description How many days back the first sync reaches. */
			historyLimitDays: number;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			id: string;
			mode: components["schemas"]["__draftyak_defs_000001"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			pluginInstanceId: string;
			selfUserId: components["schemas"]["__draftyak_defs_000006"];
			status: components["schemas"]["__draftyak_defs_000002"];
			teamId: components["schemas"]["__draftyak_defs_000006"] | null;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			userId: string;
		} & (
			| {
					deletionDeadline?: number;
					/** @constant */
					status?: "credential_lost";
			  }
			| {
					deletionDeadline?: null;
					status?: unknown;
			  }
		);
		__draftyak_defs_000004: {
			address: components["schemas"]["__draftyak_defs_000005"];
			/** @description An owner-chosen account alias. */
			alias: string;
			/** @constant */
			channel: "email";
			/** @description An instant as UTC milliseconds since the epoch, a safe integer. */
			createdAt: number;
			/** @description When a credential_lost account is purged unless reconnected; otherwise null. */
			deletionDeadline: number | null;
			/** @description The version of the disclosure the owner agreed to for it. */
			disclosureVersion: number;
			/** @description How many days back the first sync reaches. */
			historyLimitDays: number;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			id: string;
			mode: components["schemas"]["__draftyak_defs_000001"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			pluginInstanceId: string;
			status: components["schemas"]["__draftyak_defs_000002"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			userId: string;
		} & (
			| {
					deletionDeadline?: number;
					/** @constant */
					status?: "credential_lost";
			  }
			| {
					deletionDeadline?: null;
					status?: unknown;
			  }
		);
		/** @description An address as the hub normalizes it: a dot-atom local part as given, without spaces, quotes or invisible characters, and a lower-case DNS domain with IDN labels as A-labels. */
		__draftyak_defs_000005: string;
		/** @description A provider's own id, opaque to the hub: visible ASCII, no spaces. */
		__draftyak_defs_000006: string;
		/** @enum {string} */
		__draftyak_defs_000007: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
		/** @description The owner's working days and hours, HH:mm in their zone, start before end; the default is mon to fri, 09:00 to 17:00. */
		__draftyak_defs_000008: {
			days: components["schemas"]["__draftyak_defs_000007"][];
			end: string;
			start: string;
		};
		/** @description An IANA time zone name, such as America/Chicago; Temporal checks that it exists. */
		__draftyak_defs_000009: string;
		/** @description A connected account. alias is the owner's own name for it, never taken from provider data. */
		__draftyak_defs_000010:
			| components["schemas"]["__draftyak_defs_000013"]
			| components["schemas"]["__draftyak_defs_000014"];
		/**
		 * @description read_only has no send or organize path.
		 * @enum {string}
		 */
		__draftyak_defs_000011: "full" | "read_only";
		/**
		 * @description active syncs; paused doesn't, until its cause clears; credential_lost waits for a reconnect until deletionDeadline; disconnecting cancels, revokes and purges.
		 * @enum {string}
		 */
		__draftyak_defs_000012: "active" | "paused" | "credential_lost" | "disconnecting";
		__draftyak_defs_000013: {
			/** @description An owner-chosen account alias. */
			alias: string;
			/** @constant */
			channel: "chat";
			/** @description An instant as UTC milliseconds since the epoch, a safe integer. */
			createdAt: number;
			/** @description When a credential_lost account is purged unless reconnected; otherwise null. */
			deletionDeadline: number | null;
			/** @description The version of the disclosure the owner agreed to for it. */
			disclosureVersion: number;
			/** @description How many days back the first sync reaches. */
			historyLimitDays: number;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			id: string;
			mode: components["schemas"]["__draftyak_defs_000011"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			pluginInstanceId: string;
			selfUserId: components["schemas"]["__draftyak_defs_000017"];
			status: components["schemas"]["__draftyak_defs_000012"];
			teamId: components["schemas"]["__draftyak_defs_000017"] | null;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			userId: string;
		} & (
			| {
					deletionDeadline?: number;
					/** @constant */
					status?: "credential_lost";
			  }
			| {
					deletionDeadline?: null;
					status?: unknown;
			  }
		);
		__draftyak_defs_000014: {
			address: components["schemas"]["__draftyak_defs_000015"];
			/** @description An owner-chosen account alias. */
			alias: string;
			/** @constant */
			channel: "email";
			/** @description An instant as UTC milliseconds since the epoch, a safe integer. */
			createdAt: number;
			/** @description When a credential_lost account is purged unless reconnected; otherwise null. */
			deletionDeadline: number | null;
			/** @description The version of the disclosure the owner agreed to for it. */
			disclosureVersion: number;
			/** @description How many days back the first sync reaches. */
			historyLimitDays: number;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			id: string;
			mode: components["schemas"]["__draftyak_defs_000011"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			pluginInstanceId: string;
			status: components["schemas"]["__draftyak_defs_000012"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			userId: string;
		} & (
			| {
					deletionDeadline?: number;
					/** @constant */
					status?: "credential_lost";
			  }
			| {
					deletionDeadline?: null;
					status?: unknown;
			  }
		);
		/** @description An address as the hub normalizes it: a dot-atom local part as given, without spaces, quotes or invisible characters, and a lower-case DNS domain with IDN labels as A-labels. */
		__draftyak_defs_000015: string;
		__draftyak_defs_000016: {
			account: components["schemas"]["__draftyak_defs_000010"];
			generation: number;
		};
		/** @description A provider's own id, opaque to the hub: visible ASCII, no spaces. */
		__draftyak_defs_000017: string;
		/** @description A connected account. alias is the owner's own name for it, never taken from provider data. */
		__draftyak_defs_000018:
			| components["schemas"]["__draftyak_defs_000021"]
			| components["schemas"]["__draftyak_defs_000022"];
		/**
		 * @description read_only has no send or organize path.
		 * @enum {string}
		 */
		__draftyak_defs_000019: "full" | "read_only";
		/**
		 * @description active syncs; paused doesn't, until its cause clears; credential_lost waits for a reconnect until deletionDeadline; disconnecting cancels, revokes and purges.
		 * @enum {string}
		 */
		__draftyak_defs_000020: "active" | "paused" | "credential_lost" | "disconnecting";
		__draftyak_defs_000021: {
			/** @description An owner-chosen account alias. */
			alias: string;
			/** @constant */
			channel: "chat";
			/** @description An instant as UTC milliseconds since the epoch, a safe integer. */
			createdAt: number;
			/** @description When a credential_lost account is purged unless reconnected; otherwise null. */
			deletionDeadline: number | null;
			/** @description The version of the disclosure the owner agreed to for it. */
			disclosureVersion: number;
			/** @description How many days back the first sync reaches. */
			historyLimitDays: number;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			id: string;
			mode: components["schemas"]["__draftyak_defs_000019"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			pluginInstanceId: string;
			selfUserId: components["schemas"]["__draftyak_defs_000024"];
			status: components["schemas"]["__draftyak_defs_000020"];
			teamId: components["schemas"]["__draftyak_defs_000024"] | null;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			userId: string;
		} & (
			| {
					deletionDeadline?: number;
					/** @constant */
					status?: "credential_lost";
			  }
			| {
					deletionDeadline?: null;
					status?: unknown;
			  }
		);
		__draftyak_defs_000022: {
			address: components["schemas"]["__draftyak_defs_000023"];
			/** @description An owner-chosen account alias. */
			alias: string;
			/** @constant */
			channel: "email";
			/** @description An instant as UTC milliseconds since the epoch, a safe integer. */
			createdAt: number;
			/** @description When a credential_lost account is purged unless reconnected; otherwise null. */
			deletionDeadline: number | null;
			/** @description The version of the disclosure the owner agreed to for it. */
			disclosureVersion: number;
			/** @description How many days back the first sync reaches. */
			historyLimitDays: number;
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			id: string;
			mode: components["schemas"]["__draftyak_defs_000019"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			pluginInstanceId: string;
			status: components["schemas"]["__draftyak_defs_000020"];
			/** @description A ULID: 26 upper-case Crockford base32 characters. */
			userId: string;
		} & (
			| {
					deletionDeadline?: number;
					/** @constant */
					status?: "credential_lost";
			  }
			| {
					deletionDeadline?: null;
					status?: unknown;
			  }
		);
		/** @description An address as the hub normalizes it: a dot-atom local part as given, without spaces, quotes or invisible characters, and a lower-case DNS domain with IDN labels as A-labels. */
		__draftyak_defs_000023: string;
		/** @description A provider's own id, opaque to the hub: visible ASCII, no spaces. */
		__draftyak_defs_000024: string;
		/** @description A connected account. alias is the owner's own name for it, never taken from provider data. */
		"draftyak.entities.Account":
			| components["schemas"]["__draftyak_defs_000003"]
			| components["schemas"]["__draftyak_defs_000004"];
		/** @description The owner's time zone, which schedules and lookups use, and working hours. */
		"draftyak.entities.OwnerSettings": {
			workingHours: components["schemas"]["__draftyak_defs_000008"];
			zone: components["schemas"]["__draftyak_defs_000009"];
		};
		"draftyak.native.AccountPage": {
			accounts: components["schemas"]["__draftyak_defs_000016"][];
			nextId: string | null;
		};
		"draftyak.native.AccountRecord": {
			account: components["schemas"]["__draftyak_defs_000018"];
			generation: number;
		};
	};
	responses: never;
	parameters: never;
	requestBodies: never;
	headers: never;
	pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
	pageAccounts: {
		parameters: {
			query?: {
				afterId?: string;
			};
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description Account page */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": components["schemas"]["draftyak.native.AccountPage"];
				};
			};
			/** @description Invalid request */
			400: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "INVALID_REQUEST"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "INVALID_REQUEST";
					};
				};
			};
			/** @description Forbidden */
			403: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "FORBIDDEN"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "FORBIDDEN";
					};
				};
			};
			/** @description Unavailable */
			503: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "UNAVAILABLE"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "UNAVAILABLE";
					};
				};
			};
		};
	};
	getAccount: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				accountId: string;
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description Account snapshot */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": components["schemas"]["draftyak.native.AccountRecord"];
				};
			};
			/** @description Invalid request */
			400: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "INVALID_REQUEST"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "INVALID_REQUEST";
					};
				};
			};
			/** @description Forbidden */
			403: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "FORBIDDEN"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "FORBIDDEN";
					};
				};
			};
			/** @description Not found */
			404: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "NOT_FOUND"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "NOT_FOUND";
					};
				};
			};
			/** @description Unavailable */
			503: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "UNAVAILABLE"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "UNAVAILABLE";
					};
				};
			};
		};
	};
	getOwnerSettings: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description Owner settings */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": components["schemas"]["draftyak.entities.OwnerSettings"];
				};
			};
			/** @description Invalid request */
			400: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "INVALID_REQUEST"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "INVALID_REQUEST";
					};
				};
			};
			/** @description Forbidden */
			403: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "FORBIDDEN"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "FORBIDDEN";
					};
				};
			};
			/** @description Not found */
			404: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "NOT_FOUND"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "NOT_FOUND";
					};
				};
			};
			/** @description Unavailable */
			503: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "UNAVAILABLE"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "UNAVAILABLE";
					};
				};
			};
		};
	};
	putOwnerSettings: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": components["schemas"]["draftyak.entities.OwnerSettings"];
			};
		};
		responses: {
			/** @description Owner settings */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": components["schemas"]["draftyak.entities.OwnerSettings"];
				};
			};
			/** @description Invalid request */
			400: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "INVALID_REQUEST"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "INVALID_REQUEST";
					};
				};
			};
			/** @description Forbidden */
			403: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "FORBIDDEN"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "FORBIDDEN";
					};
				};
			};
			/** @description Unavailable */
			503: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					/**
					 * @example {
					 *       "code": "UNAVAILABLE"
					 *     }
					 */
					"application/json": {
						/** @enum {string} */
						code: "UNAVAILABLE";
					};
				};
			};
		};
	};
}
