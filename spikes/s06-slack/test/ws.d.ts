// The parts of ws 8.22.0 (which ships no types) that the fake Socket Mode server uses, from
// lib/websocket-server.js and lib/websocket.js.
declare module "ws" {
	import type { EventEmitter } from "node:events";
	import type { IncomingMessage } from "node:http";
	import type { Duplex } from "node:stream";

	export class WebSocket extends EventEmitter {
		static readonly OPEN: 1;
		readonly readyState: 0 | 1 | 2 | 3;
		send(data: string, callback?: (error?: Error) => void): void;
		close(code?: number, reason?: string): void;
		terminate(): void;
		on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
		on(event: "close", listener: (code: number, reason: Buffer) => void): this;
		on(event: "error", listener: (error: Error) => void): this;
	}

	export class WebSocketServer extends EventEmitter {
		constructor(options: { noServer: true; clientTracking?: boolean });
		readonly clients: Set<WebSocket>;
		handleUpgrade(
			request: IncomingMessage,
			socket: Duplex,
			head: Buffer,
			callback: (socket: WebSocket, request: IncomingMessage) => void,
		): void;
		close(callback?: (error?: Error) => void): void;
	}
}
