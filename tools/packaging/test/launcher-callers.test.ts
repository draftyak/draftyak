import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

it("the container entry preserves literal arguments through the protected root launcher", () => {
	const source = readFileSync(path.join(root, "docker/draftyak"), "utf8");
	const command = source.split("\n").find((line) => line.startsWith("exec "));
	expect(command?.split(" ")).toEqual([
		"exec",
		"/opt/draftyak/node",
		"--disable-sigusr1",
		"/opt/draftyak/draftyak.mjs",
		'"$@"',
	]);
});

it("service templates invoke the protected launcher outside the sealed CLI tree", () => {
	const unit = readFileSync(path.join(root, "tools/packaging/templates/draftyak.service"), "utf8");
	expect(
		unit
			.split("\n")
			.find((line) => line.startsWith("ExecStart="))
			?.split(" "),
	).toEqual([
		"ExecStart=/opt/draftyak/node",
		"--disable-sigusr1",
		"/opt/draftyak/draftyak.mjs",
		"serve",
	]);
	const plist = readFileSync(
		path.join(root, "tools/packaging/templates/com.draftyak.hub.plist"),
		"utf8",
	);
	const argumentsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
		plist,
	)?.[1];
	expect(argumentsBlock).toBeDefined();
	const argumentsList = [...String(argumentsBlock).matchAll(/<string>([^<]*)<\/string>/g)].map(
		(match) => match[1],
	);
	expect(argumentsList).toEqual([
		"__DRAFTYAK_ROOT__/node",
		"--disable-sigusr1",
		"__DRAFTYAK_ROOT__/draftyak.mjs",
		"serve",
	]);
});
