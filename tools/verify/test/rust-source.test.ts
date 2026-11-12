import { describe, expect, it } from "vitest";
import { reservedWord } from "../../../reserved-tests.ts";
import {
	cfgNamesReserved,
	includeLiterals,
	type ModDecl,
	modDecls,
	pathAttrs,
	stringLiterals,
} from "../lib/rust-source.ts";
import { scrub, word } from "./temp-repo.ts";

// The Rust lexer on synthetic sources. Reserved words are built at run time and compared values
// are scrubbed, so a failure never prints one.
const w = word();
// A backslash, so Rust escapes reach the lexer as source text.
const bs = "\\";
const scrubbed = (values: readonly string[]): string[] => values.map(scrub);
const named = (values: readonly string[]): boolean[] =>
	values.map((value) => reservedWord.test(value));
const described = (decls: readonly ModDecl[]): string[] =>
	decls.map(({ name, inline, paths, parents }) => {
		const around = parents.map((parent) => `${parent.name}(${parent.paths.join(",")})`).join("/");
		return scrub(`${name} ${inline ? "inline" : "file"} in [${around}] at [${paths.join(",")}]`);
	});

describe("string literals", () => {
	it("reads plain strings with their escapes decoded", () => {
		const hex = `${w.slice(0, 1)}${bs}x${w.charCodeAt(1).toString(16)}${w.slice(2)}`;
		const text = [
			'let a = "plain";',
			`let b = "tab${bs}there";`,
			`let c = "${hex}";`,
			`let d = "${bs}u{73}${bs}u{6_9}de";`,
			`let e = "joined ${bs}`,
			'          line";',
			`let f = "q${bs}"q";`,
		].join("\n");
		const values = stringLiterals(text);
		expect(scrubbed(values)).toEqual([
			"plain",
			"tab\there",
			"<reserved>",
			"side",
			"joined line",
			'q"q',
		]);
		expect(named(values)).toEqual([false, false, true, false, false, false]);
	});

	it("reads raw strings, whatever their number of hashes", () => {
		const text = [
			`let a = r"C:${bs}raw${bs}path";`,
			'let b = r#"say "hi""#;',
			'let c = r##"a "# b"##;',
			`let d = include_str!(r#"../${w}/v.json"#);`,
			'let e = r"plain";',
		].join("\n");
		const values = stringLiterals(text);
		expect(scrubbed(values)).toEqual([
			`C:${bs}raw${bs}path`,
			'say "hi"',
			'a "# b',
			"../<reserved>/v.json",
			"plain",
		]);
		expect(named(values)).toEqual([false, false, false, true, false]);
	});

	it("reads byte strings, raw byte strings and C strings", () => {
		const hex = `${w.slice(0, 1)}${bs}x${w.charCodeAt(1).toString(16)}${w.slice(2)}`;
		const text = [
			`let a = b"${w}-bytes";`,
			`let b = br"raw-${w}";`,
			`let c = br#"hash "${word("_")}""#;`,
			`let d = b"${hex}";`,
			`let e = c"c-${word("-")}";`,
			`let f = cr#"craw-${w}"#;`,
			'let g = b"plain";',
		].join("\n");
		const values = stringLiterals(text);
		expect(scrubbed(values)).toEqual([
			"<reserved>-bytes",
			"raw-<reserved>",
			'hash "<reserved>"',
			"<reserved>",
			"c-<reserved>",
			"craw-<reserved>",
			"plain",
		]);
		expect(named(values)).toEqual([true, true, true, true, true, true, false]);
	});

	it("never reads a string in a comment, nested block comments included", () => {
		const text = [
			`// "line-${w}"`,
			`/* outer /* "inner" */ "still a comment ${w}" */`,
			`/// "doc ${w}"`,
			'//! "inner doc"',
			'let a = "real";',
			'/* unclosed "tail"',
		].join("\n");
		expect(scrubbed(stringLiterals(text))).toEqual(["real"]);
	});

	it("never takes a char literal's quote for a string, and reads lifetimes and labels as names", () => {
		const text = [
			"fn f<'a>(x: &'a str) -> char {",
			`    let q = '"';`,
			`    let e = '${bs}'';`,
			`    let u = '${bs}u{22}';`,
			`    let b = b'"';`,
			"    'outer: loop { break 'outer; }",
			'    let s = "real";',
			"    q",
			"}",
			"impl<'de> X<'de> for Y { const S: &'static str = \"static\"; }",
			"fn g<'r#a>() {}",
		].join("\n");
		expect(stringLiterals(text)).toEqual(["real", "static"]);
	});

	it("adds the text concat! makes of literal pieces", () => {
		const text = [
			`const P: &str = concat!("../", "${w.slice(0, 2)}", "${w.slice(2)}", "/x.rs");`,
			`const Q: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/", concat!("${w.slice(0, 2)}", '${w.slice(2, 3)}'), "${w.slice(3)}");`,
			'const R: &str = concat!("solo");',
		].join("\n");
		const values = stringLiterals(text);
		expect(named(values).filter(Boolean).length).toBe(2);
		expect(scrubbed(values)).toEqual([
			"../<reserved>/x.rs",
			"../",
			w.slice(0, 2),
			w.slice(2),
			"/x.rs",
			"/<reserved>",
			"CARGO_MANIFEST_DIR",
			"/",
			w.slice(0, 3),
			w.slice(0, 2),
			w.slice(3),
			"solo",
		]);
	});
});

describe("cfg names", () => {
	it("finds reserved features and custom cfgs in #[cfg], #![cfg], cfg! and cfg_attr", () => {
		const text = [
			'#![cfg(feature = "reserved")]',
			'#[cfg(feature = "x-reserved")]',
			"mod a;",
			"#[cfg(all(unix, maintainer_reserved))]",
			"fn b() {}",
			"fn c() -> bool { cfg!(reserved) || std::cfg!(not(Reserved_live)) }",
			'#[cfg_attr(feature = "reserved-tools", derive(Debug))]',
			"struct D;",
			"#[cfg_attr(unix, cfg(fooReserved))]",
			"struct E;",
			"#[cfg(r#reserved)]",
			"fn f() {}",
			"#[cfg_attr(a, cfg_attr(b, cfg(reserved_nested)))]",
			"struct G;",
		].join("\n");
		expect(cfgNamesReserved(text)).toEqual([
			"reserved",
			"x-reserved",
			"maintainer_reserved",
			"reserved",
			"Reserved_live",
			"reserved-tools",
			"fooReserved",
			"reserved",
			"reserved_nested",
		]);
	});

	it("reads cfg_if! conditions, cfg_select! arms, and cfgs that run across lines", () => {
		const text = [
			"cfg_if::cfg_if! {",
			'    if #[cfg(feature = "reserved")] {',
			"        mod gated;",
			"    } else {",
			"        mod plain;",
			"    }",
			"}",
			"cfg_select! {",
			"    reserved_select => { fn f() {} }",
			"    _ => { fn reserved_body() {} }",
			"}",
			"#[cfg(",
			"    any(",
			"        windows,",
			'        feature = "reserved_multi"',
			"    )",
			")]",
			"fn g() {}",
		].join("\n");
		expect(cfgNamesReserved(text)).toEqual(["reserved", "reserved_select", "reserved_multi"]);
	});

	it("reads the rustc-cfg and rustc-check-cfg lines a build script prints, with the print's arguments", () => {
		const text = [
			"fn main() {",
			'    println!("cargo:rustc-cfg=reserved");',
			'    println!("cargo::rustc-check-cfg=cfg(reserved_check)");',
			'    println!("cargo::rustc-cfg={}", "reserved_arg");',
			'    println!("cargo:rustc-cfg=tokio_unstable");',
			'    println!("cargo:rustc-env=NOTE=reserved");',
			'    let note = "reserved for later";',
			"}",
		].join("\n");
		expect(cfgNamesReserved(text)).toEqual([
			"cargo:rustc-cfg=reserved",
			"cargo::rustc-check-cfg=cfg(reserved_check)",
			"reserved_arg",
		]);
	});

	it('leaves "preserved", comments, strings and other attributes alone', () => {
		const text = [
			'#[cfg(feature = "preserved")]',
			"#[cfg(unreserved)]",
			"#[cfg(PRESERVED)]",
			"// #[cfg(reserved)]",
			"/* cfg!(reserved) */",
			'let s = "#[cfg(reserved)]";',
			"fn reserved() {}",
			'#[doc = "reserved"]',
			'#[cfg_attr(docsrs, doc = "reserved for later")]',
			"struct X;",
			'#[cfg(feature = "tokio")]',
			"fn y() {}",
		].join("\n");
		expect(cfgNamesReserved(text)).toEqual([]);
	});
});

describe("module declarations", () => {
	it("reads every mod declaration, inline ones and r# names, with the inline modules around it", () => {
		const text = [
			"mod plain;",
			"pub(crate) mod r#match;",
			`mod ${w}_cases;`,
			"pub mod outer {",
			"    mod inner;",
			"    mod nested {",
			"        mod deep;",
			"    }",
			"    mod after;",
			"}",
			`mod r#${w} {}`,
			"fn f() {",
			"    mod in_fn {}",
			"}",
			"// mod commented;",
			'const S: &str = "mod in_string;";',
			"mod last;",
		].join("\n");
		expect(described(modDecls(text))).toEqual([
			"plain file in [] at []",
			"match file in [] at []",
			"<reserved>_cases file in [] at []",
			"outer inline in [] at []",
			"inner file in [outer()] at []",
			"nested inline in [outer()] at []",
			"deep file in [outer()/nested()] at []",
			"after file in [outer()] at []",
			"<reserved> inline in [] at []",
			"in_fn inline in [] at []",
			"last file in [] at []",
		]);
	});

	it("reads #[path] on a module, plain or inside cfg_attr, and on the modules around it", () => {
		const text = [
			'#[path = "other/x.rs"]',
			"mod y;",
			'#[cfg_attr(unix, path = "unix/z.rs")]',
			'#[cfg_attr(windows, path = "windows/z.rs")]',
			"mod z;",
			'#[path = "thread_files"]',
			"mod thread {",
			'    #[path = "tls.rs"]',
			"    mod local_data;",
			"}",
			'#[path = "spaced.rs"]',
			"/// docs between the attribute and the module",
			"#[allow(dead_code)]",
			"pub mod spaced;",
			'#[path = "dropped.rs"]',
			"fn not_a_module() {}",
			"mod plain;",
			`#[path = concat!("../", "${w}", "/m.rs")]`,
			"mod joined;",
		].join("\n");
		expect(described(modDecls(text))).toEqual([
			"y file in [] at [other/x.rs]",
			"z file in [] at [unix/z.rs,windows/z.rs]",
			"thread inline in [] at [thread_files]",
			"local_data file in [thread(thread_files)] at [tls.rs]",
			"spaced file in [] at [spaced.rs]",
			"plain file in [] at []",
			"joined file in [] at [../<reserved>/m.rs]",
		]);
		expect(scrubbed(pathAttrs(text))).toEqual([
			"other/x.rs",
			"unix/z.rs",
			"windows/z.rs",
			"thread_files",
			"tls.rs",
			"spaced.rs",
			"dropped.rs",
			"../<reserved>/m.rs",
		]);
	});
});

describe("include literals", () => {
	it("reads include!, include_str! and include_bytes! literals, and concat! of literals", () => {
		const text = [
			'include!("gen/a.rs");',
			'const B: &str = include_str!("b.txt");',
			'static C: &[u8] = include_bytes!(r"c.bin");',
			'const D: &str = std::include_str!("d.txt",);',
			'#[doc = include_str!("../README.md")]',
			"struct Docs;",
			'const E: &str = include_str!(concat!("e/", "f.txt"));',
			`const F: &str = include_str!("../../${w}/v.json");`,
			'include!(concat!(env!("OUT_DIR"), "/generated.rs"));',
			"const G: &str = include_str!(PATH);",
			'// include_str!("commented.txt")',
			`const H: &str = "include_str!(${bs}"in-a-string.txt${bs}")";`,
		].join("\n");
		expect(scrubbed(includeLiterals(text))).toEqual([
			"gen/a.rs",
			"b.txt",
			"c.bin",
			"d.txt",
			"../README.md",
			"e/f.txt",
			"../../<reserved>/v.json",
		]);
	});
});

describe("text rustc would refuse", () => {
	it("reads as far as it goes without failing", () => {
		const broken = `let a = "open\nmod x;\n#[cfg(feature = "reserved"\nfn f(' ' ${bs}`;
		const read = [stringLiterals, cfgNamesReserved, modDecls, pathAttrs, includeLiterals];
		expect(() => read.map((lex) => lex(broken))).not.toThrow();
		expect(stringLiterals(`#!/usr/bin/env run-cargo-script\nlet a = "after";`)).toEqual(["after"]);
		expect(cfgNamesReserved("#![cfg(reserved)]\nfn main() {}")).toEqual(["reserved"]);
		const bom = String.fromCharCode(0xfeff);
		expect(cfgNamesReserved(`${bom}#![cfg(reserved)]`)).toEqual(["reserved"]);
	});
});
