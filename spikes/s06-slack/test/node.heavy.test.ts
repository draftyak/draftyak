import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeBinary, nodeVersions } from "@draftyak/spike-kit";
import { expect, it } from "vitest";
import { FakeSlack, messageEvent, until } from "./fake-slack.ts";

// The hub runs on Node 26.5.1 and later (plan §2): Socket Mode on the built-in WebSocket client of
// both pinned Nodes. DRAFTYAK_NODES (both, minimum or bundled; unset means both) picks them.
function selected(env: NodeJS.ProcessEnv = process.env): ("minimum" | "bundled")[] {
	const value = env.DRAFTYAK_NODES || "both";
	if (value === "both") return ["minimum", "bundled"];
	if (value === "minimum" || value === "bundled") return [value];
	throw new Error(`DRAFTYAK_NODES is both, minimum or bundled, not "${value}"`);
}

const client = fileURLToPath(new URL("./socket-client.ts", import.meta.url));

for (const which of selected()) {
	const version = nodeVersions()[which];

	it(`Node ${version}: connects, acks once, reconnects and refreshes`, async () => {
		const node = await nodeBinary(version);
		const fake = await new FakeSlack().start();
		const lines: Record<string, unknown>[] = [];
		const child = spawn(node, [client, fake.apiBase], {
			env: { ...process.env, DY_FAKE_APP_TOKEN: fake.appToken },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffered = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			buffered += chunk;
			for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
				lines.push(JSON.parse(buffered.slice(0, end)));
				buffered = buffered.slice(end + 1);
			}
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
		const ready = (): number =>
			lines.filter((line) => (line.state as { kind?: string })?.kind === "ready").length;
		const events = (): unknown[] => lines.flatMap((line) => (line.event ? [line.event] : []));
		const newest = () => {
			const connection = fake.live().at(-1);
			if (connection === undefined) throw new Error("no live connection");
			return connection;
		};
		const deliverAndCheck = async (eventId: string): Promise<void> => {
			const count = events().length;
			const envelope = fake.deliver(
				messageEvent(
					{ channel: "D0DM00001", channel_type: "im", ts: "1760000000.000100" },
					eventId,
				),
			);
			await until(
				() => events().length > count && fake.acksFor(envelope.envelopeId).length > 0,
				eventId,
			);
			expect(fake.acksFor(envelope.envelopeId).map((ack) => ack.raw)).toEqual([
				JSON.stringify({ envelope_id: envelope.envelopeId }),
			]);
		};
		try {
			await until(() => ready() >= 1, "the first connection");
			await deliverAndCheck("EvNODE0001");
			fake.terminate(newest());
			await until(() => ready() >= 2, "the reconnect");
			await deliverAndCheck("EvNODE0002");
			const before = newest();
			fake.disconnect(before, "refresh_requested", null);
			await until(() => ready() >= 3 && before.closedCode !== null, "the refresh");
			expect(before.closedCode).toBe(1000);
			await deliverAndCheck("EvNODE0003");
			expect(events()).toEqual(
				["EvNODE0001", "EvNODE0002", "EvNODE0003"].map((eventId) =>
					expect.objectContaining({ kind: "message", eventId, channel: "D0DM00001" }),
				),
			);
			child.stdin.end();
			expect(await exited).toBe(0);
			expect(lines.at(-1)).toEqual({ stopped: "aborted", node: `v${version}` });
			expect(fake.calls("apps.connections.open")).toHaveLength(3);
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : error}
client stderr: ${stderr}`);
		} finally {
			child.kill();
			await fake.close();
		}
	});
}
