"""dy-hostile: the S11b Python escape, print-fuzz and timeout fixture plugin.

It runs on the hub-shipped Pyodide inside the permissioned Node plugin process, as any `standard`
Python plugin does, with the runtime-dir and plugin-dir read grants already dropped (shim boot step 4)
before this module is imported. Every tool here attempts one forbidden thing (§9.2 Python rows) or a
denial-of-service, so the suite can prove the process and its flags are the boundary. Each escape tool
returns structuredContent {outcome: "denied"|"escaped", code, detail} on the MCP transport; the harness
asserts `denied` and, independently, that no canary bytes leaked and no host file was created.

Nothing here is trusted. `host` is the frozen JS object the shim hands to call_tool: api, fetch and log.
"""

import json

from .attacks import ATTACKS

HOST_API = 1


def _tool(name, description, extra=None):
    properties = {
        "fakeDir": {"type": "string"},
        "pluginDir": {"type": "string"},
        "runtimeDir": {"type": "string"},
        "canaries": {"type": "array"},
        "offProfileUrl": {"type": "string"},
        "count": {"type": "integer"},
    }
    return {
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties},
    }


# One tool per hostile attempt, plus the contract/DoS tools the other heavy suites drive.
TOOLS = [_tool(name, f"Hostile attempt: {name} (must be denied).") for name in ATTACKS] + [
    _tool("ping", "Benign contract check: answers after the grants drop."),
    _tool("busy", "Spins in a tight Python loop forever; only a process kill stops it."),
    _tool("flood", "Prints `count` JSON-RPC-shaped lines and calls input() as many times."),
]


def _result(text, structured):
    return json.dumps({"content": [{"type": "text", "text": text}], "structuredContent": structured})


# A JSON-RPC-shaped line the fuzz prints, trying to forge an MCP frame on fd 1. Its id is one the
# harness never sends, so if it ever reaches fd 1 the harness sees the forged id.
FORGED_ID = 987654321
_FORGED = json.dumps({"jsonrpc": "2.0", "id": FORGED_ID, "result": {"forged": True}})


class Plugin:
    api_version = HOST_API

    def list_tools(self):
        return json.dumps(TOOLS)

    def call_tool(self, name, arguments, host):
        args = json.loads(arguments or "{}")
        if name in ATTACKS:
            outcome = ATTACKS[name](host, args)
            return _result(f"{name}: {outcome['outcome']}", outcome)
        if name == "ping":
            return _result("pong", {"outcome": "ok"})
        if name == "busy":
            while True:  # noqa: S110 - the point is a handler the hub can only stop by killing it
                pass
        if name == "flood":
            count = int(args.get("count", 10000))
            for _ in range(count):
                print(_FORGED)
                try:
                    input()
                except Exception:  # noqa: BLE001 - input() must raise under the sandbox
                    pass
            return _result("flood done", {"outcome": "ok", "printed": count, "forgedId": FORGED_ID})
        return json.dumps({"isError": True, "content": [{"type": "text", "text": "UNSUPPORTED"}]})


plugin = Plugin()
