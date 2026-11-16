import { channelContract } from "@draftyak/plugin-testkit";
import { manifest, plugin } from "../src/plugin.ts";
import { fixtures } from "./fixtures.ts";

await channelContract({ plugin: { manifest, entry: plugin }, mode: "in-memory", fixtures });
