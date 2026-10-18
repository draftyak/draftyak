"""py-budget: the S11c budget fixture (plan §15 S11 (g); §4 Flags and Health).

echo returns its argument, for the 1 MiB round trip. py_alloc allocates in the wasm heap, which
--wasm-max-mem-pages=8192 caps at 512 MiB, so 1 GiB raises MemoryError; with hold it keeps the
block, for a run without that cap. js_alloc copies a wasm-heap buffer into JS typed arrays
(pyodide.ffi.to_js copies), which neither that cap nor --max-old-space-size covers, and keeps them,
so only the hub's RSS watchdog stops it. Every block is filled with random bytes, so no OS can
compress it below what the plugin holds (macOS compresses idle zero pages).

A cold-start bundle adds one C-extension wheel (pydantic-core or numpy), which the plugin imports as
it loads, as a plugin using it would, so the cold start includes the import.
"""

import importlib
import importlib.util
import json
import os

from pyodide.ffi import to_js

for _module in ("pydantic_core", "numpy"):
    if importlib.util.find_spec(_module) is not None:
        importlib.import_module(_module)

MIB = 1 << 20
_HELD = []


def _schema(**properties):
    return {"type": "object", "properties": properties}


TOOLS = [
    {
        "name": "echo",
        "description": "Returns data unchanged.",
        "inputSchema": {**_schema(data={"type": "string"}), "required": ["data"]},
    },
    {
        "name": "py_alloc",
        "description": "Allocates mib MiB in the wasm heap, then frees it or, with hold, keeps it.",
        "inputSchema": _schema(mib={"type": "integer"}, hold={"type": "boolean"}),
    },
    {
        "name": "js_alloc",
        "description": "Holds mib MiB of JS typed arrays, copied chunkMiB at a time.",
        "inputSchema": _schema(mib={"type": "integer"}, chunkMiB={"type": "integer"}),
    },
]


def _result(text, structured):
    return json.dumps({"content": [{"type": "text", "text": text}], "structuredContent": structured})


def _fill(block):
    noise = os.urandom(MIB)
    for start in range(0, len(block), MIB):
        end = min(start + MIB, len(block))
        block[start:end] = noise[: end - start]


def _py_alloc(mib, hold):
    try:
        block = bytearray(mib * MIB)
    except MemoryError:
        return _result("MemoryError", {"outcome": "MemoryError"})
    _fill(block)
    allocated = len(block) // MIB
    if hold:
        _HELD.append(block)
    del block
    return _result("allocated", {"outcome": "allocated", "mib": allocated})


def _js_alloc(mib, chunk_mib):
    chunk = bytearray(chunk_mib * MIB)
    for _ in range(mib // chunk_mib):
        _fill(chunk)
        _HELD.append(to_js(chunk))
    held = sum(array.byteLength for array in _HELD) // MIB
    return _result("held", {"outcome": "held", "mib": held})


class Plugin:
    api_version = 1

    def list_tools(self):
        return json.dumps(TOOLS)

    def call_tool(self, name, arguments, host):
        args = json.loads(arguments or "{}")
        if name == "echo":
            return json.dumps({"content": [{"type": "text", "text": str(args.get("data", ""))}]})
        if name == "py_alloc":
            return _py_alloc(int(args.get("mib", 1024)), bool(args.get("hold", False)))
        if name == "js_alloc":
            return _js_alloc(int(args.get("mib", 1536)), int(args.get("chunkMiB", 64)))
        return json.dumps({"isError": True, "content": [{"type": "text", "text": "UNSUPPORTED"}]})


plugin = Plugin()
