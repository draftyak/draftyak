"""A write into the plugin bundle dir on the host. A Python plugin gets no write grant at all, and its
read grant was dropped, so mounting the dir and writing through it must be refused. The harness also
checks that no file appeared on the host."""

import os

import pyodide_js

from ._util import denied, escaped

MARK = "dy-escape-write"


def attempt(host_dir, mount):
    try:
        pyodide_js.mountNodeFS(mount, host_dir)
    except Exception as error:  # noqa: BLE001 - mounting a dropped dir is refused
        return denied(type(error).__name__, "mount refused")
    try:
        with open(os.path.join(mount, "dy_pwned.txt"), "w", encoding="utf-8") as handle:
            handle.write(MARK)
        return escaped("wrote", "file written through mount")
    except Exception as error:  # noqa: BLE001 - a denied write is the expected outcome
        return denied(type(error).__name__, error)
    finally:
        try:
            pyodide_js.FS.unmount(mount)
        except Exception:  # noqa: BLE001 - unmount may be unavailable
            pass


def run(host, args):
    return attempt(str(args.get("pluginDir", "")), "/dy_write_plugin")
