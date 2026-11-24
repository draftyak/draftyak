import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import {
  makePairingClaim,
  pairingEkm,
  pairingPubs,
  PairingError,
  PairingResult,
  readPairingClaim,
  verifyPairingClaim,
  verifyPairingProof,
} from "../../../../packages/protocol/src/pairing.ts";

// This peer isolates the merged claim reader and verifier. It deliberately does
// not model window consumption, confirmation, the reveal, or authorization.
const sockets = new Set();
const active = new Map();
const bySocket = new WeakMap();
let pending = Buffer.alloc(0), config, server, requests = 0;
let tcpConnections = 0, tlsConnections = 0, applicationBytes = 0;
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const fail = () => { process.stderr.write("Pairing fixture failed\n"); process.exit(1); };

function validProof(claim, ekm) {
  const bound = Buffer.concat([
    pairingPubs(claim.transportSpkiSha256, claim.signingKey),
    Buffer.from(claim.c, "hex"),
  ]);
  return verifyPairingProof(Buffer.from(config.window.sec, "base64url"), ekm,
    bound, Buffer.from(claim.proof, "hex"));
}

function start(value) {
  if (!value || typeof value !== "object" || typeof value.cert !== "string"
    || typeof value.key !== "string" || !value.window || value.window.role !== "device"
    || !["normal", "duplicate-epoch", "oversized-json", "delayed-valid"].includes(value.replyMode)
    || typeof value.window.pid !== "string" || typeof value.window.sec !== "string"
    || Buffer.from(value.window.pid, "base64url").length !== 16
    || Buffer.from(value.window.sec, "base64url").length !== 16) throw Error();
  config = value;
  server = createServer({ key: config.key, cert: config.cert, requestCert: true,
    rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (request, response) => {
    const connection = bySocket.get(request.socket);
    if (!connection || request.method !== "POST" || request.url !== "/pair/v1/claim") {
      request.destroy(); return;
    }
    requests += 1;
    let body = Buffer.alloc(0);
    request.on("data", chunk => {
      if (body.length + chunk.length > 4096) { request.destroy(); return; }
      body = Buffer.concat([body, chunk]);
    });
    request.on("error", () => { body.fill(0); response.destroy(); });
    request.on("end", () => {
      try {
        const claim = readPairingClaim(body);
        const proofValid = validProof(claim, connection.ekm);
        const code = verifyPairingClaim(claim, config.window, connection);
        const row = { event: "claim", connection: connection.id, proofValid,
          clientMatches: claim.transportSpkiSha256 === connection.clientSpkiSha256,
          code: code ?? "accepted", body: body.toString("base64url") };
        if (code === undefined) {
          // A Node-created claim travels back through the native strict JSON
          // reader; its nonce is independent from the Rust candidate's nonce.
          const nonce = randomBytes(16);
          const reference = makePairingClaim(config.window, {
            name: claim.name, transportSpkiSha256: claim.transportSpkiSha256,
            signingKey: claim.signingKey,
          }, connection.ekm, nonce);
          nonce.fill(0);
          if (verifyPairingClaim(readPairingClaim(JSON.stringify(reference)),
            config.window, connection) !== undefined) throw Error();
          row.reference = Buffer.from(JSON.stringify(reference)).toString("base64url");
          emit(row);
          const nh = randomBytes(16);
          const result = PairingResult.parse({ deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", epoch: 7,
            nh: nh.toString("base64url") });
          nh.fill(0);
          let reply = JSON.stringify(result);
          if (config.replyMode === "duplicate-epoch") {
            reply = reply.replace('"epoch":7', '"epoch":7,"epoch":7');
          } else if (config.replyMode === "oversized-json") {
            // This remains valid JSON. A relaxed received-byte limit would
            // accept it, so the refusal cannot come from malformed syntax.
            reply = reply.padEnd(4097, " ");
            if (Buffer.byteLength(reply) !== 4097 || JSON.parse(reply).epoch !== 7) throw Error();
          }
          response.writeHead(200, { "content-type": "application/json" });
          if (config.replyMode === "delayed-valid") {
            // A valid answer arrives beyond the test's explicit three-second
            // window while remaining inside the native ten-second I/O budget.
            setTimeout(() => response.end(reply), 5000);
          } else {
            response.end(reply);
          }
        } else {
          emit(row);
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ code }));
        }
      } catch (error) {
        if (!(error instanceof PairingError)) { fail(); return; }
        emit({ event: "claim", connection: connection.id, code: "PAIR_CLAIM_INVALID" });
        response.writeHead(403, { "content-type": "application/json" });
        response.end('{"code":"PAIR_CLAIM_INVALID"}');
      } finally { body.fill(0); }
    });
  });
  server.on("connection", socket => {
    tcpConnections += 1;
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      emit({ event: "socket-closed" });
    });
  });
  server.on("tlsClientError", () => {});
  server.on("error", fail);
  server.on("secureConnection", socket => {
    const id = ++tlsConnections;
    try {
      const cert = new X509Certificate(socket.getPeerCertificate().raw);
      const spki = cert.publicKey.export({ type: "spki", format: "der" });
      const connection = { id, socket, ekm: Buffer.from(pairingEkm(socket, config.window.pid)),
        clientSpkiSha256: createHash("sha256").update(spki).digest("hex") };
      bySocket.set(socket, connection);
      active.set(connection.id, connection);
      socket.on("data", chunk => {
        applicationBytes += chunk.length;
        if (applicationBytes > 32768) fail();
      });
      socket.once("close", () => {
        connection.ekm.fill(0);
        active.delete(connection.id);
        emit({ event: "tls-closed", connection: connection.id });
      });
      emit({ event: "tls", connection: connection.id, clientPin: connection.clientSpkiSha256,
        certificate: createHash("sha256").update(cert.raw).digest("hex"),
        ekm: connection.ekm.toString("hex"), version: socket.getProtocol() });
    } catch { socket.destroy(); }
  });
  server.listen(0, "127.0.0.1", () => emit({ event: "ready", port: server.address().port }));
}

function command(value) {
  if (!config) { start(value); return; }
  if (value?.op === "stop") {
    for (const socket of sockets) socket.destroy();
    server.close(() => emit({ event: "stopped", requests, tcpConnections, tlsConnections }));
    process.stdin.destroy();
    return;
  }
  if (value?.op === "connection-state" && Number.isSafeInteger(value.connection)) {
    const id = value.connection;
    // Let pending socket close notifications run before taking the receipt.
    setTimeout(() => {
      const connection = active.get(id);
      emit({ event: "connection-state", connection: id,
        active: connection !== undefined && !connection.socket.destroyed && connection.socket.writable });
    }, 50);
    return;
  }
  if (!["forge", "contract"].includes(value?.op)
    || (value.op === "forge" && !Number.isSafeInteger(value.connection))
    || typeof value.name !== "string" || typeof value.transportSpkiSha256 !== "string"
    || typeof value.signingKey !== "string") throw Error();
  const connection = value.op === "forge" ? active.get(value.connection) : undefined;
  if (value.op === "forge" && !connection) throw Error();
  const ekm = connection?.ekm ?? Buffer.alloc(32, 0x44);
  const nonce = randomBytes(16);
  const claim = makePairingClaim(config.window, { name: value.name,
    transportSpkiSha256: value.transportSpkiSha256, signingKey: value.signingKey }, ekm, nonce);
  nonce.fill(0);
  emit({ event: "oracle", connection: connection?.id, proofValid: validProof(claim, ekm),
    clientMatches: connection ? claim.transportSpkiSha256 === connection.clientSpkiSha256 : undefined,
    body: Buffer.from(JSON.stringify(claim)).toString("base64url") });
  if (!connection) ekm.fill(0);
}

process.stdin.on("data", chunk => {
  try {
    if (pending.length + chunk.length > 32768) throw Error();
    pending = Buffer.concat([pending, chunk]);
    let at;
    while ((at = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, at);
      pending = pending.subarray(at + 1);
      command(JSON.parse(line.toString("utf8")));
      line.fill(0);
    }
  } catch { fail(); }
});
