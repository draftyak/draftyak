"""process.binding('fs'): a classic way to reach Node internals below the permission model. Python has
no handle to Node's `process` (it is not in the curated `js`), and even if one were reached the shim's
constants-only stub and Node's own --permission stub make process.binding throw for every name but
'constants'. Getting the fs binding is an escape."""

import js
import pyodide_js

from ._util import denied, escaped


def _find_process():
    for holder, attr in ((js, "process"), (pyodide_js, "process")):
        candidate = getattr(holder, attr, None)
        if candidate is not None:
            return candidate
    return None


def run(host, args):
    process = _find_process()
    if process is None:
        return denied("AttributeError", "no process handle")
    binding = getattr(process, "binding", None)
    if binding is None:
        return denied("AttributeError", "no process.binding")
    try:
        fs_binding = binding("fs")
    except Exception as error:  # noqa: BLE001 - the stub must throw
        return denied(type(error).__name__, error)
    return escaped("binding", f"got {type(fs_binding).__name__}")
