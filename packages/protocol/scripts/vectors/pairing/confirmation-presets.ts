import type { VectorFile } from "../../vectors.ts";

export function generate(): VectorFile[] {
	const capabilities = ["read", "draft", "organize", "approve", "admin"];
	const presets = {
		desktop: capabilities,
		mobile: capabilities.slice(0, 3),
		cli: capabilities.slice(0, 2),
	};
	const cases: { id: string; capabilities: string[]; preset: string; valid: boolean }[] = [];
	for (let mask = 0; mask < 32; mask++) {
		for (const preset of ["desktop", "mobile", "cli"]) {
			const required = preset === "desktop" ? 31 : preset === "mobile" ? 15 : 11;
			cases.push({
				id: `${preset}-caller-${mask}`,
				capabilities: capabilities.filter((_, index) => (mask & (1 << index)) !== 0),
				preset,
				valid: (mask & required) === required,
			});
		}
	}
	for (const preset of Object.keys(presets)) {
		cases.push(
			{
				id: `${preset}-reordered-caller`,
				capabilities: [...capabilities].reverse(),
				preset,
				valid: true,
			},
			{
				id: `${preset}-duplicate-caller`,
				capabilities: [...capabilities, "approve"],
				preset,
				valid: false,
			},
			{
				id: `${preset}-unknown-capability`,
				capabilities: [...capabilities, "unknown"],
				preset,
				valid: false,
			},
		);
	}
	for (const preset of ["unknown", "__proto__", "constructor", "host", "Desktop", ""]) {
		cases.push({ id: `unknown-preset-${cases.length}`, capabilities, preset, valid: false });
	}
	return [
		{
			path: "pairing/confirmation-presets.json",
			content: {
				format: "draftyak.vectors.pairing.v1",
				description:
					"Confirmation preset capability sets and canConfirm decisions. Caller capabilities are a set; only signed pair-confirm arrays require canonical order. Unknown preset or capability values are refused.",
				presets,
				cases,
			},
		},
	];
}
