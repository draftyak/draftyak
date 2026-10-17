// The spike kit. A spike's vitest.config.ts imports the factory from "@draftyak/spike-kit/vitest".
export * as docker from "./docker.ts";
export {
	type DockerResult,
	type DockerRunSpec,
	DockerUnavailableError,
	needDocker,
	PINNED_IMAGE,
	runInDocker,
	type StageSpec,
	stageForDocker,
} from "./docker.ts";
export * from "./env-live.ts";
export * from "./evidence.ts";
export * from "./lock.ts";
export * from "./node.ts";
export * from "./ports.ts";
export { cacheDir } from "./repo.ts";
export * from "./skip.ts";
