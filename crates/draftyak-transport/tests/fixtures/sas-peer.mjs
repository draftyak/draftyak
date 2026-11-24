import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { performance } from "node:perf_hooks";
import {
  pairingEkm, pairingSas, PairingError, PairingResult,
  readPairingClaim, readPairingReveal, verifyPairingClaim, verifyPairingReveal,
} from "../../../../packages/protocol/src/pairing.ts";

const modes = ["normal", "empty-length", "wrong-nonce", "invalid-status", "nonempty-204",
  "transfer-204", "duplicate-refusal", "oversized-refusal", "claim-refusal", "sas-refusal",
  "window-closed", "reveal-invalid", "delayed-valid", "claim-reveal-refusal", "delayed-claim"];
const rawSockets = new Set(), active = new Map(), bySocket = new WeakMap();
let config, server, pending = Buffer.alloc(0), tcp = 0, tls = 0;
let claims = 0, reveals = 0, http = 0, websockets = 0, frames = 0, applicationBytes = 0;
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const fail = () => { process.stderr.write("SAS fixture failed\n"); process.exit(1); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function refusal(response, code) {
  response.writeHead(403, { "content-type": "application/json" });
  response.end(JSON.stringify({ code }));
}

function answerReveal(connection, response, reveal) {
  const held = connection.held;
  const original = verifyPairingReveal(reveal, held.claim);
  let tested = reveal;
  if (config.mode === "wrong-nonce") {
    const changed = Buffer.from(reveal.nd, "base64url");
    changed[0] ^= 1;
    tested = { pid: reveal.pid, nd: changed.toString("base64url") };
    changed.fill(0);
  }
  const code = verifyPairingReveal(tested, held.claim);
  held.awaiting = false;
  const row = { event: "reveal", connection: connection.id, code: code ?? "accepted",
    originalValid: original === undefined, changedNonce: tested !== reveal };
  if (code !== undefined) { emit(row); refusal(response, code); return; }
  if (["normal", "empty-length", "delayed-valid", "delayed-claim"].includes(config.mode)) {
    const nd = Buffer.from(reveal.nd, "base64url");
    // The reference stays in the private test pipe. No HTTP answer contains a SAS.
    row.expectedSas = pairingSas(connection.ekm, nd, held.nh);
    nd.fill(0);
  }
  emit(row);
  switch (config.mode) {
    case "invalid-status": response.writeHead(200); response.end("{}"); return;
    case "nonempty-204":
      connection.socket.write("HTTP/1.1 204 No Content\r\nContent-Length: 2\r\n\r\n{}"); return;
    case "transfer-204":
      connection.socket.write("HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"); return;
    case "duplicate-refusal":
      response.writeHead(403); response.end('{"code":"PAIR_REVEAL_INVALID","code":"PAIR_REVEAL_INVALID"}'); return;
    case "oversized-refusal": {
      const body = '{"code":"PAIR_WINDOW_CLOSED"}'.padEnd(1025, " ");
      if (Buffer.byteLength(body) !== 1025 || JSON.parse(body).code !== "PAIR_WINDOW_CLOSED") throw Error();
      response.writeHead(403); response.end(body); return;
    }
    case "claim-refusal": refusal(response, "PAIR_PROOF_INVALID"); return;
    case "sas-refusal":
      response.writeHead(403); response.end('{"code":"PAIR_WINDOW_CLOSED","sas":"000000"}'); return;
    case "window-closed": refusal(response, "PAIR_WINDOW_CLOSED"); return;
    case "reveal-invalid": refusal(response, "PAIR_REVEAL_INVALID"); return;
    case "delayed-valid":
      connection.timers.add(setTimeout(() => { response.writeHead(204); response.end(); }, 5000)); return;
    case "empty-length": response.writeHead(204, { "content-length": "0" }); response.end(); return;
    default: response.writeHead(204); response.end();
  }
}

function requestHandler(request, response) {
  const connection = bySocket.get(request.socket);
  if (!connection || request.method !== "POST") { request.destroy(); return; }
  if (request.url === "/native/reconnect") {
    http += 1;
    request.resume();
    request.once("end", () => { emit({ event: "http", connection: connection.id }); response.end("{}"); });
    return;
  }
  const claiming = request.url === "/pair/v1/claim";
  if (!claiming && request.url !== "/pair/v1/reveal") { request.destroy(); return; }
  if (claiming) claims += 1; else reveals += 1;
  let body = Buffer.alloc(0);
  request.on("data", chunk => {
    if (body.length + chunk.length > (claiming ? 4096 : 1024)) { request.destroy(); return; }
    body = Buffer.concat([body, chunk]);
  });
  request.on("error", () => { body.fill(0); response.destroy(); });
  request.on("end", () => {
    try {
      if (claiming) {
        const claim = readPairingClaim(body);
        const code = connection.held ? "PAIR_WINDOW_CLOSED"
          : verifyPairingClaim(claim, config.window, connection);
        emit({ event: "claim", connection: connection.id, code: code ?? "accepted" });
        if (code !== undefined) { refusal(response, code); return; }
        if (config.mode === "claim-reveal-refusal") { refusal(response, "PAIR_REVEAL_INVALID"); return; }
        const nh = randomBytes(16);
        connection.held = { claim, nh, awaiting: true };
        const result = PairingResult.parse({ deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", epoch: 7,
          nh: nh.toString("base64url") });
        const readyAt = performance.now();
        const answer = () => {
          if (config.mode === "delayed-claim") {
            emit({ event: "claim-answer", connection: connection.id,
              claimDelayMs: Math.floor(performance.now() - readyAt) });
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        };
        if (config.mode === "delayed-claim") connection.timers.add(setTimeout(answer, 3000));
        else answer();
      } else {
        const reveal = readPairingReveal(body);
        if (!connection.held?.awaiting) {
          emit({ event: "reveal", connection: connection.id, code: "PAIR_WINDOW_CLOSED" });
          refusal(response, "PAIR_WINDOW_CLOSED"); return;
        }
        answerReveal(connection, response, reveal);
      }
    } catch (error) {
      if (!(error instanceof PairingError)) { fail(); return; }
      const code = claiming ? "PAIR_CLAIM_INVALID" : "PAIR_REVEAL_INVALID";
      emit({ event: claiming ? "claim" : "reveal", connection: connection.id, code });
      refusal(response, code);
    } finally { body.fill(0); }
  });
}

// Only bounded, short frames needed by the reconnect control. HTTPS owns HTTP parsing.
function upgrade(request, socket, head) {
  const connection = bySocket.get(socket);
  const key = request.headers["sec-websocket-key"];
  if (!connection || request.url !== "/native/reconnect-ws" || typeof key !== "string"
    || key.length > 64 || head.length !== 0) { socket.destroy(); return; }
  websockets += 1;
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  emit({ event: "websocket", connection: connection.id });
  let incoming = Buffer.alloc(0);
  socket.on("data", chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    if (incoming.length > 1024) { socket.destroy(); return; }
    while (incoming.length >= 2) {
      const length = incoming[1] & 127, opcode = incoming[0] & 15;
      if (length > 125 || (incoming[1] & 128) === 0 || incoming[0] & 0x70) { socket.destroy(); return; }
      if (incoming.length < 6 + length) return;
      const payload = Buffer.from(incoming.subarray(6, 6 + length));
      for (let index = 0; index < length; index++) payload[index] ^= incoming[2 + index % 4];
      incoming = incoming.subarray(6 + length);
      frames += 1;
      if (opcode === 8) { payload.fill(0); socket.end(Buffer.from([0x88, 0])); return; }
      if (opcode !== 1 && opcode !== 2) { payload.fill(0); socket.destroy(); return; }
      socket.write(Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]));
      payload.fill(0);
    }
  });
}

function start(value) {
  if (!value || !modes.includes(value.mode) || typeof value.cert !== "string" || typeof value.key !== "string"
    || value.window?.role !== "device" || typeof value.window.pid !== "string" || typeof value.window.sec !== "string"
    || Buffer.from(value.window.pid, "base64url").length !== 16
    || Buffer.from(value.window.sec, "base64url").length !== 16) throw Error();
  config = value;
  server = createServer({ cert: config.cert, key: config.key, requestCert: true, rejectUnauthorized: false,
    minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"] }, requestHandler);
  server.on("upgrade", upgrade);
  server.on("connection", socket => {
    tcp += 1; rawSockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => { rawSockets.delete(socket); emit({ event: "socket-closed" }); });
  });
  server.on("secureConnection", socket => {
    const id = ++tls;
    try {
      const certificate = new X509Certificate(socket.getPeerCertificate().raw);
      const spki = certificate.publicKey.export({ type: "spki", format: "der" });
      const connection = { id, socket, timers: new Set(), ekm: Buffer.from(pairingEkm(socket, config.window.pid)),
        clientSpkiSha256: hash(spki) };
      bySocket.set(socket, connection); active.set(id, connection);
      socket.on("data", chunk => { applicationBytes += chunk.length; if (applicationBytes > 32768) fail(); });
      socket.once("close", () => {
        for (const timer of connection.timers) clearTimeout(timer);
        connection.ekm.fill(0); connection.held?.nh.fill(0); active.delete(id);
        emit({ event: "tls-closed", connection: id });
      });
      emit({ event: "tls", connection: id, clientPin: connection.clientSpkiSha256, version: socket.getProtocol() });
    } catch { socket.destroy(); }
  });
  server.on("tlsClientError", () => {});
  server.on("error", fail);
  server.listen(0, "127.0.0.1", () => emit({ event: "ready", port: server.address().port }));
}

function command(value) {
  if (!config) { start(value); return; }
  if (value?.op !== "stop") throw Error();
  for (const socket of rawSockets) socket.destroy();
  server.close(() => emit({ event: "stopped", tcp, tls, claims, reveals, http, websockets, frames }));
  process.stdin.destroy();
}
process.stdin.on("data", chunk => {
  try {
    if (pending.length + chunk.length > 32768) throw Error();
    pending = Buffer.concat([pending, chunk]);
    let at;
    while ((at = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, at); pending = pending.subarray(at + 1);
      command(JSON.parse(line.toString("utf8"))); line.fill(0);
    }
  } catch { fail(); }
});
