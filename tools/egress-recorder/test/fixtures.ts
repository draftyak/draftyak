import {
	type CoverageRequirements,
	createRecorder,
	type Destination,
	type ObserverDescriptor,
} from "../src/index.ts";

export const hub: ObserverDescriptor = {
	id: "hub-point",
	caller: { kind: "hub", instanceId: "hub-fixture" },
};
export const plugin: ObserverDescriptor = {
	id: "plugin-point",
	caller: { kind: "plugin", instanceId: "plugin-fixture" },
};
export const target: Destination = { host: "upstream.example", port: 443, transport: "tcp" };
export const required: CoverageRequirements = {
	scope: "component",
	observers: [hub],
	canary: false,
};

export function zero(): string {
	const recorder = createRecorder({ profile: "test", observers: [hub] });
	recorder.observer(hub.id).complete();
	return recorder.finish();
}
export function parsedZero(): Record<string, unknown> {
	return JSON.parse(zero()) as Record<string, unknown>;
}
