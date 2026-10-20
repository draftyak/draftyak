import { validateManifest } from "../../../src/manifest.ts";
import type { VectorFile } from "../../vectors.ts";
import { community } from "./core.ts";

export function generate(): VectorFile[] {
	const manifest = { ...community, runtime: "python" };
	const result = validateManifest(manifest);
	if (result.ok || result.problems[0]?.code !== "RUNTIME_UNSUPPORTED")
		throw new Error("Python manifest refusal");
	return [
		{
			path: "manifests/python.json",
			content: {
				format: "draftyak.vectors.manifests.v1",
				description: "Python is unavailable until its runtime contract is added.",
				cases: [
					{ id: "python-unavailable", manifest, code: "RUNTIME_UNSUPPORTED", structural: true },
				],
			},
		},
	];
}
