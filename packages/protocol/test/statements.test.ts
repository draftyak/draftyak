import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StatementVector } from "../scripts/vectors/statements/shared.ts";
import { canonicalize } from "../src/jcs.ts";
import { SendSnapshotV1 } from "../src/snapshot.ts";
import {
	ADMIN_GROUPS,
	ADMIN_KINDS,
	AdminStatement,
	checkFlagsAcked,
	checkSendWindow,
	isFresh,
	isStatementType,
	openTypedStatement,
	PairConfirmStatement,
	parseStatement,
	requiredAckCodes,
	SendStatement,
	StatementSchemas,
	type StatementType,
} from "../src/statements.ts";

const directory = path.resolve(import.meta.dirname, "../../../spec/vectors/statements");
describe("strict statement vectors", () => {
	for (const typ of Object.keys(StatementSchemas) as StatementType[]) {
		const document = JSON.parse(readFileSync(path.join(directory, `${typ}.json`), "utf8")) as {
			cases: StatementVector[];
		};
		for (const vector of document.cases)
			it(`${typ} ${vector.id}`, () => {
				const bytes = Buffer.from(vector.receivedHex, "hex");
				for (const signature of [vector.signature, vector.rfc6979Signature].filter(
					(value) => value !== undefined,
				)) {
					const body = openTypedStatement(typ, bytes, signature, vector.publicKeySpki);
					expect(body !== undefined).toBe(vector.valid);
					if (body !== undefined) {
						expect(canonicalize(body)).toBe(canonicalize(vector.statement));
						if (vector.windowValid !== undefined)
							expect(
								checkSendWindow(SendStatement.parse(body), SendSnapshotV1.parse(vector.snapshot)),
							).toBe(vector.windowValid);
						if (vector.flagsValid !== undefined)
							expect(checkFlagsAcked(SendStatement.parse(body), vector.flags ?? [])).toBe(
								vector.flagsValid,
							);
					}
				}
			});
	}
});
it("freshness is a time boundary and requires both clocks in the consuming verifier", () => {
	const document = JSON.parse(readFileSync(path.join(directory, "approval.send.v1.json"), "utf8"));
	const statement = SendStatement.parse(document.cases[0].statement);
	expect(isFresh(statement, statement.iat)).toBe(true);
	expect(isFresh(statement, statement.exp)).toBe(true);
	expect(isFresh(statement, statement.iat - 1)).toBe(false);
	expect(isFresh(statement, statement.exp + 1)).toBe(false);
	expect(isFresh(statement, NaN)).toBe(false);
	expect(isFresh(statement, Infinity)).toBe(false);
});
it("deduplicates required ack codes without ignoring flag details", () => {
	expect(
		requiredAckCodes([
			{ code: "NEW_RECIPIENT", severity: "ack", detail: "a" },
			{ code: "NEW_RECIPIENT", severity: "ack", detail: "b" },
			{ code: "AGENT_AUTHORED", severity: "ack" },
			{ code: "TOOL_CONTEXT_USED", severity: "info" },
		]),
	).toEqual(["AGENT_AUTHORED", "NEW_RECIPIENT"]);
	expect(() =>
		requiredAckCodes([
			{ code: "NEW_RECIPIENT", severity: "ack" },
			{ code: "NEW_RECIPIENT", severity: "ack" },
		]),
	).toThrow("FLAGS_DUPLICATE");
});
it("keeps admin groups closed and defers types without contracts", () => {
	expect(new Set(ADMIN_KINDS).size).toBe(ADMIN_KINDS.length);
	expect(Object.values(ADMIN_GROUPS).flat()).toEqual(ADMIN_KINDS);
	for (const typ of [
		"unregistered-test-contract.v1",
		"another-unregistered-test.v1",
		"host-receipt.v1",
		"unregistered-test.v2",
		"approval.send.v2",
		"__proto__",
	]) {
		expect(isStatementType(typ)).toBe(false);
		expect(parseStatement(typ as StatementType, Buffer.from("{}"))).toBeUndefined();
	}
	const doc = JSON.parse(readFileSync(path.join(directory, "admin.v1.json"), "utf8"));
	for (const kind of ADMIN_KINDS)
		expect(AdminStatement.safeParse({ ...doc.cases[0].statement, kind }).success).toBe(true);
	for (const kind of [
		"data.restore",
		"plugin.disable",
		"security.device-revoke",
		"access.token-revoke",
		"tool.delete",
	])
		expect(AdminStatement.safeParse({ ...doc.cases[0].statement, kind }).success).toBe(false);
});
it("parseStatement refuses every positional statement vector", () => {
	const read = (Object.keys(StatementSchemas) as StatementType[]).filter((typ) => {
		const { cases } = JSON.parse(readFileSync(path.join(directory, `${typ}.json`), "utf8")) as {
			cases: StatementVector[];
		};
		const positional = cases.find((vector) => vector.id === "positional");
		if (positional === undefined) throw Error(`${typ}: no positional case`);
		return parseStatement(typ, Buffer.from(positional.receivedHex, "hex")) !== undefined;
	});
	expect(read).toEqual([]);
});
it("pair capabilities bind exact order but cannot contain a duplicate or future grant", () => {
	const doc = JSON.parse(readFileSync(path.join(directory, "pair-confirm.v1.json"), "utf8"));
	const base = doc.cases[0].statement;
	expect(PairConfirmStatement.safeParse({ ...base, capabilities: ["draft", "read"] }).success).toBe(
		false,
	);
});
