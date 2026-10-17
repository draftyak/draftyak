// Memory the hub-side RSS watchdog must catch (plan §4 Health, §9.2 memory row): ArrayBuffers and
// WebAssembly.Memory escape --max-old-space-size. Modes (argv[2]):
//   arraybuffer, wasm            grow 64 MiB per 60 ms, touching every page, up to 1200 MiB
//   arraybuffer-fast, wasm-fast  grow as fast as possible up to 1536 MiB, report the time, hold
//   untouched                    allocate 768 MiB once without touching it, and hold
//   anything else                idle
// Reports on stdout (##DYS2B##); every mode holds until killed or 60 s pass.
import fs from "node:fs";

const mode = process.argv[2] ?? "idle";
const MIB = 1 << 20;
const STEP = 64 * MIB;
const PAGE = 65536;
const emit = (object) => fs.writeSync(1, `##DYS2B##${JSON.stringify({ mode, ...object })}\n`);
const started = performance.now();
const kind = mode.startsWith("wasm") ? "wasm" : "arraybuffer";
const fast = mode.endsWith("-fast");
const ceiling = (fast ? 1536 : 1200) * MIB;
const held = [];
let memory;
let grown = 0;

function step() {
	try {
		if (kind === "wasm") {
			memory ??= new WebAssembly.Memory({ initial: 0, maximum: ceiling / PAGE });
			memory.grow(STEP / PAGE);
			new Uint8Array(memory.buffer).fill(1, grown);
		} else {
			const block = Buffer.allocUnsafe(STEP);
			block.fill(1);
			held.push(block);
		}
		grown += STEP;
	} catch (error) {
		emit({ event: "alloc-error", name: error.constructor.name, grownMiB: grown / MIB });
		return false;
	}
	return true;
}

if (mode === "untouched") {
	held.push(new ArrayBuffer(768 * MIB));
	emit({ event: "allocated", untouchedMiB: 768 });
} else if (mode === "arraybuffer" || mode === "wasm") {
	const tick = () => {
		if (step() && grown < ceiling) setTimeout(tick, 60);
	};
	tick();
} else if (fast) {
	while (grown < ceiling && step()) {}
	emit({ event: "ceiling", grownMiB: grown / MIB, ms: Math.round(performance.now() - started) });
}
setTimeout(() => process.exit(0), 60_000);
