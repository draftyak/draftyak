// Windows only. A named pipe is a Net resource under the permission model, so both connecting to the
// parent's live pipe server and listening on a correctly-named pipe are refused. The name is built
// with String.raw so its runtime value is a real \\.\pipe\... path: in a plain template literal \p
// and \d are useless escapes that collapse the name to \.pipedy-<pid>, which names nothing.
import net from "node:net";
import { attempt, config, report, start } from "./_util.mjs";
start("net-pipe");
const c = config();
const own = String.raw`\\.\pipe\dy-s02-${process.pid}`;
const connect = () =>
	new Promise((res, rej) => {
		const s = net.connect(c.pipePath);
		s.once("connect", () => {
			s.destroy();
			res("connected");
		});
		s.once("error", rej);
	});
const listen = () =>
	new Promise((res, rej) => {
		const srv = net.createServer();
		srv.once("listening", () => {
			srv.close();
			res("listening");
		});
		srv.once("error", rej);
		try {
			srv.listen(own);
		} catch (error) {
			rej(error);
		}
	});
report([await attempt(connect), await attempt(listen)]);
