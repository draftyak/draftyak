// The main window's script. It reads the autostart state through the pinned npm packages, which
// scripts/stage-sidecar.ts copies into ./vendor/ for the import map in index.html.
import { isEnabled } from "@tauri-apps/plugin-autostart";

const output = document.getElementById("autostart");
// For the spike's Rust-driven checks, which run in this page.
window.dySpike = Object.freeze({ autostartEnabled: isEnabled });
isEnabled().then(
	(enabled) => {
		output.textContent = enabled ? "on" : "off";
	},
	(error) => {
		output.textContent = `unavailable (${error})`;
	},
);
