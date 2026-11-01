import { createRequire } from "node:module";
import process from "node:process";

interface NativeEntry {
	readonly object: object;
	readonly property: string;
	readonly replacement: unknown;
}
interface NativeLoopbackGuard {
	readonly denialCode: number;
	readonly nativeEntries: readonly NativeEntry[];
	assertActive(): void;
	loopbackAddress(address: unknown): boolean;
	restrictConnect(original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
}
const ownValue = (object: object, key: PropertyKey): unknown => {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const binding = (
	process as unknown as { binding(name: string): Record<PropertyKey, unknown> }
).binding.bind(process);

/** Verify the immutable native startup anchor independently of the mutable module cache. */
export function requireLoopbackNetworkGuard(): NativeLoopbackGuard {
	if (process.env.NODE_ENV !== "test" || process.env.VITEST !== "true")
		throw new Error("Test network profile required");
	const tcp = binding("tcp_wrap"),
		cares = binding("cares_wrap");
	const markerDescriptor = Object.getOwnPropertyDescriptor(
		tcp,
		Symbol.for("draftyak.test.loopback-network"),
	);
	const marker =
		markerDescriptor && "value" in markerDescriptor ? markerDescriptor.value : undefined;
	if (
		!marker ||
		!Object.isFrozen(marker) ||
		markerDescriptor?.configurable !== false ||
		markerDescriptor?.writable !== false
	)
		throw new Error("Authentic startup network guard is required");
	const require = createRequire(import.meta.url);
	const cached = ownValue(require.cache, require.resolve("./loopback-preload.cjs"));
	const guard = ownValue(marker, "guard") as NativeLoopbackGuard | undefined;
	if (
		!cached ||
		cached !== ownValue(marker, "module") ||
		!guard ||
		!Object.isFrozen(guard) ||
		ownValue(cached as object, "exports") !== guard
	)
		throw new Error("Authentic startup network guard cache is required");
	const entries = ownValue(guard, "nativeEntries") as readonly NativeEntry[] | undefined;
	const tcpPrototype = (tcp.TCP as { prototype: object }).prototype;
	const caresPrototype = (cares.ChannelWrap as { prototype: object }).prototype;
	const expected: Array<readonly [object, string]> = [
		[tcpPrototype, "connect"],
		[tcpPrototype, "connect6"],
		[cares, "getaddrinfo"],
		[cares, "getnameinfo"],
		...Object.getOwnPropertyNames(caresPrototype)
			.filter((key) => key.startsWith("query") || key === "getHostByAddr")
			.map((key) => [caresPrototype, key] as const),
	];
	if (
		!Array.isArray(entries) ||
		!Object.isFrozen(entries) ||
		entries.length !== 18 ||
		expected.length !== 18 ||
		!expected.every(([object, property]) =>
			entries.some(
				(entry) =>
					Object.isFrozen(entry) &&
					ownValue(entry, "object") === object &&
					ownValue(entry, "property") === property &&
					typeof ownValue(entry, "replacement") === "function" &&
					ownValue(object, property) === ownValue(entry, "replacement"),
			),
		)
	)
		throw new Error("Test network native guard is not installed");
	if (
		ownValue(guard, "denialCode") !== binding("uv").UV_EACCES ||
		typeof ownValue(guard, "assertActive") !== "function"
	)
		throw new Error("Test native denial protocol changed");
	guard.assertActive();
	return guard;
}
