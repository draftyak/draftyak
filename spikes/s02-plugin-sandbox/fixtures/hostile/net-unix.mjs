// POSIX only. A UNIX-domain socket is a Net resource under the permission model, so both connecting
// to the parent's live socket and listening on one in the writable data dir are refused. The connect
// target is a real server the harness runs and whose hit counter it checks.
import net from "node:net";
import path from "node:path";
import { attempt, config, report, start } from "./_util.mjs";
start("net-unix");
const c = config();
const own = path.join(c.dataDir, "dy.sock");
const connect = () =>
	new Promise((res, rej) => {
		const s = net.connect(c.unixPath);
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
