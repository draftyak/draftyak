import { createServer as httpsServer } from "node:https";
import { createServer as tcpServer } from "node:net";
import { createHash, X509Certificate } from "node:crypto";
import { pairingEkm } from "../../../../packages/protocol/src/pairing.ts";

let pending = Buffer.alloc(0), configured = false, server, requests = 0, applicationBytes = 0;
const sockets = new Set();
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
function start(config) {
  if (!config || typeof config !== "object" || !["normal", "silent-tls", "silent-http", "tls12"].includes(config.mode)
    || typeof config.cert !== "string" || typeof config.key !== "string" || typeof config.pid !== "string"
    || typeof config.body !== "string" || !Number.isInteger(config.status) || config.status < 200 || config.status > 599)
    throw Error("invalid fixture configuration");
  const body = Buffer.from(config.body, "base64url");
  if (body.length > 8192) throw Error("fixture body bound");
  const options = { key: config.key, cert: config.cert, requestCert: true, rejectUnauthorized: false,
    minVersion: config.mode === "tls12" ? "TLSv1.2" : "TLSv1.3",
    maxVersion: config.mode === "tls12" ? "TLSv1.2" : "TLSv1.3" };
  server = config.mode === "silent-tls" ? tcpServer(() => {}) : httpsServer(options, (request, response) => {
    requests += 1;
    let bytes = 0;
    request.on("data", chunk => { bytes += chunk.length; if (bytes > 4096) request.destroy(); });
    request.on("end", () => {
      emit({ event: "request", bytes });
      if (config.mode !== "silent-http") { response.writeHead(config.status); response.end(body); }
    });
    request.on("error", () => response.destroy());
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => { sockets.delete(socket); emit({ event: "socket-closed" }); }); });
  server.on("tlsClientError", () => {});
  server.on("error", () => { process.stderr.write("TLS fixture failed\n"); process.exit(1); });
  if (config.mode !== "silent-tls") server.on("secureConnection", socket => {
    socket.on("data", chunk => {
      if (chunk.length > 32768 - applicationBytes) {
        process.stderr.write("TLS fixture application-byte bound exceeded\n");
        socket.destroy(); process.exit(1);
      }
      applicationBytes += chunk.length;
    });
    try {
      const certificate = new X509Certificate(socket.getPeerCertificate().raw);
      const spki = certificate.publicKey.export({ type: "spki", format: "der" });
      emit({ event: "tls", clientPin: createHash("sha256").update(spki).digest("hex"),
        ekm: Buffer.from(pairingEkm(socket, config.pid)).toString("hex"), version: socket.getProtocol() });
    } catch { socket.destroy(); }
  });
  server.listen(0, "127.0.0.1", () => emit({ event: "ready", port: server.address().port }));
}
function line(bytes) {
  if (!configured) { configured = true; start(JSON.parse(bytes.toString("utf8"))); return; }
  if (bytes.toString("utf8") !== "stop" || !server) throw Error("invalid fixture command");
  for (const socket of sockets) socket.destroy();
  server.close(() => emit({ event: "stopped", requests, applicationBytes }));
  process.stdin.destroy();
}
process.stdin.on("data", chunk => {
  try {
    if (pending.length + chunk.length > 32768) throw Error("fixture input bound");
    pending = Buffer.concat([pending, chunk]);
    let at;
    while ((at = pending.indexOf(10)) >= 0) { const value = pending.subarray(0, at); pending = pending.subarray(at + 1); line(value); }
  } catch { process.stderr.write("TLS fixture failed\n"); process.exit(1); }
});
