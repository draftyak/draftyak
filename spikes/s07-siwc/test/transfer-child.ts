import { discover, planUsage } from "../src/auth.ts";
import { SiwcError } from "../src/errors.ts";
import { acceptTransfer, Session } from "../src/session.ts";
import { memoryStore } from "./harness.ts";

// The receiving side of the documented transfer as its own process (test/transfer.test.ts, M0.27):
// node transfer-child.ts <issuer> <this host's ID> [--revoke], with transferText on stdin. It takes
// the credential only for its own host ID, refreshes once to own the session, revokes it when asked
// (even after a failed refresh) and prints content-free results, never a token.
const [issuer = "", hostId = "", ...flags] = process.argv.slice(2);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const result: Record<string, unknown> = { accepted: false, refreshed: false };
let session: Session | undefined;
try {
	const received = acceptTransfer(Buffer.concat(chunks).toString("utf8"), { hostId, issuer });
	result.accepted = true;
	session = new Session(memoryStore(received), await discover(issuer));
	const refreshed = await session.refresh();
	result.refreshed = true;
	result.rotated = refreshed.tokens?.refreshToken !== received.tokens?.refreshToken;
	result.planUsage = planUsage(refreshed);
} catch (error) {
	result.code = error instanceof SiwcError ? error.code : "ERROR";
	if (error instanceof SiwcError && error.facts.detail) result.detail = error.facts.detail;
	process.exitCode = 1;
}
if (session && flags.includes("--revoke")) result.revoked = await session.revoke();
process.stdout.write(JSON.stringify(result));
