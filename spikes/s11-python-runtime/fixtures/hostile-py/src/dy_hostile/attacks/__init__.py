"""The hostile attempts, one module each (§9.2 Python rows). Each exposes run(host, args) -> dict with
an `outcome` of "denied" or "escaped" and content-free diagnostics (an exception type, a status, a
boolean). None returns the bytes it tried to read."""

from . import (
    codegen,
    js_require,
    off_profile_request,
    open_canaries,
    os_system,
    process_binding,
    run_js,
    socket_connect,
    subprocess_run,
    write_plugin_dir,
    write_runtime_dir,
)

ATTACKS = {
    "os_system": os_system.run,
    "subprocess": subprocess_run.run,
    "socket": socket_connect.run,
    "off_profile_request": off_profile_request.run,
    "open_canaries": open_canaries.run,
    "js_require_child_process": js_require.run,
    "process_binding_fs": process_binding.run,
    "run_js": run_js.run,
    "codegen": codegen.run,
    "write_plugin_dir": write_plugin_dir.run,
    "write_runtime_dir": write_runtime_dir.run,
}
