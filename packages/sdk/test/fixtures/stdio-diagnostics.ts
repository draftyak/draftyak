const mode = process.argv[2];
if (mode === "exit") {
	process.stderr.write("synthetic startup failure\n");
	process.exitCode = 19;
} else if (mode === "delayed") {
	process.stderr.write("waiting for startup\n");
	process.stdin.resume();
} else {
	process.stdin.once("data", () => {
		if (mode === "wrong-id") process.stdout.write('{"id":99,"result":{}}\n');
		else if (mode === "incomplete") process.stdout.write('{"id":1,"result":{}}\n');
		else {
			process.stderr.write("synthetic detail 🚀 ".repeat(1000), () => {
				process.stdout.write(`${"invalid 🚀 ".repeat(1000)}\n`);
			});
		}
	});
}
