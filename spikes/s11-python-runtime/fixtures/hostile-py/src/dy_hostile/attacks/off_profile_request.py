"""An off-profile HTTP request. The only network path is the broker (host.fetch over the IPC channel),
which enforces the egress profile: a request to a host the profile does not allow comes back refused.
A 2xx from an off-profile host would be an escape."""

import json

from pyodide.ffi import run_sync

from ._util import denied, escaped


def run(host, args):
    url = str(args.get("offProfileUrl", "https://off-profile.example/secret"))
    request = json.dumps({"url": url, "method": "GET"})
    try:
        response = json.loads(str(run_sync(host.fetch(request))))
    except Exception as error:  # noqa: BLE001 - a refused fetch is a denial
        return denied(type(error).__name__, error)
    status = response.get("status")
    if isinstance(status, int) and 200 <= status < 300:
        return escaped("status", f"{status}")
    return denied("status", f"{status}")
