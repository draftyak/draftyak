export const nestedStyles: readonly (readonly [string, string])[] = [
	["nested ampersand", "a{&{display:none}}"],
	["visible nested ampersand", "a{&{display:inline}}"],
	["nested descendant recovered as raw", ".parent{a{display:none}}"],
	["visible nested descendant recovered as raw", ".parent{a{display:inline}}"],
	["nested media declarations", "a{@media screen{display:none}}"],
	["nested supports declarations", "a{@supports (display:block){display:none}}"],
	["nested container declarations", "a{@container (min-width:0px){display:none}}"],
	["nested rules in media", "@media screen{a{&{display:none}}}"],
	["nested rules in layer", "@layer base{a{&{display:none}}}"],
	["nested rules in supports", "@supports (display:block){a{&{display:none}}}"],
	["nested rules in container", "@container (min-width:0px){a{&{display:none}}}"],
	["scoped rules", "@scope (.parent){a{display:none}}"],
	["visible scoped rules", "@scope (.parent){a{display:inline}}"],
	["implicit scope root", "@scope{a{display:none}}"],
	["scope boundary", "@scope (.parent) to (.limit){a{display:none}}"],
	["escaped scope name", String.raw`@s\63ope (.parent){a{display:none}}`],
	["scope in media", "@media screen{@scope (.parent){a{display:none}}}"],
];

export const flatStyles: readonly (readonly [string, string, boolean])[] = [
	["flat hidden rule", "a{display:none}", true],
	["flat visible rule", "a{display:inline}", false],
	["flat media group", "@media screen{a{display:none}}", true],
	["flat layer group", "@layer base{a{display:none}}", true],
	["ordinary malformed declaration", "a{color:red;bad;display:inline}", false],
	["braces in a custom property", "a{--unused:{display:none};display:inline}", false],
	["braces in a custom string", 'a{--unused:"{display:none}";display:inline}', false],
];

export function nestedRuleHtml(css: string): string {
	return `<style>${css}</style><div class="parent"><a href="https://hidden.example/DYTEST-private">DYTEST-CANARY</a></div>`;
}
