"""subprocess: no fork/exec exists in the WASM runtime and no --allow-child-process grant is present,
so Popen must raise. A live child is an escape."""

import subprocess  # noqa: S404 - importing it is the point; it must not be usable

from ._util import denied, escaped


def run(host, args):
    try:
        completed = subprocess.run(
            ["echo", "dy-escape"], capture_output=True, timeout=5, check=False
        )
    except Exception as error:  # noqa: BLE001 - any refusal shape counts as denied
        return denied(getattr(error, "code", None) or type(error).__name__, error)
    return escaped("ran", f"returncode={completed.returncode}")
