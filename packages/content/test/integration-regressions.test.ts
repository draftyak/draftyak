import { describe, expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";
import { cleanText } from "../src/hygiene.ts";
import { MAX_MAIL_BYTES } from "../src/limits.ts";
import { parseMailInWorker } from "../src/worker.ts";

describe("consolidated hub security regressions", () => {
	it.each([
		'<style>.fg{color:white}.bg{background:#fff}</style><span class="fg bg">CANARY</span>',
		'<div style="color:white"><span style="background:#fff">CANARY</span></div>',
		'<div style="background:white"><span style="color:#fff">CANARY</span></div>',
		'<div style="background:white"><span style="color:#fff;background:transparent">CANARY</span></div>',
		'<span style="color:rgb(255 255 255);background:white">CANARY</span>',
		'<span style="color:#ff0000;background:red">CANARY</span>',
	])("removes text hidden by combined or equivalent color rules: %s", (html) => {
		expect(cleanHtml(`<p>Visible</p>${html}`).text).toBe("Visible");
	});
	it.each(["On Tuesday Pat wrote:\nCANARY", "-----Original Message-----\nCANARY"])(
		"applies the quoted-history budget to mail reply markers: %s",
		(quoted) =>
			expect(cleanText(`Current reply\n${quoted}`, { quotedHistoryChars: 0 }).text).toBe(
				"Current reply",
			),
	);
	it("rejects raw mail above the 35 MiB MIME ceiling before a worker starts", async () => {
		expect(MAX_MAIL_BYTES).toBe(36_700_160);
		await expect(
			parseMailInWorker(new Uint8Array(MAX_MAIL_BYTES + 1), {
				provider: "generic",
				ownerAddresses: [],
			}),
		).rejects.toMatchObject({ code: "INPUT_LIMIT" });
	});
});
