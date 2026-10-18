import { lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

export function removeFixture(target: string, parent: string, prefix: string): void {
	const root = path.resolve(parent);
	const resolved = path.resolve(target);
	if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(prefix)) {
		throw new Error("Unsafe packaging fixture cleanup path");
	}
	const stat = lstatSync(resolved);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		realpathSync(resolved) !== path.join(realpathSync(root), path.basename(resolved))
	) {
		throw new Error("Unsafe packaging fixture cleanup identity");
	}
	rmSync(resolved, { recursive: true, force: true });
}
