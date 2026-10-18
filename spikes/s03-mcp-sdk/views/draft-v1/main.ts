import "./jitless.ts";
import { App } from "@modelcontextprotocol/ext-apps";
import { renderDraft } from "./render.ts";

// Passive (plan §6 MCP Apps): the view renders the tool result its host hands it and sends nothing
// but the handshake and its size changes; it calls no tool, reads no resource and opens no link.
const app = new App({ name: "draftyak-draft-v1", version: "1.0.0" });
app.addEventListener("toolresult", (result) => renderDraft(document, result));
app.connect().catch(() => {
	const status = document.getElementById("status");
	if (status !== null) status.textContent = "Open this view from an MCP Apps host.";
});
