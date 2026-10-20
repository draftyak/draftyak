import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

const cases: { label: string; css?: string; parent?: string; child?: string; hidden: boolean }[] = [
	{
		label: "custom initial uses hidden fallback",
		child: "--gate:initial;visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "custom initial masks inherited visible",
		parent: "--gate:visible",
		child: "--gate:initial;visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "inherits parent computed custom value",
		parent: "--gate:var(--base);--base:hidden",
		child: "--base:visible;visibility:var(--gate)",
		hidden: true,
	},
	{
		label: "initial permits a visible fallback",
		parent: "visibility:hidden",
		child: "--gate:initial;visibility:var(--gate,visible)",
		hidden: false,
	},
	{
		label: "initial masks inherited hidden",
		parent: "--gate:hidden",
		child: "--gate:initial;visibility:var(--gate,visible)",
		hidden: false,
	},
	{
		label: "preserves parent computed visible",
		parent: "--gate:var(--base);--base:visible",
		child: "--base:hidden;visibility:var(--gate)",
		hidden: false,
	},
	{
		label: "own custom value resets inherited hidden",
		parent: "--gate:hidden",
		child: "--gate:visible;visibility:var(--gate)",
		hidden: false,
	},
	...["inherit", "unset"].map((value) => ({
		label: `custom ${value} retains computed inheritance`,
		parent: "--gate:var(--base);--base:hidden",
		child: `--gate:${value};--base:visible;visibility:var(--gate)`,
		hidden: true,
	})),
	{
		label: "custom initial is case insensitive",
		child: "--gate:INITIAL;visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "initial font uses zero fallback",
		child: "--size:initial;font-size:var(--size,0)",
		hidden: true,
	},
	{
		label: "initial font permits absolute reset",
		parent: "font-size:0",
		child: "--size:initial;font-size:var(--size,16px)",
		hidden: false,
	},
	{
		label: "empty custom value does not select fallback",
		child: "--gate:;visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "nested missing fallback hides",
		child: "visibility:var(--missing,var(--also-missing,hidden))",
		hidden: true,
	},
	{
		label: "nested fallback permits reset",
		parent: "visibility:hidden",
		child: "visibility:var(--missing,var(--also-missing,visible))",
		hidden: false,
	},
	{
		label: "unused invalid fallback does not erase value",
		child: "--gate:hidden;visibility:var(--gate,var(--missing))",
		hidden: true,
	},
	{
		label: "unused invalid fallback keeps visible value",
		parent: "visibility:hidden",
		child: "--gate:visible;visibility:var(--gate,var(--missing))",
		hidden: false,
	},
	{
		label: "cyclic custom properties select fallback",
		child: "--a:var(--b,visible);--b:var(--a,visible);visibility:var(--a,hidden)",
		hidden: true,
	},
	{
		label: "cyclic custom properties permit visible fallback",
		parent: "visibility:hidden",
		child: "--a:var(--b,hidden);--b:var(--a,hidden);visibility:var(--a,visible)",
		hidden: false,
	},
	{
		label: "unused fallback dependency still forms cycle",
		child: "--known:visible;--gate:var(--known,var(--gate));visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "cycle masks inherited value",
		parent: "--gate:visible",
		child: "--gate:var(--gate);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "invalid own value masks parent",
		parent: "--gate:visible",
		child: "--gate:var(--missing);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "computed names preserve case",
		parent: "--Base:hidden;--gate:var(--Base)",
		child: "--base:visible;visibility:var(--gate)",
		hidden: true,
	},
	{
		label: "custom layer rollback retains lower value",
		css: "@layer base{.child{--gate:hidden}}@layer top{.child{--gate:revert-layer}}",
		child: "visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "custom origin rollback inherits",
		parent: "--gate:hidden",
		child: "--gate:visible;--gate:revert;visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "generated custom initial is guaranteed invalid",
		child: "--gate:var(--missing,initial);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "generated initial masks inherited visible",
		parent: "--gate:visible",
		child: "--gate:var(--missing,initial);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "consumer fallback may reset to initial",
		parent: "visibility:hidden",
		child: "visibility:var(--missing,initial)",
		hidden: false,
	},
	{
		label: "invalid custom without fallback inherits property",
		parent: "visibility:hidden",
		child: "--gate:initial;visibility:var(--gate)",
		hidden: true,
	},
	...["inherit", "unset", "revert"].flatMap((keyword) => [
		{
			label: `generated custom ${keyword} inherits hidden`,
			parent: "--gate:hidden",
			child: `--gate:visible;--gate:var(--missing,${keyword});visibility:var(--gate,visible)`,
			hidden: true,
		},
		{
			label: `generated custom ${keyword} inherits visible`,
			parent: "--gate:visible;visibility:hidden",
			child: `--gate:hidden;--gate:var(--missing,${keyword});visibility:var(--gate,hidden)`,
			hidden: false,
		},
	]),
	{
		label: "generated layer rollback restores hidden custom value",
		css: "@layer base{.child{--gate:hidden}}",
		child: "--gate:var(--missing,revert-layer);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "generated layer rollback restores visible custom value",
		css: "@layer base{.child{--gate:visible}}",
		parent: "visibility:hidden;--gate:hidden",
		child: "--gate:var(--missing,revert-layer);visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "generated layer rollback discards same-layer values",
		css: ".child{--gate:visible}",
		parent: "--gate:hidden",
		child: "--gate:var(--missing,revert-layer);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "comments do not preserve raw initial as data",
		child: "--gate:/**/initial/**/;visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "comments do not preserve generated initial as data",
		child: "--gate:var(--missing,/**/initial/**/);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "bounded unknown value does not activate fallback",
		child: `--gate:${"x".repeat(5_000)};visibility:var(--gate,hidden)`,
		hidden: false,
	},
	...[8, 9].map((length) => ({
		label: `custom dependency depth ${length} respects the bounded model`,
		child: `${Array.from({ length }, (_, index) => `--v${index}:${index + 1 < length ? `var(--v${index + 1})` : "hidden"}`).join(";")};visibility:var(--v0,hidden)`,
		hidden: length === 8,
	})),
	{
		label: "variable number cannot form a dimension token",
		child: "--n:0;font-size:var(--n)px",
		hidden: false,
	},
	{
		label: "variable identifier cannot form a keyword token",
		child: "--part:hid;visibility:var(--part)den",
		hidden: false,
	},
	{
		label: "variable identifier cannot form a function token",
		child: "--fn:calc;font-size:var(--fn)(0px)",
		hidden: false,
	},
	{
		label: "variable number remains valid in explicit arithmetic",
		child: "--n:0;font-size:calc(var(--n) * 1px)",
		hidden: true,
	},
	{
		label: "empty own value masks inherited hidden",
		parent: "--gate:hidden",
		child: "--gate:;visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "inherited initial stays invalid",
		parent: "--gate:initial",
		child: "--base:visible;visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "inherited computed value does not create descendant cycle",
		parent: "--base:hidden;--gate:var(--base)",
		child: "--base:var(--gate);visibility:var(--base)",
		hidden: true,
	},
	{
		label: "conditional first layer order stays hidden in both scenarios",
		css: "@media (max-width:600px){@layer early;.child{visibility:hidden!important}}@layer other{.child{visibility:visible}}@layer early{.child{visibility:hidden}}",
		hidden: true,
	},
	{
		label: "conditional first layer order preserves a visible scenario",
		css: "@media (max-width:600px){@layer early;}@layer other{.child{visibility:hidden}}@layer early{.child{visibility:visible}}",
		hidden: false,
	},
	...["revert", "revert-layer"].flatMap((value) => [
		{
			label: `visibility ${value}`,
			parent: "visibility:hidden",
			child: `visibility:${value}`,
			hidden: true,
		},
		{ label: `size ${value}`, parent: "font-size:0", child: `font-size:${value}`, hidden: true },
		{ label: `shorthand ${value}`, parent: "font-size:0", child: `font:${value}`, hidden: true },
	]),
	{
		label: "origin rollback discards earlier inline",
		parent: "visibility:hidden",
		child: "visibility:visible;visibility:revert",
		hidden: true,
	},
	{
		label: "origin rollback discards stylesheet",
		css: ".child{visibility:visible}",
		parent: "visibility:hidden",
		child: "visibility:revert",
		hidden: true,
	},
	{
		label: "origin rollback restores visible inheritance",
		css: ".child{visibility:hidden}",
		child: "visibility:revert",
		hidden: false,
	},
	{
		label: "same-layer rollback discards earlier declaration",
		parent: "font-size:0",
		child: "font-size:16px;font-size:revert-layer",
		hidden: true,
	},
	{
		label: "unlayered rollback removes unlayered stylesheet",
		css: ".child{visibility:visible}",
		parent: "visibility:hidden",
		child: "visibility:revert-layer",
		hidden: true,
	},
	{
		label: "lower layer stays hidden",
		css: "@layer base,top;@layer base{.child{visibility:hidden}}@layer top{.child{visibility:revert-layer}}",
		hidden: true,
	},
	{
		label: "lower layer recovers visible",
		css: "@layer base,top;@layer base{.child{visibility:visible}}@layer top{.child{visibility:revert-layer}}",
		parent: "visibility:hidden",
		hidden: false,
	},
	{
		label: "unlayered rollback reveals named layer",
		css: "@layer base{.child{font-size:16px}}",
		parent: "font-size:0",
		child: "font:revert-layer",
		hidden: false,
	},
	{
		label: "named order precedes physical rule order",
		css: "@layer first,last;@layer last{.child{visibility:hidden}}@layer first{.child{visibility:visible}}",
		hidden: true,
	},
	{
		label: "important layers reverse order",
		css: "@layer first,last;@layer first{.child{visibility:hidden!important}}@layer last{.child{visibility:visible!important}}",
		hidden: true,
	},
	{
		label: "important rollback does not revive later layers",
		css: "@layer first,last;@layer first{.child{visibility:revert-layer!important}}@layer last{.child{visibility:visible!important}}",
		parent: "visibility:hidden",
		hidden: true,
	},
	{
		label: "important rollback reveals earlier normal layer",
		css: "@layer first,last;@layer first{.child{visibility:visible}}@layer last{.child{visibility:revert-layer!important}}",
		parent: "visibility:hidden",
		hidden: false,
	},
	{
		label: "important inline rollback retains stylesheet importance",
		css: ".child{visibility:visible!important}",
		parent: "visibility:hidden",
		child: "visibility:revert-layer!important",
		hidden: false,
	},
	{
		label: "inline important beats earlier important layer",
		css: "@layer base{.child{visibility:hidden!important}}",
		child: "visibility:visible!important",
		hidden: false,
	},
	{
		label: "nested layer rollback",
		css: "@layer outer{@layer a,b;@layer a{.child{font-size:0}}@layer b{.child{font-size:revert-layer}}}",
		hidden: true,
	},
	{
		label: "named nested layer reuse",
		css: "@layer outer{ @layer a{.child{visibility:hidden}}}@layer outer.a{.child{visibility:visible}}",
		parent: "visibility:hidden",
		hidden: false,
	},
	{
		label: "implicit nested layer wins normally",
		css: "@layer outer{.child{visibility:hidden}@layer inner{.child{visibility:visible}}}",
		hidden: true,
	},
	{
		label: "anonymous layers stay distinct",
		css: "@layer{.child{visibility:hidden}}@layer{.child{visibility:revert-layer}}",
		hidden: true,
	},
	{
		label: "escaped layer identifier stays one segment",
		css: "@layer a\\.b{.child{visibility:hidden}}@layer a\\.b{.child{visibility:revert-layer}}",
		hidden: false,
	},
	{
		label: "resolved rollback retains inheritance",
		parent: "visibility:hidden",
		child: "visibility:var(--missing,revert)",
		hidden: true,
	},
	{
		label: "resolved layer rollback selects lower layer",
		css: "@layer base{.child{visibility:visible}}",
		parent: "visibility:hidden",
		child: "visibility:var(--missing,revert-layer)",
		hidden: false,
	},
	...["calc(100% + 0px)", "calc(1em + 0px)", "calc(1ex + 0px)", "calc((50% + 50%) + 0px)"].map(
		(value) => ({
			label: `zero parent ${value}`,
			parent: "font-size:0",
			child: `font-size:${value}`,
			hidden: true,
		}),
	),
	{
		label: "mixed zero shorthand",
		parent: "font-size:0",
		child: "font:calc(1em + 0px)/1 serif",
		hidden: true,
	},
	...["calc(1rem + 0px)", "calc(1em + 1px)", "calc(1px + 100%)"].map((value) => ({
		label: `visible mixed ${value}`,
		parent: "font-size:0",
		child: `font-size:${value}`,
		hidden: false,
	})),
	{
		label: "nonzero parent relative mixed",
		parent: "font-size:16px",
		child: "font-size:calc(100% + 0px)",
		hidden: false,
	},
	{ label: "different zero font units", child: "font-size:calc(0em + 0rem)", hidden: true },
	{
		label: "explicit visible reset",
		parent: "visibility:hidden",
		child: "visibility:visible",
		hidden: false,
	},
	{
		label: "explicit absolute font reset",
		parent: "font-size:0",
		child: "font-size:16px",
		hidden: false,
	},
	{
		label: "transform scalar retains second-axis zero",
		child: "transform:scale(1,0)",
		hidden: true,
	},
];

it.each(cases)(
	"resolves $label before text and anchor admission",
	({ css = "", parent = "", child = "", hidden }) => {
		const result = cleanHtml(
			`<style>${css}</style><span style='${parent}'><a class='child' style='${child}' href='https://hidden.example'>CANARY</a></span>Visible`,
		);
		expect(result.text).toBe(hidden ? "Visible" : "CANARY [link 1: hidden.example]Visible");
		expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
		expect(result.removals.hidden).toBe(css.length + (hidden ? 6 : 0));
	},
);

it("keeps existing HTML color hints below authored layers", () => {
	const css = "@layer base{font{color:blue;background-color:blue}}";
	const result = cleanHtml(`<style>${css}</style><font color='red'>CANARY</font>Visible`);
	expect(result.text).toBe("Visible");
	expect(result.removals.hidden).toBe(css.length + 6);
});

it.each(["revert", "revert-layer"])("resolves HTML hint origin for color:%s", (rollback) => {
	const result = cleanHtml(
		`<font color='red' style='color:${rollback};background-color:red'>CANARY</font>Visible`,
	);
	expect(result.text).toBe(rollback === "revert" ? "CANARYVisible" : "Visible");
	expect(result.removals.hidden).toBe(rollback === "revert" ? 0 : 6);
});
