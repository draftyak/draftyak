import { expect, it } from "vitest";
import { newId } from "../../src/kernel/ids.ts";
import { tallyApprovals } from "../../src/outbox/propose.ts";

it("counts users once and always requires the owner and every frozen required user", () => {
	const [a, b, c, owner] = Array.from({ length: 4 }, () => newId()).sort();
	if (!a || !b || !c || !owner) throw new Error("DYTEST users missing");
	const cases: readonly [number, readonly string[], readonly string[], boolean][] = [
		[1, [owner], [], false],
		[1, [owner], [a], false],
		[1, [owner], [owner], true],
		[2, [owner], [owner, owner], false],
		[2, [owner], [owner, a], true],
		[2, [owner, b], [owner, a], false],
		[2, [owner, b], [owner, b], true],
		[3, [owner], [a, b, c], false],
		[3, [owner], [owner, a, b], true],
		[4, [owner, a, b, c], [c, b, a, owner, owner], true],
	];
	for (const [requiredApprovals, requiredUsers, voters, expected] of cases)
		expect(tallyApprovals({ userId: owner, requiredApprovals, requiredUsers }, voters)).toBe(
			expected,
		);
});

it("refuses a required-user set that omits the actual owner", () => {
	const owner = newId(),
		other = newId();
	expect(() =>
		tallyApprovals({ userId: owner, requiredApprovals: 1, requiredUsers: [other] }, [other]),
	).toThrow();
});
