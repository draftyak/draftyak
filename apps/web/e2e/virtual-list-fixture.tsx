import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as z from "zod";
import "./fixture.css";

let violations = 0;
Object.defineProperty(window, "virtualListCspCountForTest", { get: () => violations });
Object.defineProperty(window, "virtualListUnsafeExecutedForTest", {
	get: () => Reflect.get(window, "DYTEST_virtual_unsafe") === true,
});
document.addEventListener("securitypolicyviolation", () => {
	violations++;
});
z.config({ jitless: true });
const [{ Conversation }, { ConversationList }] = await Promise.all([
	import("@draftyak/protocol/entities/conversation"),
	import("../src/inbox/ConversationList.tsx"),
]);

type Mode = "ready" | "reverse" | "empty" | "loading" | "error" | "large" | "duplicate" | "hostile";
interface Stats {
	readonly selections: number;
	readonly lastId: string | null;
	readonly retries: number;
}
declare global {
	interface Window {
		setVirtualListModeForTest?: (mode: Mode) => void;
		virtualListStatsForTest?: () => Stats;
		readonly virtualListCspCountForTest: number;
		readonly virtualListUnsafeExecutedForTest: boolean;
	}
}
const id = (value: number): string => String(value).padStart(26, "0");
const hostile =
	'<img src="https://synthetic.invalid/DYTEST-image" onerror="globalThis.DYTEST_virtual_unsafe=true">';
function email(value: number, subject = `DYTEST Conversation ${value}`) {
	return Conversation.parse({
		channel: "email",
		id: id(value),
		accountId: id(2000),
		workspaceId: null,
		assigneeUserId: null,
		archived: false,
		read: false,
		lastMessageAt: 0,
		threadId: `DYTEST-thread-${value}`,
		subject: { untrusted: true, text: subject },
		labelIds: [],
	});
}
const canonical = Array.from({ length: 1000 }, (_, index) => email(index + 1));
function Fixture(): ReactElement {
	const [mode, setMode] = useState<Mode>("ready");
	const [selected, setSelected] = useState<string | null>(id(500));
	const selections = useRef<string[]>([]);
	const retries = useRef(0);
	const items = useMemo(() => {
		if (mode === "reverse") return [...canonical].reverse();
		if (mode === "empty") return [];
		if (mode === "large") return Array.from({ length: 1500 }, (_, index) => email(index + 1));
		if (mode === "duplicate") {
			const first = canonical[0];
			if (first === undefined) throw new Error("DYTEST missing canonical row");
			return [first, first];
		}
		if (mode === "hostile") return [email(1, hostile)];
		return canonical;
	}, [mode]);
	useEffect(() => {
		const update = (value: Mode): void => {
			setMode(value);
		};
		const stats = (): Stats => ({
			selections: selections.current.length,
			lastId: selections.current.at(-1) ?? null,
			retries: retries.current,
		});
		window.setVirtualListModeForTest = update;
		window.virtualListStatsForTest = stats;
		document.documentElement.dataset.virtualListFixtureReady = "true";
		return () => {
			if (window.setVirtualListModeForTest === update) delete window.setVirtualListModeForTest;
			if (window.virtualListStatsForTest === stats) delete window.virtualListStatsForTest;
			delete document.documentElement.dataset.virtualListFixtureReady;
		};
	}, []);
	return (
		<main>
			<h1>Virtual conversation list fixture</h1>
			<ConversationList
				data={
					mode === "loading"
						? { status: "loading" }
						: mode === "error"
							? { status: "error" }
							: { status: "ready", items }
				}
				selectedConversationId={selected}
				intents={{
					selectConversation(value) {
						selections.current.push(value);
						setSelected(value);
					},
					retry() {
						retries.current++;
					},
				}}
			/>
		</main>
	);
}
const element = document.getElementById("root");
if (element === null) throw new Error("DYTEST missing virtual list root");
const root = createRoot(element);
root.render(<Fixture />);
window.addEventListener("pagehide", () => root.unmount(), { once: true });
