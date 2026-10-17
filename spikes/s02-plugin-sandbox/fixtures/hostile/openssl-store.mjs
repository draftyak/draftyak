// OpenSSL STORE loaders have no grant (--allow-openssl-store is on the never-list, 26.12.0). The
// first attempt loads a REAL private-key PEM outside every grant through a file: URL: on 26.12.0
// without the grant that is ERR_ACCESS_DENIED, and it WOULD load the key (escape) if the grant were
// present (the never-list is the defense). On 26.5.1 the feature is absent and a URL key argument is
// rejected (ERR_INVALID_ARG_TYPE). The store:// attempt covers the STORE-provider URI shape, which
// this build reports as unsupported even with the grant.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { attempt, config, report, start } from "./_util.mjs";
start("openssl-store");
const c = config();
report([
	await attempt(() => crypto.createPrivateKey(pathToFileURL(c.pem)).asymmetricKeyType),
	await attempt(() => (crypto.createPrivateKey(new URL("store://evil/mk")) ? "key" : "null")),
]);
