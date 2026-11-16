import { parentPort } from "node:worker_threads";
import { cleanHtml } from "./html.ts";
import { cleanText } from "./hygiene.ts";
import { ContentError } from "./limits.ts";
import { parseMailCore } from "./mail-parser.ts";
import type { ContentJob } from "./worker.ts";

parentPort?.once("message", async (job: ContentJob) => {
	try {
		const value =
			job.kind === "mail"
				? await parseMailCore(job.raw, job.evidence)
				: job.kind === "html"
					? cleanHtml(job.source, job.options)
					: job.kind === "text"
						? cleanText(job.source, job.options)
						: undefined;
		if (value === undefined) throw new ContentError("INVALID_INPUT");
		parentPort?.postMessage({ ok: true, value });
	} catch (error) {
		parentPort?.postMessage({
			ok: false,
			code: error instanceof ContentError ? error.code : "WORKER_FAILED",
		});
	} finally {
		parentPort?.close();
	}
});

// A ready heap has loaded all parser modules and installed its one-job listener.
parentPort?.postMessage({ ready: true });
