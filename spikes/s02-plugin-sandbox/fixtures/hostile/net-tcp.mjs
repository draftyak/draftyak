// TCP has no grant (--allow-net is on the never-list): neither connecting to the parent's live
// listener nor listening is allowed. The connect target is a real server the harness runs and whose
// hit counter it checks, so a grant would both go through here and register a hit at the parent.
import net from "node:net";
import { attempt, config, report, start } from "./_util.mjs";
start("net-tcp");
const c = config();
const connect = () =>
	new Promise((res, rej) => {
		const s = net.connect({ port: c.tcpPort, host: "127.0.0.1" });
		s.once("connect", () => {
			s.destroy();
			res("connected");
		});
		s.once("error", rej);
	});
// listen(0) with no host binds synchronously; a host would defer and throw on a later tick.
const listen = () =>
	new Promise((res, rej) => {
		const srv = net.createServer();
		srv.once("listening", () => {
			const a = srv.address();
			srv.close();
			res(`listening:${a?.port}`);
		});
		srv.once("error", rej);
		try {
			srv.listen(0);
		} catch (error) {
			rej(error);
		}
	});
report([await attempt(connect), await attempt(listen)]);
