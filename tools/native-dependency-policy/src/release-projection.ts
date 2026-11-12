import { types } from "node:util";
import type { ReleaseBasis, ReleaseDependency, ReleaseVersion } from "./current-basis.ts";
import { BOUNDED_TUPLES } from "./decision.ts";

const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const MAX_ROWS = 100_000;
const MAX_STRING_BYTES = 65_536;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_NODES = 1_000_000;

/** A closed technical view, not a raw registry response or authenticated source receipt. */
export interface TechnicalReleaseVersion extends ReleaseVersion {
	readonly publishedAt: string;
}
export interface TechnicalReleaseCrate {
	readonly source: typeof SOURCE;
	readonly name: string;
	readonly versions: readonly TechnicalReleaseVersion[];
}
export interface ReleaseProjectionInput {
	readonly api: readonly TechnicalReleaseCrate[];
	readonly index: readonly TechnicalReleaseCrate[];
}
export class ReleaseProjectionError extends Error {
	readonly code = "RELEASE_PROJECTION_INVALID";
	constructor() {
		super("release projection refused");
		this.name = "ReleaseProjectionError";
	}
}
function refuse(): never {
	throw new ReleaseProjectionError();
}
class Budget {
	private nodes = 0;
	private bytes = 0;
	touch(): void {
		if (++this.nodes > MAX_NODES) refuse();
	}
	text(value: string): void {
		const bytes = Buffer.byteLength(value);
		if (bytes > MAX_STRING_BYTES) refuse();
		this.bytes += bytes;
		if (this.bytes > MAX_TOTAL_BYTES) refuse();
	}
}
type Data = Record<string, unknown>;
function object(value: unknown, keys: readonly string[], budget: Budget): Data {
	budget.touch();
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		Array.isArray(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		refuse();
	const own = Reflect.ownKeys(value);
	if (
		own.length !== keys.length ||
		own.some((key) => typeof key !== "string" || !keys.includes(key))
	)
		refuse();
	const result: Data = Object.create(null);
	for (const key of keys) {
		budget.text(key);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) refuse();
		result[key] = descriptor.value;
	}
	return result;
}
function list(value: unknown, budget: Budget): unknown[] {
	budget.touch();
	if (
		!Array.isArray(value) ||
		types.isProxy(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		refuse();
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length > MAX_ROWS) refuse();
	if (Reflect.ownKeys(value).length !== length + 1) refuse();
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor)) refuse();
		result.push(descriptor.value);
	}
	return result;
}
function scalar(value: unknown, budget: Budget): string {
	budget.touch();
	if (typeof value !== "string") refuse();
	budget.text(value);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (!(next >= 0xdc00 && next <= 0xdfff)) refuse();
		} else if (code >= 0xdc00 && code <= 0xdfff) refuse();
	}
	return value;
}
function checked(value: unknown, pattern: RegExp, budget: Budget): string {
	const text = scalar(value, budget);
	if (!pattern.test(text)) refuse();
	return text;
}
const name = (value: unknown, budget: Budget): string =>
	checked(value, /^[A-Za-z0-9][A-Za-z0-9_-]*$(?![\s\S])/, budget);
const token = (value: unknown, budget: Budget): string =>
	checked(value, /^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$(?![\s\S])/, budget);
const version = (value: unknown, budget: Budget): string =>
	checked(
		value,
		/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$(?![\s\S])/,
		budget,
	);
function integer(value: unknown, budget: Budget): number {
	budget.touch();
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse();
	return value;
}
function boolean(value: unknown, budget: Budget): boolean {
	budget.touch();
	if (typeof value !== "boolean") refuse();
	return value;
}
function nullable(
	value: unknown,
	budget: Budget,
	read: (value: unknown, budget: Budget) => string = scalar,
): string | null {
	if (value !== null) return read(value, budget);
	budget.touch();
	return null;
}
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
function uniqueRows<T>(values: T[], identity: (value: T) => string): T[] {
	const rows = values.map((value) => ({ key: identity(value), value }));
	if (new Set(rows.map(({ key }) => key)).size !== rows.length) refuse();
	return rows.sort((a, b) => compare(a.key, b.key)).map(({ value }) => value);
}
function features(value: unknown, budget: Budget): string[] {
	return uniqueRows(
		list(value, budget).map((item) => token(item, budget)),
		(item) => item,
	);
}
function requirement(value: unknown, budget: Budget): string {
	const text = scalar(value, budget);
	const part =
		"(?:[<>=~^]=? *)?(?:\\*|[0-9]+(?:\\.(?:[0-9]+|[xX*])){0,2}(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)";
	if (!new RegExp(`^${part}(?: *, *${part})*$(?![\\s\\S])`).test(text)) refuse();
	return text;
}
function registry(value: unknown, budget: Budget): string {
	const text = checked(
		value,
		/^(?:(?:registry|sparse)\+)?https:\/\/[A-Za-z0-9:/._~%+?&=@#-]+$(?![\s\S])/,
		budget,
	);
	const url = new URL(text.replace(/^(?:registry|sparse)\+/, ""));
	if (url.username || url.password) refuse();
	return text;
}
function dependency(value: unknown, budget: Budget): ReleaseDependency {
	const row = object(
		value,
		[
			"name",
			"requirement",
			"kind",
			"target",
			"optional",
			"defaultFeatures",
			"features",
			"registry",
			"rename",
		],
		budget,
	);
	const kind = scalar(row.kind, budget);
	if (kind !== "normal" && kind !== "build" && kind !== "dev") refuse();
	return Object.freeze({
		name: name(row.name, budget),
		requirement: requirement(row.requirement, budget),
		kind,
		target: nullable(row.target, budget),
		optional: boolean(row.optional, budget),
		defaultFeatures: boolean(row.defaultFeatures, budget),
		features: Object.freeze(features(row.features, budget)),
		registry: nullable(row.registry, budget, registry),
		rename: nullable(row.rename, budget, name),
	});
}
/** Check representable RFC3339 data without Date.parse normalization or fractional truncation. */
function publication(value: unknown, epoch: number, budget: Budget): string {
	const text = scalar(value, budget);
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$(?![\s\S])/.exec(
			text,
		);
	if (!match) refuse();
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] =
		match;
	const year = Number(yearText),
		month = Number(monthText),
		day = Number(dayText);
	const hour = Number(hourText),
		minute = Number(minuteText),
		second = Number(secondText);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		/[1-9]/.test(fraction.slice(3))
	)
		refuse();
	const millisecond = Number(fraction.slice(0, 3).padEnd(3, "0"));
	const calendar = new Date(0);
	calendar.setUTCFullYear(year, month - 1, day);
	calendar.setUTCHours(hour, minute, second, millisecond);
	if (
		calendar.getUTCFullYear() !== year ||
		calendar.getUTCMonth() !== month - 1 ||
		calendar.getUTCDate() !== day
	)
		refuse();
	let offset = 0;
	if (zone !== "Z") {
		if (!zone || zone === "-00:00") refuse();
		const hours = Number(zone.slice(1, 3)),
			minutes = Number(zone.slice(4, 6));
		if (hours > 23 || minutes > 59) refuse();
		offset = (hours * 60 + minutes) * 60_000 * (zone[0] === "+" ? 1 : -1);
	}
	if (calendar.getTime() - offset !== epoch) refuse();
	return text;
}
function release(value: unknown, budget: Budget): TechnicalReleaseVersion {
	const row = object(
		value,
		["version", "createdAt", "publishedAt", "yanked", "checksum", "license", "dependencies"],
		budget,
	);
	const createdAt = integer(row.createdAt, budget);
	const license = nullable(row.license, budget, (item, limit) =>
		checked(item, /^[A-Za-z0-9.+() -]+$(?![\s\S])/, limit),
	);
	return Object.freeze({
		version: version(row.version, budget),
		createdAt,
		publishedAt: publication(row.publishedAt, createdAt, budget),
		yanked: boolean(row.yanked, budget),
		checksum: checked(row.checksum, /^[a-f0-9]{64}$(?![\s\S])/, budget),
		license,
		dependencies: Object.freeze(
			uniqueRows(
				list(row.dependencies, budget).map((item) => dependency(item, budget)),
				JSON.stringify,
			),
		),
	});
}
function crates(value: unknown, budget: Budget): TechnicalReleaseCrate[] {
	const rows = list(value, budget);
	if (rows.length !== BOUNDED_TUPLES.length) refuse();
	return uniqueRows(
		rows.map((value) => {
			const row = object(value, ["source", "name", "versions"], budget);
			if (scalar(row.source, budget) !== SOURCE) refuse();
			const crateName = name(row.name, budget);
			const expected = BOUNDED_TUPLES.find(([name]) => name === crateName);
			if (!expected) refuse();
			const versions = uniqueRows(
				list(row.versions, budget).map((item) => release(item, budget)),
				(item) => item.version,
			);
			if (!versions.some((item) => item.version === expected[1])) refuse();
			return Object.freeze({ source: SOURCE, name: crateName, versions: Object.freeze(versions) });
		}),
		(row) => row.name,
	);
}

/**
 * Join two closed technical views, preserving literal strings and every supplied version.
 * No raw upstream field mapping, origin/currentness, coverage or authority is established here.
 * A trusted producer owns real observation/revision facts and the existing future-time check.
 */
export function projectReleaseCrates(input: unknown): ReleaseBasis["crates"] {
	try {
		const budget = new Budget();
		const pair = object(input, ["api", "index"], budget);
		const api = crates(pair.api, budget),
			index = crates(pair.index, budget);
		if (JSON.stringify(api) !== JSON.stringify(index)) refuse();
		return Object.freeze(
			api.map((crate) =>
				Object.freeze({
					source: SOURCE,
					name: crate.name,
					versions: Object.freeze(
						crate.versions.map(({ publishedAt: _publication, ...version }) =>
							Object.freeze(version),
						),
					),
				}),
			),
		);
	} catch (error) {
		if (error instanceof ReleaseProjectionError) throw error;
		throw new ReleaseProjectionError();
	}
}
