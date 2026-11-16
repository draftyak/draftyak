const target = '<a href="https://hidden.example/private">CANARY</a>';
export const cases: readonly {
	readonly label: string;
	readonly body: string;
	readonly hidden: boolean;
}[] = [
	{
		label: "reconstructed bold element",
		body: `<p><b style="display:none"></p>${target}</b>`,
		hidden: true,
	},
	{
		label: "reconstructed italic element",
		body: `<p><i style="visibility:hidden"></p>${target}</i>`,
		hidden: true,
	},
	{
		label: "reconstructed formatting class",
		body: `<style>.hidden{display:none}</style><p><b class="hidden"></p>${target}</b>`,
		hidden: true,
	},
	{ label: "late body style", body: `${target}<body style="display:none">`, hidden: true },
	{ label: "late html style", body: `${target}<html style="display:none">`, hidden: true },
	{
		label: "late body class",
		body: `<style>.hidden{display:none}</style>${target}<body class="hidden">`,
		hidden: true,
	},
	{
		label: "original body attribute wins",
		body: `<body style="display:block">${target}<body style="display:none">`,
		hidden: false,
	},
	{
		label: "original html attribute wins",
		body: `<html style="display:block"><body>${target}<html style="display:none">`,
		hidden: false,
	},
	{
		label: "closed formatting element",
		body: `<p><b style="display:none"></b></p>${target}`,
		hidden: false,
	},
	{
		label: "visible reconstructed formatting",
		body: `<p><b style="display:inline"></p>${target}</b>`,
		hidden: false,
	},
	{
		label: "hidden table foster parent",
		body: `<div style="display:none"><table>${target}</table></div>`,
		hidden: true,
	},
	{ label: "visible table foster parent", body: `<table>${target}</table>`, hidden: false },
	{
		label: "inert template cannot reveal text",
		body: `<style>a{display:none}</style><template><style>a{display:inline}</style></template>${target}`,
		hidden: true,
	},
	{
		label: "inert template cannot hide text",
		body: `<template><style>a{display:none}</style></template>${target}`,
		hidden: false,
	},
	{ label: "SVG template element", body: "<svg><template>CANARY</template></svg>", hidden: true },
	{
		label: "MathML template element",
		body: "<math><template>CANARY</template></math>",
		hidden: true,
	},
	{
		label: "foreign template in inert HTML content",
		body: "<template><svg><template>CANARY</template></svg></template>",
		hidden: true,
	},
	{
		label: "nested HTML templates",
		body: "<template><template>CANARY</template></template>",
		hidden: true,
	},
] as const;
