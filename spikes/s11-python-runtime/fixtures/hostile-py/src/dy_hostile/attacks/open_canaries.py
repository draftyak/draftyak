"""open() on the MK stand-in and home canaries. The read grants were dropped before import, so the
host filesystem is unreachable: a plain open() hits the in-memory MEMFS (no such file), and
mounting the host dir with pyodide_js.mountNodeFS is refused by the permission model. Seeing any
canary marker is an escape; the markers are compared but never returned."""

import os

import pyodide_js

from ._util import denied, escaped

MOUNT = "/dy_canary_mnt"


def run(host, args):
    fake_dir = str(args.get("fakeDir", ""))
    canaries = args.get("canaries", []) or []
    markers = [str(c.get("marker", "")) for c in canaries if c.get("marker")]
    names = [str(c.get("name", "")) for c in canaries]
    attempts = []

    # 1) Plain open() of the host paths: resolves against MEMFS, which holds none of them.
    for name in names:
        for candidate in (name, os.path.join(fake_dir, name)):
            try:
                with open(candidate, encoding="utf-8") as handle:
                    body = handle.read()
                if any(marker and marker in body for marker in markers):
                    return escaped("memfs-read", "canary marker read")
                attempts.append("read-no-marker")
            except Exception as error:  # noqa: BLE001 - a missing/denied file is expected
                attempts.append(type(error).__name__)

    # 2) Mount the host dir and read through it: refused post-drop (no fs.read grant).
    try:
        pyodide_js.mountNodeFS(MOUNT, fake_dir)
    except Exception as error:  # noqa: BLE001 - the mount itself is refused
        return denied(type(error).__name__, f"mount refused; {attempts[:3]}")
    try:
        for name in names:
            try:
                with open(os.path.join(MOUNT, name), encoding="utf-8") as handle:
                    body = handle.read()
                if any(marker and marker in body for marker in markers):
                    return escaped("mounted-read", "canary marker read")
            except Exception as error:  # noqa: BLE001 - a denied read is the expected outcome
                attempts.append(type(error).__name__)
    finally:
        try:
            pyodide_js.FS.unmount(MOUNT)
        except Exception:  # noqa: BLE001 - unmount may be unavailable
            pass
    return denied("no-read", f"{attempts[:4]}")
