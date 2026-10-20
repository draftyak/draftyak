import { main } from "./cli-main.ts";

process.exitCode = await main(process.argv.slice(2));
