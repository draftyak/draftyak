"""Sockets (§9.2 Python row). A python plugin must not open a socket to anywhere, with or without
``--allow-net``. The attack is pointed at a LIVE loopback listener the harness runs, whose accept
counter is the authoritative escape signal: a successful connect flips the row to "escaped", so the
row would catch a regression that granted the net permission. Two paths are tried:

  1) the default Emscripten SOCKFS, which emulates sockets over a WebSocket (``require('ws')``) and
     fails to a plain TCP listener regardless of the net grant (so it can only report a denial);
  2) ``pyodide_js.useNodeSockFS()``, which switches to Node's real ``net`` sockets. Under the
     production flags (no ``--allow-net``) the connect is refused by the permission model and the
     listener accepts nothing; with the net grant it would connect and the listener would accept.

The attack reports only an outcome and an exception type or errno, never an address or any bytes.
"""

import json
import socket

import pyodide_js
from pyodide.ffi import run_sync

from ._util import denied, escaped


def _node_sock_connect(connect_host, port):
    # asyncio over NodeSockFS reaches Node's real net.connect; run_sync drives it synchronously.
    import asyncio

    pyodide_js.useNodeSockFS()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setblocking(False)
    loop = asyncio.new_event_loop()
    try:
        run_sync(loop.sock_connect(sock, (connect_host, port)))
    finally:
        try:
            sock.close()
        except Exception:  # noqa: BLE001 - close may itself be unavailable
            pass


def run(host, args):
    connect_host = str(args.get("connectHost", "127.0.0.1"))
    port = int(args.get("connectPort", 0))
    attempts = []

    # 1) Default SOCKFS (WebSocket-emulated). A blocking connect to the plain TCP listener cannot
    # complete; it is tried for completeness and can only report a denial.
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3)
        sock.connect((connect_host, port or 9))
        sock.close()
        return escaped("sockfs-connect", "connected")
    except Exception as error:  # noqa: BLE001 - a refused connect is the expected denial
        attempts.append(f"sockfs:{getattr(error, 'errno', None) or type(error).__name__}")

    # 2) Real Node sockets via useNodeSockFS: the stronger path. A connect here, or the listener
    # accepting one, is a true escape; the permission model refuses it under the production flags.
    if port:
        try:
            _node_sock_connect(connect_host, port)
            return escaped("nodesock-connect", "connected")
        except Exception as error:  # noqa: BLE001 - refused by the permission model
            attempts.append(f"nodesock:{getattr(error, 'errno', None) or type(error).__name__}")

    return denied("no-socket", json.dumps(attempts)[:60])
