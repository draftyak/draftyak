import { expect, it } from "vitest";
import * as publicFiles from "../src/index.ts";

it("exports the bounded known-family predicate without assigning native path authority", () => {
	expect(
		typeof publicFiles.isKnownSyncedPath,
		"public root must export the canonical predicate",
	).toBe("function");
	expect(publicFiles.isKnownSyncedPath("/dytest/OneDrive/account")).toBe(true);
	expect(publicFiles.isKnownSyncedPath("Library/CloudStorage/provider")).toBe(true);
	expect(publicFiles.isKnownSyncedPath("/dytest/local")).toBe(false);
	expect(publicFiles.isKnownSyncedPath("/dytest/OneDrive notes/account")).toBe(false);
	expect(() => publicFiles.isKnownSyncedPath({ toString: () => "OneDrive" })).toThrow(
		"Path classification refused",
	);
});
