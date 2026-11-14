import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import { types } from "node:util";
import {
	BootstrapRequest,
	BootstrapStatus,
	checkApiErrorBytes,
	checkRouteLength,
	checkRouteRequestBytes,
	checkRouteResponseBytes,
	DEVICE_API_ERRORS,
	DeviceStatus,
	PairingWindow,
	PairingWindowRequest,
	SendReview,
	SyncPause,
} from "@draftyak/protocol/device-api";
import {
	checkHubRuntimeRequestBytes,
	checkHubRuntimeResponseBytes,
	checkHubRuntimeRouteLength,
} from "@draftyak/protocol/hub-runtime";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import {
	decodePairingPayload,
	MAX_CLAIM_BYTES,
	MAX_REVEAL_BYTES,
	PairingRefusal,
	type PairingRefusalCode,
	PairingResult,
	readPairingClaim,
	readPairingReveal,
} from "@draftyak/protocol/pairing";
import { Ulid } from "@draftyak/protocol/scalars";
import { ScheduledSummary } from "@draftyak/protocol/scheduled-summary";
import { deviceApiError } from "../../authz/errors.ts";
import { DevicePairingRefusal } from "../../identity/devices-pairing.ts";

export type NativeDeviceRequest =
	| { readonly route: "status" }
	| { readonly route: "scheduling-outbox" }
	| { readonly route: "send-review"; readonly id: string }
	| { readonly route: "bootstrap"; readonly body: BootstrapRequest }
	| { readonly route: "sync-pause"; readonly body: SyncPause }
	| { readonly route: "pairing-window"; readonly body: PairingWindowRequest }
	| { readonly route: "pairing-claim"; readonly body: Uint8Array }
	| { readonly route: "pairing-reveal"; readonly body: Uint8Array };
export type NativeDeviceRouteResult =
	| DeviceStatus
	| SendReview
	| ScheduledSummary
	| SyncPause
	| PairingWindow
	| PairingResult
	| undefined;

type Route = NativeDeviceRequest["route"];
type Phase = "initial" | "opener" | "reveal";
interface Retention {
	readonly phase: "opener" | "reveal";
	readonly deadline: number;
}
const HEADER_BYTES = 8192;
const HEADER_COUNT = 16;
const REQUEST_BYTES = 1024;
const SEND_REVIEW_PREFIX = "/device/v1/outbox/";
const SEND_REVIEW_SUFFIX = "/snapshot";
const REQUEST_MS = 10_000;
const CLOSE_GRACE_MS = 250;
// A transport bound from the public five-minute contract, never a new native window lifetime.
const PAIRING_WINDOW_MS = 300_000;
const attached = new WeakSet<TLSSocket>();

type RefusalCode =
	| "INVALID_REQUEST"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "TOO_LARGE"
	| "UNAVAILABLE"
	| PairingRefusalCode;
class RouteRefusal extends Error {
	readonly code: RefusalCode;
	constructor(code: RefusalCode) {
		super(code);
		this.code = code;
	}
}
const refuse = (code: RefusalCode): never => {
	throw new RouteRefusal(code);
};

function headers(request: IncomingMessage, port: number): ReadonlyMap<string, string> {
	if (request.httpVersion !== "1.1" || request.rawHeaders.length % 2 !== 0)
		return refuse("INVALID_REQUEST");
	if (request.rawHeaders.length / 2 > HEADER_COUNT) return refuse("TOO_LARGE");
	const captured = new Map<string, string>();
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		const name = request.rawHeaders[index]?.toLowerCase();
		const value = request.rawHeaders[index + 1];
		if (!name || value === undefined || captured.has(name)) return refuse("INVALID_REQUEST");
		captured.set(name, value);
	}
	if (captured.get("host") !== `127.0.0.1:${port}` || captured.has("origin"))
		return refuse("FORBIDDEN");
	for (const name of captured.keys()) {
		if (
			name === "forwarded" ||
			name === "via" ||
			name === "x-real-ip" ||
			name === "x-original-url" ||
			name === "x-rewrite-url" ||
			name.startsWith("x-forwarded-") ||
			name.startsWith("proxy-")
		)
			return refuse("FORBIDDEN");
	}
	if (captured.has("transfer-encoding") || captured.has("expect") || captured.has("upgrade"))
		return refuse("INVALID_REQUEST");
	return captured;
}

function sendReviewId(target: string | undefined): string {
	if (
		target === undefined ||
		!target.startsWith(SEND_REVIEW_PREFIX) ||
		!target.endsWith(SEND_REVIEW_SUFFIX)
	)
		return refuse("NOT_FOUND");
	const id = Ulid.safeParse(target.slice(SEND_REVIEW_PREFIX.length, -SEND_REVIEW_SUFFIX.length));
	if (!id.success) return refuse("INVALID_REQUEST");
	return id.data;
}

function match(request: IncomingMessage): Route {
	const target = request.url;
	if (target === undefined || !target.startsWith("/") || target.startsWith("//"))
		return refuse("FORBIDDEN");
	if (target === "/device/v1/status") {
		if (request.method !== "GET") return refuse("INVALID_REQUEST");
		return "status";
	}
	if (target === "/device/v1/scheduling/outbox") {
		if (request.method !== "GET") return refuse("INVALID_REQUEST");
		return "scheduling-outbox";
	}
	if (target === "/device/v1/sync/pause") {
		if (request.method !== "POST") return refuse("INVALID_REQUEST");
		return "sync-pause";
	}
	if (target === "/device/v1/bootstrap") {
		if (request.method !== "POST") return refuse("INVALID_REQUEST");
		return "bootstrap";
	}
	if (target.startsWith(SEND_REVIEW_PREFIX) && target.endsWith(SEND_REVIEW_SUFFIX)) {
		if (request.method !== "GET") return refuse("INVALID_REQUEST");
		sendReviewId(target);
		return "send-review";
	}
	if (target === "/device/v1/pairing/windows") {
		if (request.method !== "POST") return refuse("INVALID_REQUEST");
		return "pairing-window";
	}
	if (target === "/pair/v1/claim") {
		if (request.method !== "POST") return refuse("INVALID_REQUEST");
		return "pairing-claim";
	}
	if (target === "/pair/v1/reveal") {
		if (request.method !== "POST") return refuse("INVALID_REQUEST");
		return "pairing-reveal";
	}
	return refuse("NOT_FOUND");
}

function bodyRefusal(route: Route): RefusalCode {
	if (route === "pairing-claim") return "PAIR_CLAIM_INVALID";
	if (route === "pairing-reveal") return "PAIR_REVEAL_INVALID";
	return "TOO_LARGE";
}

function contentLength(captured: ReadonlyMap<string, string>, limit: number, route: Route): number {
	const text = captured.get("content-length");
	if (text === undefined || !/^(?:0|[1-9][0-9]*)$/.test(text)) {
		if (route === "pairing-claim" || route === "pairing-reveal") return refuse(bodyRefusal(route));
		return refuse("INVALID_REQUEST");
	}
	if (text.length > 4 || Number(text) > limit) return refuse(bodyRefusal(route));
	return Number(text);
}

function receive(
	request: IncomingMessage,
	expected: number,
	limit: number,
	tooLarge: RefusalCode,
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const cleanup = (): void => {
			request.off("data", data);
			request.off("end", end);
			request.off("aborted", aborted);
			request.off("error", error);
			request.off("close", close);
		};
		const fail = (reason: unknown): void => {
			if (settled) return;
			settled = true;
			request.pause();
			cleanup();
			reject(reason);
		};
		const data = (chunk: unknown): void => {
			if (!Buffer.isBuffer(chunk)) {
				fail(new RouteRefusal("INVALID_REQUEST"));
				return;
			}
			total += chunk.byteLength;
			if (total > limit || total > expected) {
				fail(new RouteRefusal(tooLarge));
				return;
			}
			chunks.push(chunk);
		};
		const end = (): void => {
			if (settled) return;
			if (!request.complete || total !== expected) {
				fail(new RouteRefusal("INVALID_REQUEST"));
				return;
			}
			settled = true;
			cleanup();
			resolve(Buffer.concat(chunks, total));
		};
		const aborted = (): void => fail(new RouteRefusal("INVALID_REQUEST"));
		const error = (): void => fail(new RouteRefusal("INVALID_REQUEST"));
		const close = (): void => aborted();
		request.on("data", data);
		request.once("end", end);
		request.once("aborted", aborted);
		request.once("error", error);
		request.once("close", close);
	});
}

function errorBody(code: string): { readonly status: number; readonly body: Buffer } {
	const pairing = PairingRefusal.safeParse({ code });
	if (pairing.success)
		return { status: 403, body: Buffer.from(canonicalize(pairing.data), "utf8") };
	const status = DEVICE_API_ERRORS[code];
	if (status === undefined) return errorBody("UNAVAILABLE");
	const body = Buffer.from(JSON.stringify({ code }), "utf8");
	if (!checkApiErrorBytes(body, status)) return errorBody("UNAVAILABLE");
	return { status, body };
}

function failureCode(error: unknown): string {
	try {
		if (types.isProxy(error)) return "UNAVAILABLE";
		if (error instanceof RouteRefusal) return error.code;
		if (error instanceof DevicePairingRefusal) {
			const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
			const parsed = PairingRefusal.safeParse({ code });
			if (parsed.success) return parsed.data.code;
		}
		return deviceApiError(error);
	} catch {
		return "UNAVAILABLE";
	}
}

/** Internal composition only: the context supplies its original TLS socket and private dispatch. */
export function attachNativeDeviceHttp(
	socket: TLSSocket,
	dispatch: (request: NativeDeviceRequest) => Promise<NativeDeviceRouteResult>,
	nativeEvents?: (request: IncomingMessage, socket: TLSSocket, head: Buffer) => void,
): void {
	if (!(socket instanceof TLSSocket)) return;
	if (
		!socket.encrypted ||
		socket.destroyed ||
		attached.has(socket) ||
		typeof dispatch !== "function"
	) {
		socket.destroy();
		return;
	}
	const port = socket.localPort;
	if (!Number.isSafeInteger(port) || port === undefined || port <= 0 || port > 65535) {
		socket.destroy();
		return;
	}
	attached.add(socket);
	const born = performance.now();
	let phase: Phase = "initial";
	let retainedUntil: number | undefined;
	let closed = false;
	let upgraded = false;
	let ending = false;
	let inFlight = false;
	let responding = false;
	let current: ServerResponse | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	const destroy = (): void => {
		if (!socket.destroyed) socket.destroy();
	};
	const finishSocket = (): void => {
		if (upgraded) return;
		closeTimer ??= setTimeout(destroy, CLOSE_GRACE_MS);
		try {
			if (!socket.writableEnded) socket.end();
		} catch {
			destroy();
		}
	};
	const arm = (deadline: number): void => {
		if (upgraded) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(
			() => {
				if (upgraded) return;
				if (ending || responding || (!inFlight && phase !== "initial")) destroy();
				else failure("UNAVAILABLE");
			},
			Math.max(0, Math.ceil(deadline - performance.now())),
		);
	};
	const send = (
		response: ServerResponse,
		status: number,
		body: Buffer | undefined,
		retention?: Retention,
	): void => {
		response.once("error", destroy);
		if (
			upgraded ||
			closed ||
			ending ||
			responding ||
			socket.destroyed ||
			!socket.writable ||
			response.headersSent
		) {
			destroy();
			return;
		}
		responding = true;
		ending = retention === undefined;
		response.shouldKeepAlive = retention !== undefined;
		try {
			const output: Record<string, string | number> = {
				connection: retention === undefined ? "close" : "keep-alive",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			};
			if (body !== undefined) {
				output["content-type"] = "application/json; charset=utf-8";
				output["content-length"] = body.byteLength;
			}
			response.writeHead(status, output);
			response.once("finish", () => {
				responding = false;
				if (!retention) return finishSocket();
				phase = retention.phase;
				retainedUntil = retention.deadline;
				inFlight = false;
				current = undefined;
				arm(retention.deadline);
			});
			response.end(body);
		} catch {
			destroy();
		}
	};
	const failure = (code: string, response = current): void => {
		if (upgraded) {
			destroy();
			return;
		}
		if (closed || socket.destroyed) return;
		const { status, body } = errorBody(code);
		if (response) {
			send(response, status, body);
			return;
		}
		if (ending || responding || !socket.writable) {
			destroy();
			return;
		}
		ending = true;
		const head = [
			`HTTP/1.1 ${status} Error`,
			"Content-Type: application/json; charset=utf-8",
			`Content-Length: ${body.byteLength}`,
			"Connection: close",
			"Cache-Control: no-store",
			"",
			"",
		].join("\r\n");
		closeTimer ??= setTimeout(destroy, CLOSE_GRACE_MS);
		try {
			socket.end(Buffer.concat([Buffer.from(head, "ascii"), body]));
		} catch {
			destroy();
		}
	};
	const server = createServer({ maxHeaderSize: HEADER_BYTES, insecureHTTPParser: false });
	server.maxHeadersCount = 0;
	// Our phase deadlines replace automatic non-JSON timeout responses.
	server.requestTimeout = 0;
	server.headersTimeout = 0;
	server.timeout = 0;
	server.keepAliveTimeout = 0;
	socket.once("close", () => {
		closed = true;
		if (timer !== undefined) clearTimeout(timer);
		if (closeTimer !== undefined) clearTimeout(closeTimer);
	});
	socket.on("error", destroy);
	server.on("error", destroy);
	server.on("clientError", (error, stream) => {
		if (stream !== socket) return destroy();
		failure(
			(error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW"
				? "TOO_LARGE"
				: "INVALID_REQUEST",
		);
	});
	server.on("checkContinue", (_request, response) => failure("INVALID_REQUEST", response));
	server.on("checkExpectation", (_request, response) => failure("INVALID_REQUEST", response));
	server.on("upgrade", (request, stream, head) => {
		if (
			stream !== socket ||
			request.socket !== socket ||
			!Buffer.isBuffer(head) ||
			upgraded ||
			inFlight ||
			responding ||
			ending ||
			closed ||
			socket.destroyed ||
			!socket.writable ||
			current !== undefined ||
			phase !== "initial" ||
			performance.now() >= born + REQUEST_MS
		)
			return destroy();
		if (typeof nativeEvents !== "function") return failure("FORBIDDEN");
		upgraded = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (closeTimer !== undefined) {
			clearTimeout(closeTimer);
			closeTimer = undefined;
		}
		try {
			nativeEvents(request, socket, head);
		} catch {
			destroy();
		}
	});
	server.on("connect", () => failure("FORBIDDEN"));
	server.on("request", (request, response) => {
		response.once("error", destroy);
		request.once("error", destroy);
		if (upgraded || inFlight || responding || ending || closed || phase === "opener")
			return destroy();
		inFlight = true;
		current = response;
		arm(Math.min(performance.now() + REQUEST_MS, retainedUntil ?? Infinity));
		const handle = async (): Promise<void> => {
			const captured = headers(request, port);
			const target = request.url;
			const route = match(request);
			if (phase === "reveal" && route !== "pairing-reveal") return refuse("FORBIDDEN");
			if (phase === "initial" && route === "pairing-reveal") return refuse("PAIR_WINDOW_CLOSED");
			if (route === "pairing-window" || route === "pairing-claim") {
				const connection = captured.get("connection");
				if (connection !== undefined && connection !== "keep-alive")
					return refuse("INVALID_REQUEST");
			}
			let parsed: NativeDeviceRequest;
			if (route === "status" || route === "send-review" || route === "scheduling-outbox") {
				if (captured.has("content-length")) return refuse("INVALID_REQUEST");
				const bytes = await receive(request, 0, 0, "TOO_LARGE");
				const absent =
					route === "scheduling-outbox"
						? checkHubRuntimeRequestBytes(route, undefined)
						: checkRouteRequestBytes(route, undefined);
				if (bytes.byteLength !== 0 || !absent) return refuse("INVALID_REQUEST");
				parsed =
					route === "send-review"
						? Object.freeze({ route, id: sendReviewId(target) })
						: Object.freeze({ route });
			} else {
				const limit =
					route === "pairing-claim"
						? MAX_CLAIM_BYTES
						: route === "pairing-reveal"
							? MAX_REVEAL_BYTES
							: REQUEST_BYTES;
				const bytes = await receive(
					request,
					contentLength(captured, limit, route),
					limit,
					bodyRefusal(route),
				);
				if (route === "sync-pause") {
					if (!checkRouteRequestBytes(route, bytes)) return refuse("INVALID_REQUEST");
					const body = SyncPause.safeParse(parseStrict(bytes));
					if (!body.success) return refuse("INVALID_REQUEST");
					parsed = Object.freeze({ route, body: Object.freeze(body.data) });
				} else if (route === "bootstrap") {
					if (!checkRouteRequestBytes(route, bytes)) return refuse("INVALID_REQUEST");
					const body = BootstrapRequest.safeParse(parseStrict(bytes));
					if (!body.success) return refuse("INVALID_REQUEST");
					parsed = Object.freeze({ route, body: Object.freeze(body.data) });
				} else if (route === "pairing-window") {
					if (!checkRouteRequestBytes(route, bytes)) return refuse("INVALID_REQUEST");
					const body = PairingWindowRequest.safeParse(parseStrict(bytes));
					if (!body.success) return refuse("INVALID_REQUEST");
					parsed = Object.freeze({ route, body: Object.freeze(body.data) });
				} else {
					try {
						if (route === "pairing-claim") readPairingClaim(bytes);
						else readPairingReveal(bytes);
					} catch {
						return refuse(bodyRefusal(route));
					}
					parsed = Object.freeze({ route, body: bytes });
				}
			}
			if (closed || ending || socket.destroyed) return;
			const operationStarted = performance.now();
			const result = await dispatch(parsed);
			if (closed || ending || socket.destroyed) return;
			if (route === "pairing-reveal") {
				if (result !== undefined) return refuse("UNAVAILABLE");
				return send(response, 204, undefined);
			}
			if (route === "send-review" && result === undefined) return refuse("NOT_FOUND");
			const checked =
				route === "status"
					? DeviceStatus.safeParse(result)
					: route === "sync-pause"
						? SyncPause.safeParse(result)
						: route === "scheduling-outbox"
							? ScheduledSummary.safeParse(result)
							: route === "send-review"
								? SendReview.safeParse(result)
								: route === "bootstrap"
									? BootstrapStatus.safeParse(result)
									: route === "pairing-window"
										? PairingWindow.safeParse(result)
										: PairingResult.safeParse(result);
			if (!checked.success) return refuse("UNAVAILABLE");
			if (
				parsed.route === "send-review" &&
				(!("id" in checked.data) || checked.data.id !== parsed.id)
			)
				return refuse("UNAVAILABLE");
			const encoded = canonicalize(checked.data);
			if (
				(route === "send-review" &&
					!checkRouteLength(route, "response", Buffer.byteLength(encoded))) ||
				(route === "scheduling-outbox" &&
					!checkHubRuntimeRouteLength(route, "response", Buffer.byteLength(encoded)))
			)
				return refuse("UNAVAILABLE");
			const body = Buffer.from(encoded, "utf8");
			if (route === "scheduling-outbox") {
				if (!checkHubRuntimeResponseBytes(route, body)) return refuse("UNAVAILABLE");
			} else if (
				route === "status" ||
				route === "sync-pause" ||
				route === "send-review" ||
				route === "bootstrap" ||
				route === "pairing-window"
			) {
				if (!checkRouteResponseBytes(route, body)) return refuse("UNAVAILABLE");
			}
			if (route === "pairing-window") {
				const window = PairingWindow.parse(checked.data);
				const wall = Date.now();
				const payload = decodePairingPayload(window.pairingCode, wall);
				const now = performance.now();
				const deadline = Math.min(now + payload.exp - wall, operationStarted + PAIRING_WINDOW_MS);
				if (deadline <= now) return refuse("UNAVAILABLE");
				return send(response, 200, body, { phase: "opener", deadline });
			}
			if (route === "pairing-claim") {
				const deadline = born + PAIRING_WINDOW_MS;
				if (deadline <= performance.now()) return refuse("PAIR_WINDOW_CLOSED");
				return send(response, 200, body, { phase: "reveal", deadline });
			}
			send(response, 200, body);
		};
		void handle().catch((error: unknown) => failure(failureCode(error), response));
	});
	arm(born + REQUEST_MS);
	// Only the original accepted TLS connection is composed; there is no listen or bind call.
	server.emit("connection", socket);
}
