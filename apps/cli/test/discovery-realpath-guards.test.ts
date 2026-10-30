import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { PayloadCatalog } from "../src/catalog.ts";

interface Node {
	readonly kind: "dir" | "file";
	readonly entries?: readonly string[];
	readonly resolved?: string;
	readonly symbolic?: boolean;
	readonly rawEntries?: readonly Buffer[];
	readonly exactBuffer?: Buffer;
}

const state = vi.hoisted(() => ({
	root: "",
	nodes: new Map<string, Node>(),
	catalog: undefined as PayloadCatalog | undefined,
	error: "",
	calls: [] as string[],
}));

vi.mock("node:path", async (original) => {
	const actual = await original<typeof import("node:path")>();
	return { ...actual, default: actual.win32 };
});

vi.mock("node:url", async (original) => {
	const actual = await original<typeof import("node:url")>();
	return {
		...actual,
		fileURLToPath(value: string | URL) {
			const url = String(value);
			if (url.endsWith("/src/")) return `${state.root}\\`;
			if (url.endsWith("/src/layout.ts")) return `${state.root}\\layout.ts`;
			return actual.fileURLToPath(value);
		},
		pathToFileURL(filename: string) {
			return new URL(`file:///${filename.replace(/\\/g, "/")}`);
		},
	};
});

vi.mock("node:fs", () => {
	function node(filename: string | Buffer, operation: string): Node {
		state.calls.push(operation);
		if (state.error === operation) throw new Error("DYTEST private filesystem diagnostic");
		const found = state.nodes.get(String(filename));
		if (!found) throw new Error("DYTEST missing fixture node");
		if (found.exactBuffer && (!Buffer.isBuffer(filename) || !filename.equals(found.exactBuffer)))
			throw new Error("DYTEST different fixture bytes");
		return found;
	}
	return {
		lstatSync(filename: string | Buffer) {
			const found = node(filename, "lstat");
			return {
				isDirectory: () => found.kind === "dir",
				isFile: () => found.kind === "file",
				isSymbolicLink: () => found.symbolic === true,
				size: 1,
			};
		},
		readdirSync(filename: string, options?: { readonly encoding?: string }) {
			const parent = node(filename, "readdir");
			const entries = parent.rawEntries ?? (parent.entries ?? []).map((name) => Buffer.from(name));
			return options?.encoding === "buffer" ? entries : entries.map((entry) => entry.toString());
		},
		readFileSync(filename: string) {
			node(filename, "read");
			return "DYTEST";
		},
		realpathSync: Object.assign((filename: string) => filename, {
			native(filename: string | Buffer) {
				return node(filename, "realpath").resolved ?? String(filename);
			},
		}),
	};
});

vi.mock("../src/catalog.ts", () => ({
	get installedCatalog() {
		return state.catalog;
	},
}));

beforeEach(() => {
	vi.resetModules();
	state.nodes.clear();
	state.error = "";
	state.catalog = undefined;
	state.calls = [];
});

function configure(installed: boolean, root = "C:\\DYTEST\\payload"): void {
	state.root = root;
	const nodes: Readonly<Record<string, Node>> = {
		"": { kind: "dir", entries: ["commands", "doctor", "layout.ts"] },
		commands: { kind: "dir", entries: ["probe.ts"] },
		doctor: { kind: "dir", entries: ["checks"] },
		"doctor/checks": { kind: "dir", entries: ["alpha.ts"] },
		"commands/probe.ts": { kind: "file" },
		"doctor/checks/alpha.ts": { kind: "file" },
		"layout.ts": { kind: "file" },
	};
	for (const [relative, node] of Object.entries(nodes))
		state.nodes.set(path.join(root, relative), node);
	for (let child = root; ; ) {
		const parent = path.dirname(child);
		if (parent === child) break;
		state.nodes.set(parent, { kind: "dir", entries: [path.basename(child)] });
		child = parent;
	}
	if (installed)
		state.catalog = {
			files: Object.entries(nodes)
				.filter(([, node]) => node.kind === "file")
				.map(([file]) => ({ path: file, sha256: null })),
			directories: ["commands", "doctor", "doctor/checks"],
			commands: ["commands/probe.ts"],
			checks: ["doctor/checks/alpha.ts"],
		};
}

// A refusal becomes a value, so an accepting case fails on its assertion rather than by throwing.
function outcome(call: () => unknown): unknown {
	try {
		return call();
	} catch (error) {
		return error instanceof Error ? error.message : error;
	}
}

const networkRoots = [
	{ spelling: "UNC", root: "\\\\127.0.0.1\\DYTEST\\payload" },
	{ spelling: "forward-slash UNC", root: "//127.0.0.1/DYTEST/payload" },
	{ spelling: "long-path UNC", root: "\\\\?\\UNC\\127.0.0.1\\DYTEST\\payload" },
	{ spelling: "device-namespace UNC", root: "\\\\.\\UNC\\127.0.0.1\\DYTEST\\payload" },
	{
		spelling: "network device",
		root: "\\\\?\\GLOBALROOT\\Device\\Mup\\127.0.0.1\\DYTEST\\payload",
	},
] as const;

it.for([false, true].flatMap((installed) => networkRoots.map((root) => ({ ...root, installed }))))(
	"refuses a $spelling payload root before any filesystem lookup with installed=$installed",
	async ({ root, installed }) => {
		configure(installed, root);
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleFiles("checks")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
		if (installed) expect(() => layout.verifyInstalled()).toThrow("Command refused.");
		expect(state.calls).toEqual([]);
	},
);

it.for([false, true])(
	"refuses a mapped network drive before listing or reading anything with installed=%s",
	async (installed) => {
		configure(installed, "Z:\\payload");
		const share = "\\\\127.0.0.1\\DYTEST";
		for (const [filename, node] of [...state.nodes])
			state.nodes.set(filename, {
				...node,
				resolved: filename === "Z:\\" ? share : share + filename.slice(2),
			});
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleFiles("checks")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
		if (installed) expect(() => layout.verifyInstalled()).toThrow("Command refused.");
		expect(new Set(state.calls)).toEqual(new Set(["realpath"]));
	},
);

it.for([false, true])(
	"only the directory native guard refuses an empty linked folder with installed=%s",
	async (installed) => {
		configure(installed);
		const relative = installed ? "doctor/checks" : "commands";
		const folder = path.join(state.root, relative);
		state.nodes.set(folder, { kind: "dir", entries: installed ? [] : [".gitkeep"] });
		if (state.catalog)
			state.catalog = {
				...state.catalog,
				files: state.catalog.files.filter((file) => !file.path.startsWith("doctor/checks/")),
				checks: [],
			};
		const layout = await import("../src/layout.ts");
		const registry = installed ? "checks" : "commands";
		expect(outcome(() => layout.moduleFiles(registry))).toEqual([]);
		state.nodes.set(folder, {
			...state.nodes.get(folder),
			kind: "dir",
			resolved: "C:\\DYTEST\\outside",
		});
		expect(() => layout.moduleFiles(registry)).toThrow("Command refused.");
	},
);

it.for(
	[false, true].flatMap((installed) =>
		(["directory", "symbolic"] as const).map((flag) => ({ installed, flag })),
	),
)("checks the canonical root $flag flag with installed=$installed", async ({ installed, flag }) => {
	configure(installed);
	const canonical = state.root;
	state.root = "C:\\DYTEST\\LONGPA~1";
	state.nodes.set(state.root, {
		kind: flag === "directory" ? "file" : "dir",
		symbolic: flag === "symbolic",
		resolved: canonical,
	});
	const layout = await import("../src/layout.ts");
	expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
	expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
});

it.for([false, true])(
	"refuses a listed tilde-digit root rather than accepting it as an alias with installed=%s",
	async (installed) => {
		configure(installed);
		const canonical = state.root;
		state.root = "C:\\DYTEST\\cli~1";
		state.nodes.set("C:\\DYTEST", { kind: "dir", entries: ["payload", "cli~1"] });
		state.nodes.set(state.root, { kind: "dir", resolved: canonical });
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
	},
);

it.for([false, true])(
	"accepts an unlisted genuine short alias beside unrelated entries with installed=%s",
	async (installed) => {
		configure(installed);
		const canonical = state.root;
		state.root = "C:\\DYTEST\\PAYLOA~1";
		state.nodes.set("C:\\DYTEST", {
			kind: "dir",
			entries: ["payload", "other-link", "elsewhere", "unreadable"],
		});
		state.nodes.set("C:\\DYTEST\\other-link", {
			kind: "dir",
			symbolic: true,
			resolved: canonical,
		});
		state.nodes.set("C:\\DYTEST\\elsewhere", { kind: "dir", resolved: "C:\\DYTEST\\outside" });
		state.nodes.set(state.root, { kind: "dir", resolved: canonical });
		const layout = await import("../src/layout.ts");
		expect(outcome(() => layout.moduleFiles("commands"))).toEqual(["commands/probe.ts"]);
		expect(outcome(() => layout.moduleUrl("commands/probe.ts").href)).toBe(
			"file:///C:/DYTEST/PAYLOA~1/commands/probe.ts",
		);
	},
);

it.for([false, true])(
	"refuses a short alias that may name a sibling folder link with installed=%s",
	async (installed) => {
		configure(installed);
		const canonical = state.root;
		state.root = "C:\\DYTEST\\LONGPA~1";
		state.nodes.set("C:\\DYTEST", { kind: "dir", entries: ["payload", "longpayloadname"] });
		state.nodes.set("C:\\DYTEST\\longpayloadname", { kind: "dir", resolved: canonical });
		state.nodes.set(state.root, { kind: "dir", resolved: canonical });
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
	},
);

it.for([false, true])(
	"refuses an unlisted root spelling without a tilde and digit with installed=%s",
	async (installed) => {
		configure(installed);
		const canonical = state.root;
		state.root = "C:\\DYTEST\\payload.";
		state.nodes.set(state.root, { kind: "dir", resolved: canonical });
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
	},
);

it.for([false, true])(
	"refuses a root spelling that is itself a listed case variant with installed=%s",
	async (installed) => {
		configure(installed);
		const canonical = state.root;
		state.root = "C:\\DYTEST\\PAYLOAD";
		state.nodes.set("C:\\DYTEST", { kind: "dir", entries: ["payload", "PAYLOAD"] });
		state.nodes.set(state.root, { kind: "dir", resolved: canonical });
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
	},
);

it.for([false, true])(
	"accepts a root spelled in another Unicode normalization with installed=%s",
	async (installed) => {
		const name = `caf${String.fromCharCode(0xe9)}`;
		configure(installed, `C:\\DYTEST\\${name.normalize("NFD")}`);
		const canonical = state.root;
		state.root = `C:\\DYTEST\\${name}`;
		state.nodes.set(state.root, { kind: "dir", resolved: canonical });
		const layout = await import("../src/layout.ts");
		expect(outcome(() => layout.moduleFiles("commands"))).toEqual(["commands/probe.ts"]);
		expect(outcome(() => layout.moduleUrl("commands/probe.ts").href)).toBe(
			"file:///C:/DYTEST/caf%C3%A9/commands/probe.ts",
		);
	},
);

it.for(
	[false, true].flatMap((installed) =>
		["lstat", "realpath", "readdir"].map((operation) => ({ installed, operation })),
	),
)(
	"hides $operation errors at public discovery boundaries with installed=$installed",
	async ({ installed, operation }) => {
		configure(installed);
		const layout = await import("../src/layout.ts");
		state.error = operation;
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		if (operation !== "readdir")
			expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
		if (installed) expect(() => layout.verifyInstalled()).toThrow("Command refused.");
	},
);

it("hides installed-catalog read errors", async () => {
	configure(true);
	if (!state.catalog) throw new Error("Missing test catalog");
	state.catalog = {
		...state.catalog,
		files: state.catalog.files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
	};
	const layout = await import("../src/layout.ts");
	state.error = "read";
	expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
	expect(() => layout.verifyInstalled()).toThrow("Command refused.");
});

it.for([false, true])(
	"accepts a different-case root spelling with installed=%s",
	async (installed) => {
		configure(installed);
		state.root = "c:\\DYTEST\\PAYLOAD";
		state.nodes.set("c:\\", { kind: "dir", resolved: "C:\\" });
		state.nodes.set("c:\\DYTEST", { kind: "dir", resolved: "C:\\DYTEST" });
		state.nodes.set(state.root, { kind: "dir", resolved: "C:\\DYTEST\\payload" });
		const layout = await import("../src/layout.ts");
		expect(outcome(() => layout.moduleFiles("commands"))).toEqual(["commands/probe.ts"]);
		expect(outcome(() => layout.moduleFiles("checks"))).toEqual(["doctor/checks/alpha.ts"]);
		expect(outcome(() => layout.moduleUrl("commands/probe.ts").href)).toBe(
			"file:///c:/DYTEST/PAYLOAD/commands/probe.ts",
		);
	},
);

it.for([false, true])(
	"refuses a root resolved under another parent with installed=%s",
	async (installed) => {
		configure(installed);
		const original = state.root;
		const elsewhere = "D:\\DYTEST\\payload";
		for (const [filename, value] of [...state.nodes])
			if (filename === original || filename.startsWith(`${original}\\`))
				state.nodes.set(elsewhere + filename.slice(original.length), value);
		state.nodes.set("D:\\", { kind: "dir", entries: ["DYTEST"] });
		state.nodes.set("D:\\DYTEST", { kind: "dir", entries: ["payload"] });
		state.nodes.set(original, { ...state.nodes.get(original), kind: "dir", resolved: elsewhere });
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
	},
);

it.for([false, true])(
	"checks raw sibling names without decoding with installed=%s",
	async (installed) => {
		configure(installed);
		const canonical = state.root;
		const parent = path.dirname(canonical);
		const raw = Buffer.concat([Buffer.from("entry"), Buffer.from([0x80])]);
		const sibling = Buffer.concat([Buffer.from(path.join(parent, path.sep)), raw]);
		state.nodes.set(parent, { kind: "dir", rawEntries: [Buffer.from("payload"), raw] });
		state.nodes.set(String(sibling), { kind: "dir", resolved: canonical, exactBuffer: sibling });
		state.root = path.join(parent, "PAYLOA~1");
		state.nodes.set(state.root, { kind: "dir", resolved: canonical });
		const layout = await import("../src/layout.ts");
		expect(() => layout.moduleFiles("commands")).toThrow("Command refused.");
		expect(() => layout.moduleUrl("commands/probe.ts")).toThrow("Command refused.");
	},
);
