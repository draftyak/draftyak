import type { NativeDevicePeer } from "../../../src/authz/native-peer.ts";
import type { NativeFixture, TestDevice } from "../../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import type { FakeDevice, FakeDeviceIdentity } from "./index.ts";

requireLoopbackNetworkGuard();
const { openFakeDevice } = await import("./index.ts");
const connecting = new WeakSet<NativeFixture>();

export interface FakeDeviceConnection {
	readonly client: FakeDevice;
	readonly device: TestDevice;
}

/** Sequential test adapter: the server's real TLS callback is the only peer source. */
export async function connectFakeDevice(
	f: NativeFixture,
	reuseIdentity?: FakeDeviceIdentity,
): Promise<FakeDeviceConnection> {
	requireLoopbackNetworkGuard();
	if (connecting.has(f) || f.waiting.length !== 0 || f.nextPeers.length !== 0)
		throw new Error("DYTEST native peer queue is busy");
	connecting.add(f);
	let receive: (peer: NativeDevicePeer) => void = () => {};
	let cancel: () => void = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const peer = new Promise<NativeDevicePeer>((resolve, reject) => {
		receive = (value) => {
			clearTimeout(timer);
			resolve(value);
		};
		cancel = () => {
			const index = f.waiting.indexOf(receive);
			if (index !== -1) f.waiting.splice(index, 1);
			reject(new Error("DYTEST native connection unavailable"));
		};
		timer = setTimeout(cancel, 5_000);
		f.waiting.push(receive);
	});
	void peer.catch(() => undefined);
	let client: FakeDevice | undefined;
	try {
		client = await openFakeDevice({ port: f.port, hid: f.identity.hid }, reuseIdentity);
		const device: TestDevice = {
			socket: client.socket,
			peer: await peer,
			transportKey: client.transportKey,
			certificate: client.certificate,
			transportSpkiSha256: client.transportSpkiSha256,
			signingKey: client.signingKey,
			privateKey: client.privateKey,
		};
		f.devices.push(device);
		return { client, device };
	} catch (error) {
		cancel();
		await client?.close();
		throw error;
	} finally {
		clearTimeout(timer);
		const index = f.waiting.indexOf(receive);
		if (index !== -1) f.waiting.splice(index, 1);
		connecting.delete(f);
	}
}
