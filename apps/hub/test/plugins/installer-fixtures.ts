import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { PackageLock } from "../../src/artifacts/index.ts";
import {
	type BundledPluginId,
	type BundledPluginPin,
	openPluginInstaller,
	type PluginInstaller,
} from "../../src/plugins/installer/index.ts";
import { makePinnedPackage, packageEntries, type TarEntry } from "../artifacts/fixtures.ts";

const temporaryRoot = realpathSync.native(os.tmpdir());
const PREFIX = "draftyak-installer-";

export const EXECUTED: unique symbol = Symbol.for("draftyak.test.installer.executed");
export const helperBody = "export const marker = 'DYTEST helper';\n";
export const entryBody =
	"globalThis[Symbol.for('draftyak.test.installer.executed')] = true;\nexport const marker = 'DYTEST';\n";

export function manifest(id: string = "channel-gmail", version = "1.0.0"): Record<string, unknown> {
	const channel = id.startsWith("channel-");
	const gmail = id === "channel-gmail";
	const profiles: Record<string, string> = {
		"channel-gmail": "gmail-v1",
		"channel-slack": "slack-v1",
		"ai-messages-api": "messages-api-v1",
		"ai-responses-api": "responses-api-v1",
		"ai-chat-completions": "chat-completions-v1",
	};
	return {
		id,
		version,
		kind: channel ? "channel" : "ai-provider",
		contract: {
			extension: channel ? "io.github.draftyak/channel" : "io.github.draftyak/ai-provider",
			version: 1,
		},
		sdk: "1.0.0",
		runtime: "node",
		isolation: "standard",
		auth: { kind: channel ? "token-paste" : "api-key", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		permissions: {},
		dataClasses: [channel ? (gmail ? "gmail.content" : "slack.content") : "draft.content"],
		license: "Apache-2.0",
		egress: { profile: profiles[id] },
		...(channel ? { send: { render: gmail ? "gmail-rfc5322" : "slack-postmessage" } } : {}),
	};
}

export interface Bundle {
	readonly id: BundledPluginId;
	readonly archive: Buffer;
	readonly lock: PackageLock;
	readonly manifest: Record<string, unknown>;
}

export function bundle(
	id: BundledPluginId = "channel-gmail",
	options: {
		readonly manifest?: Record<string, unknown>;
		readonly manifestText?: string;
		readonly version?: string;
		readonly entry?: string;
		readonly metadata?: Record<string, unknown>;
		readonly extras?: readonly TarEntry[];
		readonly missingManifest?: boolean;
	} = {},
): Bundle {
	const version = options.version ?? "1.0.0";
	const entryName = options.entry ?? "index.mjs";
	const declaration = options.manifest ?? manifest(id, version);
	const name = `@draftyak/${id}`;
	const entries = packageEntries({ name, version, type: "module", ...options.metadata }, [
		...(options.missingManifest
			? []
			: [
					{
						name: "package/draftyak.plugin.json",
						body: options.manifestText ?? JSON.stringify(declaration),
					},
				]),
		{ name: "package/lib/helper.mjs", body: helperBody },
		{ name: "package/empty", body: "" },
		...(options.extras ?? []),
	]);
	const entry = entries.find((entry) => entry.name === "package/index.mjs");
	if (!entry) throw new Error("DYTEST missing entry");
	entry.name = `package/${entryName}`;
	entry.body = entryBody;
	return {
		id,
		...makePinnedPackage(entries, { name, version, entry: entryName }),
		manifest: declaration,
	};
}

/** The pin's final folder name: `<id>-<sha512 hex>`. */
export function finalName(item: Bundle): string {
	return `${item.id}-${Buffer.from(item.lock.integrity.slice(7), "base64").toString("hex")}`;
}

export interface Fixture {
	readonly dir: string;
	readonly root: string;
	readonly installers: PluginInstaller[];
	options(bundles: readonly Bundle[]): { directory: string; bundles: BundledPluginPin[] };
	open(bundles: readonly Bundle[]): Promise<PluginInstaller>;
}

const fixtures: { readonly fixture: Fixture; readonly ino: number; readonly dev: number }[] = [];

/** A fresh plugin root under the OS temporary folder; removeFixtures() deletes it after the test. */
export function fixture(): Fixture {
	const dir = realpathSync.native(mkdtempSync(path.join(temporaryRoot, PREFIX)));
	const root = path.join(dir, "plugins");
	mkdirSync(root, { mode: 0o700 });
	const installers: PluginInstaller[] = [];
	const f: Fixture = {
		dir,
		root,
		installers,
		options(bundles) {
			return { directory: root, bundles: bundles.map(({ id, lock }) => ({ id, package: lock })) };
		},
		async open(bundles) {
			const installer = await openPluginInstaller(f.options(bundles));
			installers.push(installer);
			return installer;
		},
	};
	const birth = lstatSync(dir);
	fixtures.push({ fixture: f, ino: birth.ino, dev: birth.dev });
	return f;
}

function writable(name: string): void {
	const stat = lstatSync(name);
	if (stat.isSymbolicLink()) return;
	chmodSync(name, stat.isDirectory() ? 0o700 : 0o600);
	if (stat.isDirectory()) for (const child of readdirSync(name)) writable(path.join(name, child));
}

/** Closes each installer, then removes only the fixture folders created here and checks none is left. */
export async function removeFixtures(): Promise<void> {
	for (const { fixture: f, ino, dev } of fixtures.splice(0)) {
		for (const installer of f.installers) await installer.close();
		const current = lstatSync(f.dir);
		if (
			path.dirname(f.dir) !== temporaryRoot ||
			!path.basename(f.dir).startsWith(PREFIX) ||
			current.ino !== ino ||
			current.dev !== dev
		)
			throw new Error("Unowned installer fixture directory");
		writable(f.dir);
		rmSync(f.dir, { recursive: true, force: true });
		expect(existsSync(f.dir)).toBe(false);
	}
}
