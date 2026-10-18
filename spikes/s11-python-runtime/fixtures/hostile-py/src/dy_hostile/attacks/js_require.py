"""js.require('child_process'): the shim hands Python a frozen, curated `js` (15 names, none of them
`require`), so there is no way to reach Node's module loader. Attribute access must fail; a usable
require is an escape."""

import js

from ._util import denied, escaped


def run(host, args):
    require = getattr(js, "require", None)
    if require is None:
        return denied("AttributeError", "js has no require")
    try:
        module = require("child_process")
    except Exception as error:  # noqa: BLE001 - calling it must still fail
        return denied(type(error).__name__, error)
    return escaped("required", f"got {type(module).__name__}")
