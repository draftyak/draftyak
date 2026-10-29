import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { serve } from "@draftyak/sdk";
import { observeProbeRequest, plugin } from "./plugin.ts";

let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
	buffered = Buffer.concat([buffered, chunk]);
	for (;;) {
		const newline = buffered.indexOf(10);
		if (newline < 0) break;
		if (newline > HOST_MAX_FRAME_BYTES) throw new Error("Synthetic probe input bound");
		const frame = buffered.subarray(0, newline);
		buffered = buffered.subarray(newline + 1);
		if (frame[0] !== 0x1e) observeProbeRequest(JSON.parse(frame.toString("utf8")));
	}
	if (buffered.length > HOST_MAX_FRAME_BYTES) throw new Error("Synthetic probe input bound");
});

serve(plugin.entry);
