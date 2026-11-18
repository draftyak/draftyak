type Awaitable<Value> = Value | PromiseLike<Value>;

export type BeforeRemoveHandler<Instance = unknown> = (
	instance: Instance,
) => Awaitable<string | undefined>;

export type InstanceHostsProvider<Instance = unknown> = (
	instance: Instance,
) => Awaitable<readonly string[]>;

export interface LifecycleFailure {
	readonly kind: string | null;
	readonly code: "callback-rejected" | "invalid-result" | "registrations-changed";
}

/** Callback failures carry no original exception or provider response. */
export class InstanceLifecycleError extends Error {
	readonly failures: readonly LifecycleFailure[];
	readonly notices: readonly string[];

	constructor(failures: readonly LifecycleFailure[], notices: readonly string[] = []) {
		super("Instance lifecycle hooks failed");
		this.name = "InstanceLifecycleError";
		this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
		this.notices = Object.freeze([...notices]);
		Object.freeze(this);
	}
}

export interface InstanceDestinationData {
	readonly pluginEgress: readonly string[];
	readonly instanceHosts: readonly string[];
}

export interface InstanceLifecycleRegistry<Instance = unknown> {
	readonly registerBeforeRemove: (
		kind: string,
		handler: BeforeRemoveHandler<Instance>,
	) => () => void;
	readonly registerInstanceHosts: (
		kind: string,
		hostsFor: InstanceHostsProvider<Instance>,
	) => () => void;
	readonly beforeRemove: (instance: Instance) => Promise<readonly string[]>;
	readonly destinationData: (
		instance: Instance,
		pluginEgress: readonly string[],
	) => Promise<InstanceDestinationData>;
}

interface Registration<Instance, Value> {
	readonly kind: string;
	readonly callback: (instance: Instance) => Awaitable<Value>;
}

interface NoticeOutcome {
	readonly notice?: string;
	readonly failure?: LifecycleFailure;
}

interface HostsOutcome {
	readonly hosts?: readonly string[];
	readonly failure?: LifecycleFailure;
}

function register<Instance, Value>(
	registrations: Set<Registration<Instance, Value>>,
	kind: string,
	callback: (instance: Instance) => Awaitable<Value>,
	changed: () => void,
): () => void {
	if (typeof kind !== "string" || kind.length === 0) {
		throw new TypeError("Credential kind must be a nonempty string");
	}
	if (typeof callback !== "function") {
		throw new TypeError("Lifecycle callback must be a function");
	}
	const registration = { kind, callback };
	registrations.add(registration);
	changed();
	return () => {
		if (registrations.delete(registration)) changed();
	};
}

function copyHosts(value: unknown): readonly string[] | undefined {
	try {
		if (!Array.isArray(value)) return undefined;
		const length = value.length;
		if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) return undefined;
		const hosts: string[] = [];
		for (let index = 0; index < length; index += 1) {
			if (!Object.hasOwn(value, index)) return undefined;
			const host: unknown = value[index];
			if (typeof host !== "string" || host.length === 0) return undefined;
			hosts.push(host);
		}
		return Object.freeze(hosts);
	} catch {
		return undefined;
	}
}

async function settleNotice<Instance>(
	{ kind, callback }: Registration<Instance, string | undefined>,
	instance: Instance,
): Promise<NoticeOutcome> {
	try {
		const notice = await callback(instance);
		if (notice === undefined) return {};
		if (typeof notice === "string" && notice.length > 0) return { notice };
		return { failure: { kind, code: "invalid-result" } };
	} catch {
		return { failure: { kind, code: "callback-rejected" } };
	}
}

async function settleHosts<Instance>(
	{ kind, callback }: Registration<Instance, readonly string[]>,
	instance: Instance,
): Promise<HostsOutcome> {
	try {
		const returned = callback(instance);
		let directArray: boolean;
		try {
			directArray = Array.isArray(returned);
		} catch {
			return { failure: { kind, code: "invalid-result" } };
		}
		// Copy direct results before invoking a later provider; async results are
		// copied on settlement, independently of any other pending providers.
		const hosts = copyHosts(directArray ? returned : await returned);
		return hosts === undefined ? { failure: { kind, code: "invalid-result" } } : { hosts };
	} catch {
		return { failure: { kind, code: "callback-rejected" } };
	}
}

/**
 * An internal callback scope. Instances are forwarded unchanged, never created,
 * authenticated, frozen or interpreted here. Completion is not removal authority;
 * callers retain their native authorization, currentness and lifetime checks.
 */
export function createInstanceLifecycleRegistry<
	Instance = unknown,
>(): InstanceLifecycleRegistry<Instance> {
	const beforeHandlers = new Set<Registration<Instance, string | undefined>>();
	const hostProviders = new Set<Registration<Instance, readonly string[]>>();
	let beforeVersion = {};
	let hostsVersion = {};

	const registerBeforeRemove = (kind: string, handler: BeforeRemoveHandler<Instance>) =>
		register(beforeHandlers, kind, handler, () => {
			beforeVersion = {};
		});

	const registerInstanceHosts = (kind: string, hostsFor: InstanceHostsProvider<Instance>) =>
		register(hostProviders, kind, hostsFor, () => {
			hostsVersion = {};
		});

	const beforeRemove = async (instance: Instance): Promise<readonly string[]> => {
		const version = beforeVersion;
		const snapshot = [...beforeHandlers];
		// Each job settles its own exception; one failure cannot shorten the barrier.
		const outcomes = await Promise.all(snapshot.map((entry) => settleNotice(entry, instance)));
		const notices: string[] = [];
		const failures: LifecycleFailure[] = [];
		for (const outcome of outcomes) {
			if (outcome.notice !== undefined) notices.push(outcome.notice);
			if (outcome.failure !== undefined) failures.push(outcome.failure);
		}
		if (version !== beforeVersion) {
			failures.push({ kind: null, code: "registrations-changed" });
		}
		if (failures.length > 0) throw new InstanceLifecycleError(failures, notices);
		return Object.freeze(notices);
	};

	const destinationData = async (
		instance: Instance,
		pluginEgress: readonly string[],
	): Promise<InstanceDestinationData> => {
		const pluginHosts = copyHosts(pluginEgress);
		if (pluginHosts === undefined) {
			throw new TypeError("Plugin egress hosts must be nonempty strings");
		}
		const version = hostsVersion;
		const snapshot = [...hostProviders];
		const outcomes = await Promise.all(snapshot.map((entry) => settleHosts(entry, instance)));
		const instanceHosts: string[] = [];
		const failures: LifecycleFailure[] = [];
		for (const outcome of outcomes) {
			if (outcome.hosts !== undefined) {
				for (const host of outcome.hosts) instanceHosts.push(host);
			}
			if (outcome.failure !== undefined) failures.push(outcome.failure);
		}
		if (version !== hostsVersion) {
			failures.push({ kind: null, code: "registrations-changed" });
		}
		if (failures.length > 0) throw new InstanceLifecycleError(failures);
		// These are destination data, not an accepted projection or network grant.
		return Object.freeze({
			pluginEgress: pluginHosts,
			instanceHosts: Object.freeze(instanceHosts),
		});
	};

	return Object.freeze({
		registerBeforeRemove,
		registerInstanceHosts,
		beforeRemove,
		destinationData,
	});
}

// All module-level operations share this scope and consistently accept unknown data.
const registry = createInstanceLifecycleRegistry();
export const registerBeforeRemove: InstanceLifecycleRegistry<unknown>["registerBeforeRemove"] =
	registry.registerBeforeRemove;
export const registerInstanceHosts: InstanceLifecycleRegistry<unknown>["registerInstanceHosts"] =
	registry.registerInstanceHosts;
export const beforeRemove: InstanceLifecycleRegistry<unknown>["beforeRemove"] =
	registry.beforeRemove;
export const destinationData: InstanceLifecycleRegistry<unknown>["destinationData"] =
	registry.destinationData;
