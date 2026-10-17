import { glue, inCode, type Rule } from "../src/rules.ts";

const coAuthored = glue("Co", "-authored-by");
const generated = glue("Generated", " with");

// By trailer syntax only, so prose that names the rule passes: exactly what pr-meta (M0.3) refuses.
// Its trailer pattern, ^\s*co-authored-by:\s*.+\s<.+>\s*$, is written here so that it stays linear.
export const attribution: Rule = {
	id: "attribution",
	kind: "attribution",
	reason: `an attribution line: a ${coAuthored} trailer, or a line starting with "${generated}"`,
	patterns: [
		/^\s*co-authored-by:(?=.*>\s*$).+?\s<.+>\s*$/i,
		/^(?:(?!`)[\s\p{S}\p{M}\p{Cf}*_>#~-])*Generated with\b/u,
	],
	bad: [
		{ path: "docs/notes.md", text: `Summary\n\n${coAuthored}: Someone <someone@example.com>\n` },
		{ path: "README.md", text: `\u{1F916} ${generated} [a tool](https://example.com)\n` },
		{ path: "tools/x/gen.py", text: `# ${generated} a tool\n` },
		{ path: "docs/old.md", text: `# Title\rSome text.\r\r${generated} a tool\r` },
	],
	good: [
		{
			path: "AGENTS.md",
			text: `Every \`${coAuthored}\` trailer, and every line that starts with "${generated}", fails.\n`,
		},
		{ path: "CONTRIBUTING.md", text: `\`${coAuthored}: Name <email>\` lines are refused.\n` },
		{ path: "docs/notes.md", text: `${coAuthored}: a line without an address\n` },
		inCode(`const note = "${generated} nothing";\n`),
	],
};
