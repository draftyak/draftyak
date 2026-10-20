import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import type { Flag } from "@draftyak/protocol/flags";
import type { SendSnapshotV1 } from "@draftyak/protocol/snapshot";
import { describe, expectTypeOf, it } from "vitest";
import type { DeepReadonly, IdsOnlyEvent, Logger } from "../src/common.ts";
import type { ModuleDatabase } from "../src/database.ts";
import { defineExtensionModule, type HubModule } from "../src/module.ts";
import type { AuditSink } from "../src/points/audit.ts";
import type { PushNotification } from "../src/points/push.ts";
import {
	approvalCount,
	type SendPolicyInput,
	type SendPolicyResult,
} from "../src/points/send-policy.ts";
import type { ExtensionDeviceRoutes, ExtensionRegistry } from "../src/registry.ts";

function forbiddenCapabilities(registry: ExtensionRegistry<"example">): void {
	// @ts-expect-error No master key in the registry.
	void registry.masterKey;
	// @ts-expect-error No subkeys in the registry.
	void registry.subkeys;
	// @ts-expect-error No credentials in the registry.
	void registry.credentials;
	// @ts-expect-error No broker in the registry.
	void registry.broker;
	// @ts-expect-error No executor in the registry.
	void registry.executor;
	// @ts-expect-error No scheduler in the registry.
	void registry.scheduler;
	// @ts-expect-error No clock in the registry.
	void registry.clock;
	// @ts-expect-error No send tickets in the registry.
	void registry.tickets;
	// @ts-expect-error No plugin host in the registry.
	void registry.pluginHost;
	// @ts-expect-error No statement verifier in the registry.
	void registry.statementVerifier;
	// @ts-expect-error No device-host adapter in the registry.
	void registry.deviceHost;
	// @ts-expect-error No tool runtime in the registry.
	void registry.toolRuntime;
	// @ts-expect-error No core DB handle in the registry.
	void registry.coreDatabase;
	// @ts-expect-error No approval service in the registry.
	void registry.approve;
	const database = registry.db();
	// @ts-expect-error Raw SQL is not exposed.
	database.execute("SELECT * FROM outbox");
	// @ts-expect-error Native connections are not exposed.
	void database.connection;
	// @ts-expect-error Core tables cannot be named.
	database.select("outbox", { limit: 10 });
	// @ts-expect-error Another module's tables cannot be named.
	database.select("ext_other_rows", { limit: 10 });
	database.select("ext_example_rows", { limit: 10 });
	// @ts-expect-error Transactions are synchronous and cannot return a Promise.
	database.transaction(async () => 1);
}

function immutableModule(module: HubModule): void {
	// @ts-expect-error The frozen descriptor's registration callback is readonly too.
	module.register = async () => {};
}

function forbiddenPolicy(input: SendPolicyInput): void {
	// @ts-expect-error No unconditional allow variant exists.
	const allow: SendPolicyResult = { kind: "allow" };
	// @ts-expect-error No approval bypass variant exists.
	const bypass: SendPolicyResult = { kind: "skipApproval" };
	// @ts-expect-error Raw counts must pass the positive-count helper.
	const zero: SendPolicyResult = { kind: "require", approvals: 0 };
	// @ts-expect-error Requiring approval has no skip-PIN member.
	const noPin: SendPolicyResult = { kind: "require", approvals: approvalCount(1), skipPin: true };
	// @ts-expect-error Frozen snapshot content is readonly.
	input.snapshot.body.text = "changed";
	// @ts-expect-error Frozen snapshot arrays are readonly.
	input.snapshot.attachments.push(...input.snapshot.attachments);
	// @ts-expect-error Flags cannot be changed.
	input.flags.push(...input.flags);
	void [allow, bypass, zero, noPin];
}

function noContent(event: IdsOnlyEvent, logger: Logger): void {
	// @ts-expect-error Event notifications carry no message body.
	void event.body;
	// @ts-expect-error Push does not accept plaintext content.
	const push: PushNotification = { kind: "message", body: "PRIVATE_CANARY" };
	// @ts-expect-error Logger accepts action codes and ID refs, not an arbitrary object.
	logger.info({ message: "PRIVATE_CANARY" });
	void push;
}

function auditContract(event: DeepReadonly<AuditEvent>, sink: AuditSink): Promise<void> {
	// @ts-expect-error A sink cannot change the actor recorded by the core.
	event.actor.id = null;
	// @ts-expect-error Audit references remain immutable ID-only data.
	event.refs.outbox = "PRIVATE_CANARY";
	// @ts-expect-error Audit events carry no message content.
	void event.body;
	return sink.append(event);
}

function noRouteSecrets(routes: ExtensionDeviceRoutes): void {
	routes.get("/status", (context) => {
		// @ts-expect-error No core environment capabilities are reachable.
		context.env.masterKey.derive("db");
		// @ts-expect-error No authenticated native socket handle is reachable.
		context.var.socket.write("PRIVATE_CANARY");
		return context.text("status");
	});
}

describe("security surface type checks", () => {
	it("uses the authoritative protocol types", () => {
		expectTypeOf<SendPolicyInput["snapshot"]>().toEqualTypeOf<DeepReadonly<SendSnapshotV1>>();
		expectTypeOf<SendPolicyInput["flags"]>().toEqualTypeOf<readonly DeepReadonly<Flag>[]>();
		expectTypeOf<SendPolicyInput["phase"]>().toEqualTypeOf<"propose" | "claim" | "retry">();
		expectTypeOf<Parameters<AuditSink["append"]>[0]>().toEqualTypeOf<DeepReadonly<AuditEvent>>();
	});
	it("keeps forbidden surfaces as compile errors", () => {
		expectTypeOf(forbiddenCapabilities).toBeFunction();
		expectTypeOf(forbiddenPolicy).toBeFunction();
		expectTypeOf(immutableModule).toBeFunction();
		expectTypeOf(noContent).toBeFunction();
		expectTypeOf(auditContract).toBeFunction();
		expectTypeOf(noRouteSecrets).toBeFunction();
		expectTypeOf<keyof ModuleDatabase>().toEqualTypeOf<
			"select" | "insert" | "update" | "delete" | "transaction"
		>();
		expectTypeOf<keyof ExtensionRegistry>().toEqualTypeOf<
			| "transport"
			| "cert"
			| "push"
			| "backup"
			| "identity"
			| "sendPolicy"
			| "auditSink"
			| "workspace"
			| "migrations"
			| "db"
			| "adminOp"
			| "deviceRoutes"
			| "onEvent"
			| "log"
		>();
	});
	it("infers the literal module namespace in a definition", () => {
		const module = defineExtensionModule({
			id: "example",
			version: "0.0.0",
			async register(registry) {
				expectTypeOf(registry).toEqualTypeOf<ExtensionRegistry<"example">>();
			},
		});
		expectTypeOf(module.id).toEqualTypeOf<"example">();
	});
});
