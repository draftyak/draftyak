import { type ReactElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as z from "zod";
import "./fixture.css";

declare global {
	interface Window {
		setFlagsForTest?: (flags: unknown) => void;
	}
}

z.config({ jitless: true });
const { FlagList } = await import("../src/index.ts");

function Fixture(): ReactElement {
	const [flags, setFlags] = useState<unknown>([]);

	useEffect(() => {
		const update = (next: unknown): void => {
			setFlags(() => next);
		};
		window.setFlagsForTest = update;
		document.documentElement.dataset.fixtureReady = "true";
		return () => {
			if (window.setFlagsForTest === update) {
				delete window.setFlagsForTest;
				delete document.documentElement.dataset.fixtureReady;
			}
		};
	}, []);

	return (
		<main>
			<h1>Flag rendering fixture</h1>
			<input aria-label="Before flags" type="text" value="Before flags" readOnly />
			<section aria-label="Flag display">
				<FlagList flags={flags} />
			</section>
			<input aria-label="After flags" type="text" value="After flags" readOnly />
		</main>
	);
}

const mount = document.getElementById("root");
if (mount === null) throw new Error("Missing flag fixture mount");

const root = createRoot(mount);
root.render(<Fixture />);
window.addEventListener("pagehide", () => root.unmount(), { once: true });
