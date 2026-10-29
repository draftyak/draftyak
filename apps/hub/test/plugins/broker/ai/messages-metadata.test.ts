import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../../../src/audit/chain.ts";
import {
	type CredentialBinding,
	type CredentialUse,
	CredentialVault,
} from "../../../../src/credentials/vault.ts";
import { newId } from "../../../../src/kernel/ids.ts";
import { MasterKey } from "../../../../src/kernel/master-key.ts";
import {
	type AiRequestLifecycle,
	AiVerificationError,
	beginMessagesMetadataCall,
	captureAiRequestInputs,
	closeMessagesMetadataCall,
	createAiProfileRegistry,
	createBuiltinAiProfileRegistry,
	failAiRequestCapture,
	type MessagesMetadataCallBinding,
	snapshotVerifiedAiRequest,
	verifiedAiRequestLifecycle,
	verifyCapturedAiRequest,
} from "../../../../src/plugins/broker/ai/index.ts";
import { builtinRegistrations } from "../../../../src/plugins/broker/ai/verifiers.ts";
import { HubStore } from "../../../../src/store/store.ts";
import { migrations, nativeBinding } from "../../../store/helpers.ts";

const registry = createBuiltinAiProfileRegistry();
const base = "https://api.anthropic.com/v1/models";
const configuration = {
	profile: "messages-api-v1",
	endpoint: "https://api.anthropic.com",
} as const;
const headers = [
	["accept", "application/json"],
	["anthropic-version", "2023-06-01"],
	["user-agent", "Anthropic/JS 0.135.0"],
	["x-api-key", "brokered"],
	["x-stainless-retry-count", "0"],
	["x-stainless-timeout", "600"],
] as const;
const route = {
	answers: [{ address: "8.8.8.8", family: 4 as const }],
	policy: { deniedAddresses: [], deniedPorts: [], allowLocal: true },
};
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const row = (id: string) => ({
	id,
	display_name: "DYTEST model",
	lifecycle: "active",
	max_input_tokens: 1000,
});
const page = (ids: string[], more = false) => ({
	data: ids.map(row),
	has_more: more,
	last_id: ids.at(-1) ?? null,
	first_id: ids[0] ?? null,
});
const candidate = (url = `${base}?limit=100`) => ({ method: "GET", url, headers });
const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

function call(
	binding: MessagesMetadataCallBinding = { operation: "ai_models_list", configuration, input: {} },
) {
	const controller = new AbortController();
	const handle = beginMessagesMetadataCall(binding, controller.signal);
	cleanup.push(() => closeMessagesMetadataCall(handle));
	return { controller, handle, binding: { operation: binding.operation, call: handle } };
}
function request(state: ReturnType<typeof call>, url = `${base}?limit=100`) {
	const input = captureAiRequestInputs(candidate(url), state.binding);
	const handle = verifyCapturedAiRequest(registry, "messages-api-v1", input, route);
	const lifecycle = verifiedAiRequestLifecycle(handle);
	if (!lifecycle) throw Error("DYTEST expected native lifecycle");
	return { handle, lifecycle };
}
async function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-native-metadata-"));
	const key = new MasterKey(randomBytes(32));
	const auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const store = new HubStore({
		filename: path.join(dir, "hub.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: {
			audit: path.join(migrations, "audit"),
			credentials: path.resolve(import.meta.dirname, "../../../../src/credentials/migrations"),
		},
	});
	cleanup.push(() => {
		store.close();
		audit.destroy();
		key.destroy();
		rmSync(dir, { recursive: true, force: true });
	});
	await store.migrate("audit");
	await store.migrate("credentials");
	const vault = new CredentialVault(store, audit);
	const owner: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	const value = () => ({
		kind: "provider-key" as const,
		key: `DYTEST-${randomBytes(20).toString("hex")}`,
	});
	const create = (binding = owner) =>
		store.write((tx) => vault.createInTransaction(tx, binding, value()));
	const reference = create();
	return { vault, owner, reference, create, store, value };
}
async function finish(
	f: Awaited<ReturnType<typeof fixture>>,
	state: ReturnType<typeof call>,
	url: string,
	body: unknown,
	status = 200,
) {
	const current = request(state, url);
	await f.vault.withCredential(
		f.reference,
		f.owner,
		{ requestClass: "read", signal: state.controller.signal },
		(_key, use) => {
			current.lifecycle.bindCredential(f.vault, use, state.controller.signal);
			current.lifecycle.complete(status, body instanceof Uint8Array ? body : encode(body));
			current.lifecycle.acknowledge();
		},
	);
	return current;
}

describe("native Messages metadata calls", () => {
	it("binds first-page GET headers and a real native credential before observing a terminal page", async () => {
		const f = await fixture(),
			state = call();
		const current = await finish(f, state, `${base}?limit=100`, page(["model-one"]));
		expect(snapshotVerifiedAiRequest(current.handle)).toEqual({
			profile: "messages-api-v1",
			method: "GET",
			url: `${base}?limit=100`,
			headers,
			body: new Uint8Array(0),
		});
		expect(current.lifecycle.maxResponseBytes).toBe(1_048_576);
		expect(current.lifecycle.signal.aborted).toBe(false);
		expect(() => request(state)).toThrow(AiVerificationError);
	});
	it("probes the native selected model while allowing a real response alias and retired status", async () => {
		const f = await fixture();
		for (const lifecycle of ["active", "retired"]) {
			const state = call({
				operation: "ai_probe",
				configuration: { ...configuration, model: "configured" },
				input: { model: "selected/model" },
			});
			const current = await finish(f, state, `${base}/selected%2Fmodel`, {
				...row("actual-model-alias"),
				lifecycle,
			});
			expect(current.lifecycle.signal.aborted).toBe(false);
			expect(() => request(state, `${base}/selected%2Fmodel`)).toThrow(AiVerificationError);
		}
		expect(() => call({ operation: "ai_probe", configuration, input: {} })).toThrow(
			AiVerificationError,
		);
	});
	it("derives multiple exact cursors only from observed successful native pages", async () => {
		const f = await fixture(),
			state = call();
		const cursor = "model/with%name?x#fragment!'()*~";
		const first = await finish(f, state, `${base}?limit=100`, page([cursor], true));
		expect(first.lifecycle.signal.aborted).toBe(false);
		const second = `${base}?limit=100&after_id=model%2Fwith%25name%3Fx%23fragment%21%27%28%29%2A~`;
		await finish(f, state, second, page(["second-cursor"], true));
		await finish(f, state, `${base}?limit=100&after_id=second-cursor`, page(["last-model"]));
		expect(() => request(state, `${base}?limit=100&after_id=last-model`)).toThrow(
			AiVerificationError,
		);
	});
	it("rejects arbitrary, replayed, query-modified and concurrent pagination requests", async () => {
		for (const url of [
			`${base}?limit=100&after_id=unobserved`,
			`${base}?limit=101`,
			`${base}?after_id=x&limit=100`,
			`${base}?limit=100&extra=x`,
			`${base}?limit=100#x`,
		]) {
			const state = call();
			expect(() => request(state, url)).toThrow(AiVerificationError);
			expect(() => request(state)).toThrow(AiVerificationError);
		}
		const state = call();
		const captured = captureAiRequestInputs(candidate(), state.binding);
		expect(() => captureAiRequestInputs(candidate(), state.binding)).toThrow(AiVerificationError);
		expect(() => verifyCapturedAiRequest(registry, "messages-api-v1", captured, route)).toThrow(
			AiVerificationError,
		);
		const f = await fixture(),
			replay = call();
		await finish(f, replay, `${base}?limit=100`, page(["observed"], true));
		expect(() => request(replay)).toThrow(AiVerificationError);
	});
	it("never lets a binding-supplied cursor or copied call object grant another page", () => {
		const state = call();
		expect(() =>
			captureAiRequestInputs(candidate(), { ...state.binding, after_id: "invented" }),
		).toThrow(AiVerificationError);
		expect(() => request(state)).toThrow(AiVerificationError);
		const fresh = call();
		expect(() =>
			captureAiRequestInputs(candidate(), { ...fresh.binding, call: { ...fresh.handle } }),
		).toThrow(AiVerificationError);
		expect(() =>
			captureAiRequestInputs(candidate(), {
				operation: "ai_models_list",
				configuration,
				input: {},
			}),
		).toThrow(AiVerificationError);
	});
	it("requires metadata registration and closes verification, header, body and DNS failures", () => {
		const postOnly = createAiProfileRegistry(
			builtinRegistrations.map(({ profile, verify }) => ({ profile, verify })),
		);
		const unregistered = call(),
			input = captureAiRequestInputs(candidate(), unregistered.binding);
		expect(() => verifyCapturedAiRequest(postOnly, "messages-api-v1", input, route)).toThrow(
			AiVerificationError,
		);
		expect(() => request(unregistered)).toThrow(AiVerificationError);
		for (const extra of [
			{ headers: [...headers, ["constructor", "DYTEST"]] },
			{ headers: [...headers, ["content-type", "application/json"]] },
			{ headers: [...headers.slice(0, -1), ["x-stainless-timeout", "600000"]] },
			{ body: new Uint8Array([0]) },
			{ method: "POST" },
		]) {
			const state = call();
			expect(() => {
				const capture = captureAiRequestInputs({ ...candidate(), ...extra }, state.binding);
				verifyCapturedAiRequest(registry, "messages-api-v1", capture, route);
			}).toThrow(AiVerificationError);
			expect(() => request(state)).toThrow(AiVerificationError);
		}
		const dns = call(),
			capture = captureAiRequestInputs(candidate(), dns.binding);
		expect(() =>
			verifyCapturedAiRequest(registry, "messages-api-v1", capture, {
				...route,
				answers: [{ address: "127.0.0.1", family: 4 }],
			}),
		).toThrow(AiVerificationError);
		expect(() => request(dns)).toThrow(AiVerificationError);
	});
	it("pins actual reference, owner, generation and vault across observed pages", async () => {
		const f = await fixture();
		for (const kind of ["reference", "owner", "vault", "generation"] as const) {
			const state = call();
			await finish(f, state, `${base}?limit=100`, page(["first"], true));
			const next = request(state, `${base}?limit=100&after_id=first`);
			let owner = f.owner,
				reference = f.reference,
				vault = f.vault;
			if (kind === "reference") reference = f.create();
			if (kind === "owner") {
				owner = { ...f.owner, ownerId: newId() };
				reference = f.create(owner);
			}
			if (kind === "generation")
				f.store.write((tx) => f.vault.replaceInTransaction(tx, f.reference, f.owner, f.value()));
			if (kind === "vault") {
				const other = await fixture();
				await other.vault.withCredential(
					other.reference,
					other.owner,
					{ requestClass: "read" },
					(_key, use) =>
						expect(() =>
							next.lifecycle.bindCredential(other.vault, use, state.controller.signal),
						).toThrow(AiVerificationError),
				);
			} else
				await vault.withCredential(reference, owner, { requestClass: "read" }, (_key, use) =>
					expect(() => next.lifecycle.bindCredential(vault, use, state.controller.signal)).toThrow(
						AiVerificationError,
					),
				);
			expect(next.lifecycle.signal.aborted).toBe(true);
		}
	});
	it("requires the original per-call signal and refuses stale or invented lease fields", async () => {
		const f = await fixture();
		for (const kind of ["call", "generation", "owner", "lease-signal"] as const) {
			const state = call(),
				current = request(state);
			await f.vault.withCredential(f.reference, f.owner, { requestClass: "read" }, (_key, use) => {
				const altered: CredentialUse =
					kind === "generation"
						? { ...use, generation: use.generation + 1 }
						: kind === "owner"
							? { ...use, binding: { ...use.binding, ownerId: newId() } }
							: kind === "lease-signal"
								? { ...use, signal: AbortSignal.abort() }
								: use;
				expect(() =>
					current.lifecycle.bindCredential(
						f.vault,
						altered,
						kind === "call" ? new AbortController().signal : state.controller.signal,
					),
				).toThrow(AiVerificationError);
			});
			expect(current.lifecycle.signal.aborted).toBe(true);
		}
	});
	it("rechecks the real current credential before cursor advance or final completion", async () => {
		const f = await fixture(),
			state = call(),
			current = request(state);
		await expect(
			f.vault.withCredential(f.reference, f.owner, { requestClass: "read" }, (_key, use) => {
				current.lifecycle.bindCredential(f.vault, use, state.controller.signal);
				f.store.write((tx) => f.vault.replaceInTransaction(tx, f.reference, f.owner, f.value()));
				expect(() => current.lifecycle.complete(200, encode(page(["not-accepted"], true)))).toThrow(
					AiVerificationError,
				);
			}),
		).rejects.toThrow();
		expect(current.lifecycle.signal.aborted).toBe(true);
		expect(() => request(state, `${base}?limit=100&after_id=not-accepted`)).toThrow(
			AiVerificationError,
		);
	});
	it("closes on original cancellation and every explicit capture/network cleanup hook", () => {
		const aborted = new AbortController();
		aborted.abort();
		expect(() =>
			beginMessagesMetadataCall(
				{ operation: "ai_models_list", configuration, input: {} },
				aborted.signal,
			),
		).toThrow(AiVerificationError);
		for (const kind of ["signal", "capture", "network", "close"] as const) {
			const state = call(),
				current = request(state);
			if (kind === "signal") state.controller.abort();
			if (kind === "capture") failAiRequestCapture(state.binding);
			if (kind === "network") current.lifecycle.fail();
			if (kind === "close") closeMessagesMetadataCall(state.handle);
			expect(current.lifecycle.signal.aborted).toBe(true);
			expect(() => request(state)).toThrow(AiVerificationError);
		}
		expect(() =>
			failAiRequestCapture({
				get call() {
					throw Error("DYTEST");
				},
			}),
		).not.toThrow();
	});
	it("requires credential binding and exactly one completion for each reservation", async () => {
		const f = await fixture(),
			unbound = call(),
			first = request(unbound);
		expect(() => first.lifecycle.complete(200, encode(page([])))).toThrow(AiVerificationError);
		const state = call(),
			current = request(state);
		await f.vault.withCredential(f.reference, f.owner, { requestClass: "read" }, (_key, use) => {
			current.lifecycle.bindCredential(f.vault, use, state.controller.signal);
			current.lifecycle.complete(200, encode(page(["one"], true)));
			expect(() => current.lifecycle.complete(200, encode(page(["one"], true)))).toThrow(
				AiVerificationError,
			);
		});
		expect(current.lifecycle.signal.aborted).toBe(true);
	});
	it("holds the single pending reservation through terminal delivery acknowledgement", async () => {
		const f = await fixture(),
			state = call(),
			current = request(state);
		await f.vault.withCredential(f.reference, f.owner, { requestClass: "read" }, (_key, use) => {
			current.lifecycle.bindCredential(f.vault, use, state.controller.signal);
			current.lifecycle.complete(200, encode(page(["not-yet-acknowledged"], true)));
			expect(current.lifecycle.signal.aborted).toBe(false);
			expect(() => request(state)).toThrow(AiVerificationError);
			expect(() => request(state, `${base}?limit=100&after_id=not-yet-acknowledged`)).toThrow(
				AiVerificationError,
			);
			expect(() => current.lifecycle.acknowledge()).toThrow(AiVerificationError);
		});
		expect(current.lifecycle.signal.aborted).toBe(true);
	});
	it("retains the live credential fence until acknowledgement commits the next cursor", async () => {
		const f = await fixture(),
			state = call(),
			current = request(state);
		await expect(
			f.vault.withCredential(f.reference, f.owner, { requestClass: "read" }, (_key, use) => {
				current.lifecycle.bindCredential(f.vault, use, state.controller.signal);
				current.lifecycle.complete(200, encode(page(["not-yet-current"], true)));
				f.store.write((tx) => f.vault.replaceInTransaction(tx, f.reference, f.owner, f.value()));
				expect(current.lifecycle.signal.aborted).toBe(true);
				expect(() => current.lifecycle.acknowledge()).toThrow(AiVerificationError);
			}),
		).rejects.toThrow();
		expect(() => request(state, `${base}?limit=100&after_id=not-yet-current`)).toThrow(
			AiVerificationError,
		);
	});
	it("reads actual stored generation at acknowledgement even without an abort notification", async () => {
		const f = await fixture(),
			state = call(),
			current = request(state);
		let acknowledgementError: unknown;
		let leaseWasAborted: boolean | undefined;
		await expect(
			f.vault.withCredential(f.reference, f.owner, { requestClass: "read" }, (_key, use) => {
				current.lifecycle.bindCredential(f.vault, use, state.controller.signal);
				current.lifecycle.complete(200, encode(page(["stale-generation"], true)));
				f.store.write((tx) =>
					tx.run("UPDATE main.credentials SET generation=generation+1 WHERE id=?", [f.reference]),
				);
				leaseWasAborted = use.signal.aborted;
				try {
					current.lifecycle.acknowledge();
				} catch (error) {
					acknowledgementError = error;
				}
			}),
		).rejects.toThrow();
		expect(leaseWasAborted).toBe(false);
		expect(acknowledgementError).toBeInstanceOf(AiVerificationError);
		expect(current.lifecycle.signal.aborted).toBe(true);
		expect(() => request(state, `${base}?limit=100&after_id=stale-generation`)).toThrow(
			AiVerificationError,
		);
	});
	it("requires primitive lifecycle strings in native list and probe metadata", async () => {
		const f = await fixture();
		for (const lifecycle of [
			["active"],
			["deprecated"],
			["retired"],
			{ toString: "active" },
			null,
			true,
		]) {
			const invalid = { ...row("one"), lifecycle };
			await expect(
				finish(f, call(), `${base}?limit=100`, { data: [invalid], has_more: false }),
			).rejects.toThrow();
			const probe = call({
				operation: "ai_probe",
				configuration: { ...configuration, model: "one" },
				input: {},
			});
			await expect(finish(f, probe, `${base}/one`, invalid)).rejects.toThrow();
		}
	});
	it("caps actual page bytes at1MiB including HTTP error bodies", async () => {
		const f = await fixture(),
			body = encode(page(["one"]));
		const exact = new Uint8Array(1_048_576).fill(32);
		exact.set(body);
		const state = call(),
			current = await finish(f, state, `${base}?limit=100`, exact);
		expect(current.lifecycle.signal.aborted).toBe(false);
		for (const status of [200, 500]) {
			const oversized = call();
			await expect(
				finish(f, oversized, `${base}?limit=100`, new Uint8Array(1_048_577), status),
			).rejects.toThrow();
			expect(() => request(oversized)).toThrow(AiVerificationError);
		}
	});
	it("closes malformed, duplicate, retired or cursor-inconsistent native pages", async () => {
		const f = await fixture();
		for (const value of [
			new Uint8Array([0xff]),
			new TextEncoder().encode('{"data":[],"data":[],"has_more":false}'),
			page([], true),
			{ ...page(["one"], true), last_id: "arbitrary" },
			page(["one", "one"]),
			{ ...page(["one"]), data: [{ ...row("one"), lifecycle: "retired" }] },
			{ ...page(["one"]), data: [{ ...row("one"), max_input_tokens: 0 }] },
			page(Array.from({ length: 101 }, (_, index) => `model-${index}`)),
		]) {
			const state = call();
			await expect(finish(f, state, `${base}?limit=100`, value)).rejects.toThrow();
			expect(() => request(state)).toThrow(AiVerificationError);
		}
		const duplicate = call();
		await finish(f, duplicate, `${base}?limit=100`, page(["one"], true));
		await expect(
			finish(f, duplicate, `${base}?limit=100&after_id=one`, page(["one"])),
		).rejects.toThrow();
	});
	it("permits five100-model pages and closes the500-model budget without self-cancelling final delivery", async () => {
		const f = await fixture(),
			state = call();
		let url = `${base}?limit=100`,
			last: AiRequestLifecycle | undefined;
		for (let index = 0; index < 5; index++) {
			const ids = Array.from({ length: 100 }, (_, row) => `model-${index}-${row}`);
			const current = await finish(f, state, url, page(ids, true));
			last = current.lifecycle;
			expect(current.lifecycle.signal.aborted).toBe(false);
			url = `${base}?limit=100&after_id=model-${index}-99`;
		}
		expect(last?.signal.aborted).toBe(false);
		expect(() => request(state, url)).toThrow(AiVerificationError);
	});
	it("closes HTTP errors against further pagination while preserving current error delivery", async () => {
		const f = await fixture(),
			state = call();
		const current = await finish(
			f,
			state,
			`${base}?limit=100`,
			{ error: { type: "authentication_error" } },
			401,
		);
		expect(current.lifecycle.signal.aborted).toBe(false);
		expect(() => request(state)).toThrow(AiVerificationError);
	});
});
