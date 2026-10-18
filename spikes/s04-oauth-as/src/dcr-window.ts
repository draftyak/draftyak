import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cacheDir } from "@draftyak/spike-kit";
import { type Configuration, errors, type Provider } from "oidc-provider";
import { ROUTES } from "./provider.ts";
import type { ProviderRoute } from "./routes.ts";

// §6: DCR stays off, apart from an owner-opened 10-minute window for a client S4 finds needs it.
export const WINDOW_MS: number = 10 * 60_000;
// Registration is unauthenticated while open, and registered clients are never evicted (store.ts),
// so a window closes early after this many.
export const MAX_REGISTRATIONS = 10;

// Spike-only switches: DRAFTYAK_DCR_WINDOW=1 opens the window as the AS starts, and the dcr-window
// command (`pnpm --filter @draftyak/spike-s04-oauth-as dcr-window`) opens it in a running AS.
export function dcrWindowRequested(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_DCR_WINDOW ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_DCR_WINDOW is 1 or 0, not "${value}"`);
	}
	return value === "1";
}

// The file the dcr-window command drops and a watching AS takes, in the owner's own cache folder.
export const switchFile = (): string => path.join(cacheDir(), "s04-oauth-as", "dcr-window");

export interface WindowOptions {
	readonly now?: () => number;
	readonly ms?: number;
	readonly max?: number;
}

export class DcrWindow {
	readonly #now: () => number;
	readonly #ms: number;
	readonly #max: number;
	#closesAt = 0;
	#registered = 0;
	#opened = 0;
	// The window each registration took its place in, by request.
	readonly #places = new WeakMap<object, number>();

	constructor(options: WindowOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#ms = options.ms ?? WINDOW_MS;
		this.#max = options.max ?? MAX_REGISTRATIONS;
	}

	// Opens, or reopens, for the next 10 minutes; returns when it closes.
	open(): number {
		this.#closesAt = this.#now() + this.#ms;
		this.#registered = 0;
		this.#opened += 1;
		return this.#closesAt;
	}

	close(): void {
		this.#closesAt = 0;
	}

	get isOpen(): boolean {
		return this.#now() < this.#closesAt && this.#registered < this.#max;
	}

	get registered(): number {
		return this.#registered;
	}

	// oidc-provider names a new client after reading the request body and right before storing it,
	// so this is where the window holds: a request let in while it was open, however long it held
	// its body, registers nothing once the window has closed or filled up.
	#place(request: object): string {
		if (!this.isOpen) throw new errors.OIDCProviderError(404, "not_found");
		this.#registered += 1;
		this.#places.set(request, this.#opened);
		return randomBytes(32).toString("base64url");
	}

	// Registration on in the provider, but reachable only through `route` while the window is open.
	// No initial access token, and no registration access token: nothing routes the endpoint that
	// reads a registration back.
	configure(configuration: Configuration): void {
		const features = (configuration.features ?? {}) as Record<string, unknown>;
		configuration.features = features;
		features.registration = {
			enabled: true,
			initialAccessToken: false,
			issueRegistrationAccessToken: false,
			idFactory: (ctx: object) => this.#place(ctx),
		};
	}

	// For createApp's routes: POST /oauth/register, a 404 and gone from the metadata while closed.
	readonly route: ProviderRoute = {
		method: "POST",
		path: ROUTES.registration,
		open: () => this.isOpen,
	};

	install(provider: Provider): Provider {
		// Metadata refused after the client was named stores nothing, so its place comes back.
		provider.on("registration_create.error", (ctx, error) => {
			const request = ctx as object;
			if (this.#places.get(request) === this.#opened && (error as { expose?: boolean }).expose) {
				this.#registered -= 1;
			}
			this.#places.delete(request);
		});
		return provider;
	}

	// Opens the window each time the dcr-window command drops its file (M0.20 step 3). A file left
	// from before the AS started opens nothing.
	watch(file: string = switchFile(), everyMs = 1_000): Disposable {
		fs.rmSync(file, { force: true });
		const timer = setInterval(() => {
			try {
				fs.rmSync(file);
			} catch {
				return;
			}
			this.open();
		}, everyMs);
		timer.unref();
		return { [Symbol.dispose]: () => clearInterval(timer) };
	}
}

// The dcr-window command: drops the file, then reports whether a running AS took it in time.
export async function requestWindow(file: string = switchFile(), waitMs = 5_000): Promise<boolean> {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "");
	const until = Date.now() + waitMs;
	while (Date.now() < until && fs.existsSync(file)) await sleep(100);
	try {
		fs.rmSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	return false;
}

if (import.meta.main) {
	const taken = await requestWindow();
	console.log(
		taken
			? `dcr-window: registration is open for ${WINDOW_MS / 60_000} minutes or ${MAX_REGISTRATIONS} registrations`
			: "dcr-window: no running AS took the request within 5 s, so nothing opened",
	);
	process.exitCode = taken ? 0 : 1;
}
