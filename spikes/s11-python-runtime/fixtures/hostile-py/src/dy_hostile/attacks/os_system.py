"""os.system: Pyodide bridges it to the JS side; under --permission with no --allow-child-process
nothing may spawn. A nonzero return or a raise is a denial; the harness also checks no side-effect
file appeared on the host."""

import os

from ._util import denied, escaped


def run(host, args):
    try:
        rc = os.system("echo dy-escape")
    except OSError as error:
        return denied(getattr(error, "code", None) or type(error).__name__, error)
    except Exception as error:  # noqa: BLE001 - any refusal shape counts as denied
        return denied(type(error).__name__, error)
    return denied("rc", f"os.system returned {rc}") if rc != 0 else escaped("rc0", "returned 0")
