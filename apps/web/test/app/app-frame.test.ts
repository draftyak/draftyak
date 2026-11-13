import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, Fragment, type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFrame, type AppFrameProps, type AppView } from "../../src/app/AppFrame.tsx";

const VIEWS = [
	["inbox", "Inbox"],
	["review", "Review"],
	["settings", "Settings"],
] as const;
const CHILD = "DYTEST controlled child content";
const FAILURE = "Navigation unavailable. Try again.";
const CANARY = "DYTEST private navigation failure <img src=x onerror=alert(1)>";
function props(overrides: Partial<AppFrameProps> = {}): AppFrameProps {
	return {
		activeView: "inbox",
		onNavigate: vi.fn(),
		children: createElement("p", null, CHILD),
		...overrides,
	};
}
function view(input: AppFrameProps): ReactElement {
	return createElement(AppFrame, input);
}
function navigation(): HTMLElement {
	return screen.getByRole("navigation", { name: "Primary views" });
}
function selected(label: string): void {
	const buttons = within(navigation()).getAllByRole("button");
	expect(buttons).toHaveLength(3);
	for (const button of buttons)
		expect(button.getAttribute("aria-current")).toBe(button.textContent === label ? "page" : null);
}
function Counter(): ReactElement {
	const [count, setCount] = useState(0);
	return createElement(
		"section",
		null,
		createElement("output", { "aria-label": "Child count" }, String(count)),
		createElement(
			"button",
			{ type: "button", onClick: () => setCount((value) => value + 1) },
			"Increment child",
		),
	);
}
function count(value: number): void {
	expect(screen.getByLabelText("Child count").textContent).toBe(String(value));
}
function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (reason: unknown) => void;
} {
	let resolve: () => void = () => {
		throw new Error("DYTEST unresolved deferred");
	};
	let reject: (reason: unknown) => void = () => {
		throw new Error("DYTEST unresolved deferred");
	};
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("AppFrame", () => {
	it.each(VIEWS)(
		"renders only the controlled %s current view with a single product heading",
		(activeView, label) => {
			const input = props({ activeView });
			render(view(input));
			expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
			expect(screen.getByRole("heading", { level: 1, name: "DraftYak" })).toBeDefined();
			expect(
				within(navigation())
					.getAllByRole("button")
					.map((button) => button.textContent),
			).toEqual(["Inbox", "Review", "Settings"]);
			selected(label);
			expect(
				within(screen.getByRole("main", { name: "Workspace" })).getByText(CHILD),
			).toBeDefined();
			expect(input.onNavigate).not.toHaveBeenCalled();
		},
	);

	it("emits exactly the three literal navigation intents and keeps void results controlled", () => {
		const input = props();
		render(view(input));
		for (const [index, [target, label]] of VIEWS.entries()) {
			fireEvent.click(within(navigation()).getByRole("button", { name: label }));
			expect(input.onNavigate).toHaveBeenNthCalledWith(index + 1, target);
			selected("Inbox");
			expect(screen.getByText(CHILD)).toBeDefined();
		}
		expect(input.onNavigate).toHaveBeenCalledTimes(3);
	});

	it("changes current-view metadata only on parent props, without emitting another intent", () => {
		const input = props();
		const result = render(view(input));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Settings" }));
		selected("Inbox");
		result.rerender(view({ ...input, activeView: "settings" }));
		selected("Settings");
		result.rerender(view({ ...input, activeView: "review" }));
		selected("Review");
		expect(input.onNavigate).toHaveBeenCalledExactlyOnceWith("settings");
	});

	it("treats a pending and then resolved real promise as an intent, not a route acknowledgement", async () => {
		const request = deferred();
		const onNavigate = vi.fn(() => request.promise);
		render(view(props({ onNavigate, children: createElement(Counter) })));
		fireEvent.click(screen.getByRole("button", { name: "Increment child" }));
		count(1);
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		selected("Inbox");
		count(1);
		expect(
			(within(navigation()).getByRole("button", { name: "Settings" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		await act(async () => {
			request.resolve();
		});
		selected("Inbox");
		count(1);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(onNavigate).toHaveBeenCalledExactlyOnceWith("review");
	});

	it("preserves child component state through valid controlled rerenders and navigation errors", () => {
		const onNavigate = vi.fn(() => {
			throw new Error(CANARY);
		});
		const input = props({ onNavigate, children: createElement(Counter) });
		const result = render(view(input));
		fireEvent.click(screen.getByRole("button", { name: "Increment child" }));
		count(1);
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		expect(screen.getByRole("alert").textContent).toBe(FAILURE);
		count(1);
		result.rerender(view({ ...input, activeView: "review", children: createElement(Counter) }));
		selected("Review");
		count(1);
		expect(screen.queryByRole("alert")).toBeNull();
		result.rerender(
			view({
				...input,
				activeView: "inbox",
				onNavigate: vi.fn(),
				children: createElement(Counter),
			}),
		);
		selected("Inbox");
		count(1);
	});

	it.each([
		["Error", (): unknown => new Error(CANARY)],
		["string", (): unknown => CANARY],
		[
			"hostile object",
			(): unknown =>
				Object.defineProperty({}, "message", {
					get: () => {
						throw new Error(CANARY);
					},
				}),
		],
	] as const)("contains a synchronous %s failure using only fixed feedback", (_name, failure) => {
		const onNavigate = vi.fn(() => {
			throw failure();
		});
		const result = render(view(props({ onNavigate })));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		expect(screen.getByRole("alert").textContent).toBe(FAILURE);
		expect(screen.queryByText(/DYTEST private navigation failure/)).toBeNull();
		expect(result.container.querySelector("img,script,iframe,object")).toBeNull();
		selected("Inbox");
		expect(screen.getByText(CHILD)).toBeDefined();
		expect(onNavigate).toHaveBeenCalledExactlyOnceWith("review");
	});

	it("contains a real async rejection and clears its error when a new intent begins", async () => {
		const first = deferred(),
			second = deferred();
		const onNavigate = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		render(view(props({ onNavigate })));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		await act(async () => {
			first.reject(new Error(CANARY));
		});
		expect(screen.getByRole("alert").textContent).toBe(FAILURE);
		expect(screen.queryByText(/DYTEST private navigation failure/)).toBeNull();
		fireEvent.click(within(navigation()).getByRole("button", { name: "Settings" }));
		expect(screen.queryByRole("alert")).toBeNull();
		selected("Inbox");
		await act(async () => {
			second.resolve();
		});
		expect(screen.queryByRole("alert")).toBeNull();
		selected("Inbox");
		expect(onNavigate).toHaveBeenNthCalledWith(1, "review");
		expect(onNavigate).toHaveBeenNthCalledWith(2, "settings");
	});

	it("suppresses an old rejection after the controlled view changes", async () => {
		const request = deferred();
		const input = props({ onNavigate: vi.fn(() => request.promise) });
		const result = render(view(input));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		result.rerender(view({ ...input, activeView: "review" }));
		await act(async () => {
			request.reject(new Error(CANARY));
		});
		selected("Review");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("does not revive an old rejection when parent changes views away and back", async () => {
		const request = deferred();
		const input = props({ onNavigate: vi.fn(() => request.promise) });
		const result = render(view(input));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		result.rerender(view({ ...input, activeView: "settings" }));
		result.rerender(view(input));
		await act(async () => {
			request.reject(new Error(CANARY));
		});
		selected("Inbox");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("invalidates a pending old callback when parent supplies a new callback", async () => {
		const request = deferred(),
			oldNavigate = vi.fn(() => request.promise),
			currentNavigate = vi.fn();
		const input = props({ onNavigate: oldNavigate });
		const result = render(view(input));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		result.rerender(view({ ...input, onNavigate: currentNavigate }));
		await act(async () => {
			request.reject(new Error(CANARY));
		});
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(within(navigation()).getByRole("button", { name: "Settings" }));
		expect(oldNavigate).toHaveBeenCalledExactlyOnceWith("review");
		expect(currentNavigate).toHaveBeenCalledExactlyOnceWith("settings");
		selected("Inbox");
	});

	it("lets a newer intent supersede an older pending rejection", async () => {
		const first = deferred(),
			second = deferred();
		const onNavigate = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		render(view(props({ onNavigate })));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Settings" }));
		await act(async () => {
			first.reject(new Error(CANARY));
		});
		expect(screen.queryByRole("alert")).toBeNull();
		await act(async () => {
			second.reject(new Error(CANARY));
		});
		expect(screen.getByRole("alert").textContent).toBe(FAILURE);
		selected("Inbox");
		expect(onNavigate).toHaveBeenCalledTimes(2);
	});

	it("handles a late rejection after unmount without leaking it into another frame", async () => {
		const request = deferred();
		const oldNavigate = vi.fn(() => request.promise);
		const old = render(view(props({ onNavigate: oldNavigate })));
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		old.unmount();
		const current = props({ activeView: "settings" });
		render(view(current));
		await act(async () => {
			request.reject(new Error(CANARY));
		});
		expect(screen.queryByRole("alert")).toBeNull();
		selected("Settings");
		expect(current.onNavigate).not.toHaveBeenCalled();
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["object", {}],
		["array", ["inbox"]],
		["boxed string", Object("inbox")],
		["number", 0],
		["boolean", true],
		["empty", ""],
		["unknown route", "scheduled"],
		["wrong case", "INBOX"],
	] as const)(
		"refuses a malformed %s view without inventing a current child route",
		(_name, activeView) => {
			const input = props({ activeView: activeView as unknown as AppView });
			render(view(input));
			expect(screen.getByRole("alert").textContent).toBe("View unavailable");
			expect(screen.queryByText(CHILD)).toBeNull();
			for (const button of within(navigation()).getAllByRole("button"))
				expect(button.getAttribute("aria-current")).toBeNull();
			expect(input.onNavigate).not.toHaveBeenCalled();
			fireEvent.click(within(navigation()).getByRole("button", { name: "Settings" }));
			expect(input.onNavigate).toHaveBeenCalledExactlyOnceWith("settings");
			expect(screen.queryByText(CHILD)).toBeNull();
		},
	);

	it("does not coerce a hostile active-view value or expose its error", () => {
		const coerce = vi.fn(() => {
			throw new Error(CANARY);
		});
		const value = { toString: coerce, [Symbol.toPrimitive]: coerce };
		render(view(props({ activeView: value as unknown as AppView })));
		expect(screen.getByRole("alert").textContent).toBe("View unavailable");
		expect(screen.queryByText(CHILD)).toBeNull();
		expect(screen.queryByText(/DYTEST private navigation failure/)).toBeNull();
		expect(coerce).not.toHaveBeenCalled();
	});

	it("retains native button keyboard activation without overriding Enter or Space", () => {
		const input = props();
		render(view(input));
		let call = 0;
		for (const [target, label] of VIEWS) {
			const button = within(navigation()).getByRole("button", { name: label });
			expect(button.tagName).toBe("BUTTON");
			expect(button.getAttribute("type")).toBe("button");
			for (const key of ["Enter", " "]) {
				const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
				fireEvent(button, event);
				expect(event.defaultPrevented).toBe(false);
				fireEvent.click(button, { detail: 0 });
				expect(input.onNavigate).toHaveBeenNthCalledWith(++call, target);
			}
		}
		expect(input.onNavigate).toHaveBeenCalledTimes(6);
		selected("Inbox");
	});

	it("wires the local skip link to the actual focusable main without navigating", () => {
		const input = props();
		render(view(input));
		const link = screen.getByRole("link", { name: "Skip to content" });
		const main = screen.getByRole("main", { name: "Workspace" });
		expect(main.id.length).toBeGreaterThan(0);
		expect(main.getAttribute("tabindex")).toBe("-1");
		expect(link.getAttribute("href")).toBe("#" + main.id);
		expect(document.getElementById(main.id)).toBe(main);
		const location = window.location.href;
		const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 });
		fireEvent(link, click);
		expect(click.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(main);
		expect(window.location.href).toBe(location);
		expect(input.onNavigate).not.toHaveBeenCalled();
	});

	it("gives separate frame instances distinct skip targets", () => {
		render(createElement(Fragment, null, view(props()), view(props({ activeView: "review" }))));
		const mains = screen.getAllByRole("main", { name: "Workspace" });
		const links = screen.getAllByRole("link", { name: "Skip to content" });
		expect(mains).toHaveLength(2);
		expect(links).toHaveLength(2);
		const first = mains[0],
			second = mains[1];
		if (!first || !second) throw new Error("DYTEST two actual main targets required");
		expect(first.id).not.toBe(second.id);
		expect(links[0]?.getAttribute("href")).toBe("#" + first.id);
		expect(links[1]?.getAttribute("href")).toBe("#" + second.id);
		const secondLink = links[1];
		if (!secondLink) throw new Error("DYTEST second skip link required");
		fireEvent.click(secondLink);
		expect(document.activeElement).toBe(second);
	});

	it("keeps hostile child strings inert through the genuine React child slot", () => {
		const hostile =
			'<img src=x onerror="alert(1)"><a href="https://example.invalid">DYTEST child</a>';
		const result = render(view(props({ children: hostile })));
		expect(
			within(screen.getByRole("main", { name: "Workspace" })).getByText(hostile, { exact: true }),
		).toBeDefined();
		expect(result.container.querySelector("main img,main a,script,iframe,object")).toBeNull();
	});

	it("does not implement URL, network or persistence effects for navigation or promise resolution", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
			throw new Error("DYTEST shell network forbidden");
		});
		const push = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
		const replace = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
		const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
		const request = deferred();
		render(view(props({ onNavigate: vi.fn(() => request.promise) })));
		const location = window.location.href;
		fireEvent.click(within(navigation()).getByRole("button", { name: "Review" }));
		await act(async () => {
			request.resolve();
		});
		selected("Inbox");
		expect(window.location.href).toBe(location);
		expect(fetch).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
		expect(storage).not.toHaveBeenCalled();
	});
});
