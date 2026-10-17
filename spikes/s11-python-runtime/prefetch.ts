// pnpm m0:prefetch runs this from the spike folder: the wheels runtime.lock.json names, into the cache.
import { fetchRuntime, PYODIDE } from "./scripts/fetch-runtime.ts";

const { wheels } = await fetchRuntime();
console.log(`s11: Pyodide ${PYODIDE} runtime checked; wheels in ${wheels}`);
