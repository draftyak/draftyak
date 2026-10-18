import { execFile } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Credential, discover, newHostId, signIn } from "../src/auth.ts";
import { transferText } from "../src/session.ts";
import { type FakeAuth, startFakeAuth } from "./fake-auth.ts";
import { memoryStore } from "./harness.ts";

// The documented transfer across two processes (plan §4 step 2; Self-hosted VMs): this test signs
// in as the desktop with the hub's host ID, hands the text to test/transfer-child.ts as the hub and
// forgets it. M0.27 runs the same child against OpenAI.

let auth: FakeAuth | undefined;
afterEach(async () => {
	await auth?.close();
	auth = undefined;
});

interface ChildRun {
	readonly exitCode: number;
	readonly result: unknown;
}

function child(args: readonly string[], input: string, signal: AbortSignal): Promise<ChildRun> {
	const script = path.join(import.meta.dirname, "transfer-child.ts");
	return new Promise((resolve, reject) => {
		const run = execFile(process.execPath, [script, ...args], { signal }, (error, stdout) => {
			const exitCode = typeof error?.code === "number" ? error.code : error ? -1 : 0;
			try {
				resolve({ exitCode, result: JSON.parse(stdout) });
			} catch {
				reject(error ?? new Error("the child printed no JSON"));
			}
		});
		run.stdin?.end(input);
	});
}

async function desktopSignIn(hostId: string): Promise<{ auth: FakeAuth; credential: Credential }> {
	auth = await startFakeAuth();
	const endpoints = await discover(auth.url);
	const credential = await signIn({ hostId, endpoints, port: 0, openBrowser: auth.browse });
	return { auth, credential };
}

it("the hub process takes the session over and revokes it on request; the desktop forgets it", async ({
	signal,
}) => {
	const hubHostId = newHostId();
	const { auth, credential } = await desktopSignIn(hubHostId);
	const desktop = memoryStore(credential);
	const text = transferText(credential);
	await desktop.write(null);
	const run = await child([auth.url, hubHostId, "--revoke"], text, signal);
	expect(run).toEqual({
		exitCode: 0,
		result: {
			accepted: true,
			refreshed: true,
			rotated: true,
			planUsage: "enabled",
			revoked: true,
		},
	});
	expect(await desktop.read()).toBeNull();
	const refreshes = auth.tokenForms.filter((form) => form.get("grant_type") === "refresh_token");
	expect(refreshes.map((form) => form.get("refresh_token"))).toEqual([
		credential.tokens?.refreshToken,
	]);
	const revoked = auth.revocations.map((form) => form.get("token") ?? "");
	expect(revoked).toHaveLength(1);
	expect(revoked[0]).not.toBe(credential.tokens?.refreshToken);
	expect(auth.refresh.get(revoked[0] ?? "")?.family.revoked).toBe(true);
	expect(auth.problems).toEqual([]);
	expect(JSON.stringify(run)).not.toContain(credential.tokens?.accessToken ?? "-");
});

it("a hub with another host ID refuses the credential and touches nothing", async ({ signal }) => {
	const { auth, credential } = await desktopSignIn(newHostId());
	const run = await child([auth.url, newHostId(), "--revoke"], transferText(credential), signal);
	expect(run).toEqual({
		exitCode: 1,
		result: { accepted: false, refreshed: false, code: "TRANSFER_REFUSED", detail: "hostId" },
	});
	expect(auth.tokenForms.map((form) => form.get("grant_type"))).toEqual(["authorization_code"]);
	expect(auth.revocations).toEqual([]);
});
