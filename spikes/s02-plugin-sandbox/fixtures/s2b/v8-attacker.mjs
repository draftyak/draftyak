// Runtime V8-flag weakening (plan §15 S2, §9.2 sandbox-escape row): a plugin calls
// v8.setFlagsFromString('--allow-natives-syntax') and then compiles code that uses V8 natives
// through node:vm, which --disallow-code-generation-from-strings does NOT block. The host spawns
// this under the production argv and reports on stdout.
//
// Verified on 26.5.1 and 26.12.0: without --freeze-flags-after-init the weakening succeeds (the
// "after" sample runs natives); with it, setFlagsFromString aborts the process (V8 fatal
// "Check failed: !IsFrozen()"), so the "after" line never prints and the process exits non-zero.
import fs from "node:fs";
import v8 from "node:v8";
import vm from "node:vm";

function emit(object) {
	fs.writeSync(1, `##DYS2B##${JSON.stringify(object)}\n`);
}

// Compiles and runs a V8-natives expression through node:vm. Parses only when
// --allow-natives-syntax is enabled; otherwise a SyntaxError.
function runNatives() {
	try {
		const fn = vm.compileFunction("return %StringParseInt('42', 10);", [], {});
		return { worked: true, value: fn() };
	} catch (error) {
		return { worked: false, error: error.constructor.name };
	}
}

emit({ phase: "before", node: process.versions.node, ...runNatives() });
let setFlagsError = null;
try {
	v8.setFlagsFromString("--allow-natives-syntax");
} catch (error) {
	setFlagsError = error.constructor.name;
}
// Under --freeze-flags-after-init the line above has already aborted the process, so this is
// unreachable; without the flag, it reports that V8 was weakened.
emit({ phase: "after", setFlagsError, ...runNatives() });
setTimeout(() => process.exit(0), 50);
