"""Code generation from strings (§4 Flags: --disallow-code-generation-from-strings, "never the
flag"). The shim exposes ``js.Object`` in the curated jsglobals, and the ``.constructor`` of any JS
object is the ``Function`` constructor (M0.33 shim-facts: "js.fetch.constructor is Function, but the
flag blocks code from strings"). ``new Function("<body>")`` compiles a string into a callable, which
is exactly what --disallow-code-generation-from-strings forbids: V8 raises EvalError before the body
runs. This is the one code-generation path reachable from the curated ``js``, so it is the row that
positively proves the flag. If the flag were dropped or renamed, the Function would compile and run,
the returned value would appear, and the row would flip to "escaped"."""

import js

from ._util import denied, escaped


def run(host, args):
    function_ctor = getattr(getattr(js, "Object", None), "constructor", None)
    if function_ctor is None:
        return denied("AttributeError", "no Function constructor via js")
    try:
        made = function_ctor("return 40 + 2")
        value = made()
    except Exception as error:  # noqa: BLE001 - EvalError under the codegen flag is the denial
        return denied(type(error).__name__, error)
    return escaped("codegen", f"value={value}")
