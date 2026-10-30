import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import type { Flag } from "@draftyak/protocol/flags";
import type { SendSnapshotV1 } from "@draftyak/protocol/snapshot";
import { describe, expectTypeOf, it } from "vitest";
import type { DeepReadonly, IdsOnlyEvent, Logger } from "../src/common.ts";
import type { ModuleDatabase, ModuleRow } from "../src/database.ts";
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

function synchronousTransactions(
	database: ModuleDatabase<"example">,
	query: { limit(count: number): unknown; then(resolve: (rows: number) => void): void },
	objectWork: () => object,
	callableColumn: { then: ((resolve: (rows: number) => void) => void) & string },
): void {
	// @ts-expect-error An explicit unknown result cannot admit a Promise.
	database.transaction<unknown>(async () => 1);
	// @ts-expect-error An explicit unknown result cannot admit a callback typed to return object.
	database.transaction<unknown>((): object => Promise.resolve(1));
	// @ts-expect-error An explicit unknown result cannot admit a callback typed to return {}.
	// biome-ignore lint/complexity/noBannedTypes: the empty object type is the case under test.
	database.transaction<unknown>((): {} => Promise.resolve(1));
	// @ts-expect-error An explicit unknown result cannot admit a function typed to return object.
	database.transaction<unknown>(objectWork);
	// @ts-expect-error An explicit void result cannot admit a Promise.
	database.transaction<void>(async () => {});
	// @ts-expect-error An explicit object result cannot admit a Promise.
	database.transaction<object>(async () => ({}));
	// @ts-expect-error An explicit empty object result cannot admit a Promise.
	// biome-ignore lint/complexity/noBannedTypes: the empty object type is the case under test.
	database.transaction<{}>(async () => 1);
	// @ts-expect-error An explicit any result cannot admit a Promise.
	// biome-ignore lint/suspicious/noExplicitAny: an explicit any result is the case under test.
	database.transaction<any>(async () => 1);
	// @ts-expect-error An explicit Promise-like result is refused.
	database.transaction<PromiseLike<number>>(() => Promise.resolve(1));
	// @ts-expect-error A callback typed to return unknown cannot return a Promise.
	database.transaction((): unknown => Promise.resolve(1));
	// @ts-expect-error A callback that returns any could return a Promise.
	database.transaction(() => JSON.parse("1"));
	// @ts-expect-error A thenable that is not a PromiseLike is refused too.
	database.transaction(() => query);
	// @ts-expect-error An explicit object result cannot admit a thenable that fits it.
	database.transaction<{ a: number }>(() => Object.assign(Promise.resolve(1), { a: 1 }));
	// @ts-expect-error An explicit record result cannot admit a thenable that fits it.
	database.transaction<Record<string, unknown>>(() => query);
	// @ts-expect-error A callback annotated with a record result that a thenable fits is refused.
	database.transaction((): Record<string, unknown> => query);
	// @ts-expect-error A callback annotated with a then-less type that a Promise fits is refused.
	database.transaction((): Omit<Promise<never>, "then"> => Promise.reject());
	// @ts-expect-error An explicit primitive result cannot admit a thenable that fits it.
	database.transaction<number>(() => Object.assign(1, query));
	// @ts-expect-error An explicit union with a primitive cannot admit a thenable that fits it.
	database.transaction<string | { a: number }>(() => Object.assign("a", query));
	// @ts-expect-error A then typed as both callable and a column value is refused.
	database.transaction<ModuleRow>(() => callableColumn);
	// @ts-expect-error A data column named then is refused; the native adapter refuses any own then.
	// biome-ignore lint/suspicious/noThenProperty: a data column named then is the case under test.
	database.transaction(() => ({ then: "column" }));
	// These forms compile, so only the native adapter's runtime refusal stops a thenable or async
	// work behind them: an annotated object result; a callback typed any under an explicit result;
	// a generic callback's return type parameter; a callback typed to return void that returns a
	// Promise, such as an async implementation of a void method; a callable then behind a computed
	// key; a Proxy typed as its target; an async generator callback.
	const annotated = database.transaction((): { a: number } => ({ a: 1 }));
	expectTypeOf(annotated).toEqualTypeOf<{ a: number }>();
	expectTypeOf(database.transaction<unknown>(() => JSON.parse("1"))).toEqualTypeOf<unknown>();
	expectTypeOf(database.transaction(() => null)).toEqualTypeOf<null>();
	const id = <T>(value: T): T => value;
	expectTypeOf(database.transaction(() => [1, 2] as const)).toEqualTypeOf<readonly [1, 2]>();
	// @ts-expect-error A const tuple result stays readonly inside a generic call.
	id(database.transaction(() => [1, 2] as const)).push(1);
	expectTypeOf(
		database.transaction((tables) => tables.insert("ext_example_rows", { id: 1 })),
	).toEqualTypeOf<number>();
	expectTypeOf(
		database.transaction((tables) => tables.select("ext_example_rows", { limit: 10 })),
	).toEqualTypeOf<readonly ModuleRow[]>();
	expectTypeOf(
		database.transaction((tables) => tables.select("ext_example_rows", { limit: 1 })[0]),
	).toEqualTypeOf<ModuleRow | undefined>();
	expectTypeOf(
		database.transaction((tables) => {
			tables.delete("ext_example_rows", { id: 1 });
		}),
	).toEqualTypeOf<void>();
	expectTypeOf(
		database.transaction<void>((tables) => {
			tables.delete("ext_example_rows", { id: 1 });
		}),
	).toEqualTypeOf<void>();
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
		expectTypeOf(synchronousTransactions).toBeFunction();
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
