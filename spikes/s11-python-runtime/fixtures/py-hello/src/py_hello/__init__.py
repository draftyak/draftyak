"""py-hello: the S11 boot fixture, written against the shim's host API v1 (no SDK yet).

The shim calls list_tools() once and call_tool(name, arguments_json, host) per tools/call, through
callPromising, so a handler may block on host calls with run_sync. host is the frozen JS object
the shim hands over: api, fetch(request_json) -> Promise[response_json] and log(level, message).
Bodies on the host channel are base64.
"""

import base64
import json
import os
import sys

import js
import pyodide_js
from pyodide.ffi import can_run_sync, run_sync, to_js
from typing_extensions import TypedDict

BINARY = bytes(range(256))


def _read_probe(mount_point):
    """Mounts the runtime dir from the host; the shim drops both read grants before this import."""
    try:
        pyodide_js.mountNodeFS(mount_point, str(pyodide_js._api.config.indexURL))
        return f"read {len(os.listdir(mount_point))} entries"
    except Exception as error:  # noqa: BLE001 - the probe reports how the mount failed
        return "denied" if "does not exist" in str(error) else f"failed: {type(error).__name__}"


READ_AT_IMPORT = _read_probe("/s11-import")


class Greeting(TypedDict):
    name: str


def _url_tool(name, description):
    schema = {
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    }
    return {"name": name, "description": description, "inputSchema": schema}


TOOLS = [
    {
        "name": "hello",
        "description": "Greets a name.",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    },
    _url_tool("fetch_status", "Fetches a URL through the host broker, blocking with run_sync."),
    _url_tool("http_clients", "Fetches below a base URL with pyfetch, urllib3 and requests."),
    {
        "name": "runtime_info",
        "description": "Reports the Python runtime the plugin sees.",
        "inputSchema": {"type": "object"},
    },
]


def _text(text, structured=None):
    result = {"content": [{"type": "text", "text": text}]}
    if structured is not None:
        result["structuredContent"] = structured
    return json.dumps(result)


def _input_error():
    try:
        input()
    except Exception as error:  # noqa: BLE001 - the fixture reports whatever input() raises
        return type(error).__name__
    return None


def _http_clients(base):
    import requests
    import urllib3
    from pyodide.http import pyfetch

    def fetch(path, **options):
        response = run_sync(pyfetch(base + path, **options))
        return response.status, run_sync(response.bytes())

    text = fetch("/status")
    binary = fetch("/binary")
    empty = fetch("/empty")
    echo = fetch("/echo", method="POST", body=to_js(BINARY))
    via_urllib3 = urllib3.request("GET", base + "/status", timeout=10)
    via_requests = requests.get(base + "/status", timeout=10)
    return {
        "pyfetch": {"status": text[0], "body": text[1].decode()},
        "pyfetchBinary": {"status": binary[0], "same": binary[1] == BINARY},
        "pyfetchEmpty": {"status": empty[0], "bodyLength": len(empty[1])},
        "pyfetchEcho": {"status": echo[0], "same": echo[1] == BINARY},
        "urllib3": {"status": via_urllib3.status, "body": via_urllib3.data.decode()},
        "requests": {"status": via_requests.status_code, "body": via_requests.text},
    }


class Plugin:
    api_version = 1

    def list_tools(self):
        return json.dumps(TOOLS)

    def call_tool(self, name, arguments, host):
        args = json.loads(arguments or "{}")
        if name == "hello":
            greeting = Greeting(name=str(args["name"]))
            print(f"hello called for {len(greeting['name'])} characters")
            return _text(f"Hello, {greeting['name']}!")
        if name == "fetch_status":
            request = json.dumps({"url": args["url"], "method": "GET"})
            response = json.loads(run_sync(host.fetch(request)))
            structured = {
                "status": response["status"],
                "bodyLength": len(base64.b64decode(response.get("bodyBase64") or "")),
                "canRunSync": can_run_sync(),
            }
            return _text(f"status {response['status']}", structured)
        if name == "http_clients":
            return _text("http clients", _http_clients(args["url"]))
        if name == "runtime_info":
            structured = {
                "python": sys.version.split()[0],
                "platform": sys.platform,
                "environ": dict(os.environ),
                "executable": sys.executable,
                "canRunSync": can_run_sync(),
                "inputRaises": _input_error(),
                "hostApi": host.api,
                "jsGlobals": sorted(js.object_keys()),
                "readAtImport": READ_AT_IMPORT,
                "readAtCall": _read_probe("/s11-call"),
            }
            return _text("runtime", structured)
        return json.dumps({"isError": True, "content": [{"type": "text", "text": "UNSUPPORTED"}]})


plugin = Plugin()
