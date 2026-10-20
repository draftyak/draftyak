import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { fixture } from "./helpers.ts";

it("observes rejected native Promise results in a real child without a global rejection handler", () => {
	const source = `
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { fixture } from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)};
const f = await fixture();
try {
 for (const delayed of [false, true]) {
  for (const method of ["read", "write"]) {
   assert.throws(() => f.store[method]((db) => {
    if (method === "write") db.run("INSERT INTO test_rows VALUES('must-rollback',1)");
    const result = delayed ? Promise.resolve().then(() => { throw Error("PRIVATE_LATE_CANARY"); }) : Promise.reject(Error("PRIVATE_CANARY"));
    Object.defineProperty(result, "then", { get() { throw Error("THEN_GETTER_MUST_NOT_RUN"); } });
    return result;
   }), /callbacks must be synchronous/);
  }
 }
 await new Promise((resolve) => setImmediate(resolve));
 await new Promise((resolve) => setImmediate(resolve));
 assert.deepEqual(f.store.read((db) => db.all("SELECT * FROM main.test_rows")), []);
 process.stdout.write("native-rejections-observed\\n");
} finally { f.store.close(); f.key.destroy(); rmSync(f.dir, { recursive: true, force: true }); }
`;
	const result = spawnSync(
		process.execPath,
		["--disable-sigusr1", "--unhandled-rejections=strict", "--input-type=module", "--eval", source],
		{
			env: {},
			shell: false,
			windowsHide: true,
			timeout: 10_000,
			maxBuffer: 4096,
			encoding: "utf8",
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toBe("native-rejections-observed\n");
});

it("refuses own/inherited then accessors and proxy results without invoking hooks, and rolls back", async () => {
	const f = await fixture();
	let hooks = 0;
	const getter = {
		get() {
			hooks++;
			throw Error("PRIVATE_GETTER_CANARY");
		},
	};
	// biome-ignore lint/suspicious/noThenProperty: deliberate accessor-refusal fixture.
	const own = Object.defineProperty({}, "then", getter);
	// biome-ignore lint/suspicious/noThenProperty: deliberate inherited accessor-refusal fixture.
	const inherited = Object.create(Object.defineProperty({}, "then", getter));
	const proxy = new Proxy(
		{},
		{
			get() {
				hooks++;
				throw Error("PRIVATE_PROXY_CANARY");
			},
			getPrototypeOf() {
				hooks++;
				throw Error("PRIVATE_PROXY_CANARY");
			},
		},
	);
	try {
		for (const result of [own, inherited, proxy]) {
			expect(() =>
				f.store.write((db) => {
					db.run("INSERT INTO test_rows VALUES('must-rollback',1)");
					return result;
				}),
			).toThrow("callbacks must be synchronous");
		}
		expect(hooks).toBe(0);
		expect(f.store.read((db) => db.all("SELECT * FROM main.test_rows"))).toEqual([]);
	} finally {
		f.store.close();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});

it("rejects proxy callbacks before apply and never reads a callback constructor accessor", async () => {
	const f = await fixture();
	let hooks = 0,
		calls = 0;
	const callback = () => {
		calls++;
		return 42;
	};
	Object.defineProperty(callback, "constructor", {
		get() {
			hooks++;
			throw Error("PRIVATE_CONSTRUCTOR_CANARY");
		},
	});
	const proxy = new Proxy(callback, {
		apply() {
			hooks++;
			throw Error("PRIVATE_APPLY_CANARY");
		},
		get() {
			hooks++;
			throw Error("PRIVATE_GET_CANARY");
		},
	});
	try {
		expect(() => f.store.read(proxy)).toThrow("callbacks must be synchronous");
		expect(() => f.store.write(proxy)).toThrow("callbacks must be synchronous");
		expect(f.store.read(callback)).toBe(42);
		expect(calls).toBe(1);
		expect(hooks).toBe(0);
	} finally {
		f.store.close();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});
