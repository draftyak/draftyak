import path from "node:path";
import { CLI_PAYLOAD } from "@draftyak/cli/payload-contract";
import { jsonValue, object, regularBytes, text } from "./inventory.ts";

interface NodePin {
	readonly version: string;
	readonly parts: readonly [number, number, number];
}

export function assertCliModuleBoundary(bytes: Buffer): void {
	if (bytes.length > 65_536) throw new Error("CLI module boundary exceeds its byte limit");
	const source = bytes.toString("utf8");
	if (!Buffer.from(source, "utf8").equals(bytes))
		throw new Error("CLI module boundary must be UTF-8");
	const boundary = object(jsonValue(source), ["type"], "CLI module boundary");
	if (boundary.type !== "module") throw new Error("CLI module boundary must declare type module");
}

function nodePolicy(): { readonly minimum: NodePin; readonly bundled: NodePin } {
	const versions = object(
		jsonValue(
			regularBytes(
				path.resolve(import.meta.dirname, "../../fetch-node/versions.json"),
				4096,
			).toString("utf8"),
		),
		["minimum", "bundled"],
		"repository Node versions",
	);
	const pin = (value: unknown): NodePin => {
		const version = text(value, "repository Node version");
		const components = version.split(".");
		const parts = [Number(components[0]), Number(components[1]), Number(components[2])] as const;
		if (
			!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) ||
			parts.some((part) => !Number.isSafeInteger(part))
		)
			throw new Error("repository Node versions must be exact stable versions");
		return { version, parts };
	};
	const minimum = pin(versions.minimum);
	const bundled = pin(versions.bundled);
	if (minimum.parts[0] !== 26 || bundled.parts[0] !== 26)
		throw new Error("repository Node versions require the supported Node 26 target");
	if (
		minimum.parts[1] > bundled.parts[1] ||
		(minimum.parts[1] === bundled.parts[1] && minimum.parts[2] > bundled.parts[2])
	)
		throw new Error("repository minimum Node version exceeds the bundled version");
	return { minimum, bundled };
}

/** Render only this tool's checked-in template and Node policy; returned bytes are data. */
export function canonicalLauncher(): {
	readonly bytes: Buffer;
	readonly policy: { readonly minimum: string; readonly bundled: string };
} {
	const policy = nodePolicy();
	const original = regularBytes(
		path.resolve(import.meta.dirname, "../../packaging/templates/draftyak.mjs"),
		65_536,
	);
	const template = original.toString("utf8");
	if (!Buffer.from(template, "utf8").equals(original))
		throw new Error("canonical launcher template must be UTF-8");
	const marker = '"__DRAFTYAK_NODE_MINIMUM__"';
	const at = template.indexOf(marker);
	if (at < 0 || at !== template.lastIndexOf(marker))
		throw new Error("canonical launcher template must contain exactly one Node policy marker");
	const withPolicy =
		template.slice(0, at) +
		JSON.stringify(policy.minimum.parts) +
		template.slice(at + marker.length);
	const payloadMarker = '"__DRAFTYAK_CLI_PAYLOAD__"';
	const payloadAt = withPolicy.indexOf(payloadMarker);
	if (payloadAt < 0 || payloadAt !== withPolicy.lastIndexOf(payloadMarker))
		throw new Error("canonical launcher template must contain exactly one CLI payload marker");
	const rendered =
		withPolicy.slice(0, payloadAt) +
		JSON.stringify(CLI_PAYLOAD) +
		withPolicy.slice(payloadAt + payloadMarker.length);
	return {
		bytes: Buffer.from(rendered, "utf8"),
		policy: Object.freeze({ minimum: policy.minimum.version, bundled: policy.bundled.version }),
	};
}
