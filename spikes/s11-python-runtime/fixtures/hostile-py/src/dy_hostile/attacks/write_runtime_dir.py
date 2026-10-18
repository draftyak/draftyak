"""A write into the shared runtime dir on the host. Same defence as write_plugin_dir: no write grant,
the read grant dropped, so mounting and writing is refused. Tampering with the runtime would also be
caught before the next spawn by the hash list, but the point here is that the running plugin cannot
reach it at all."""

from .write_plugin_dir import attempt


def run(host, args):
    return attempt(str(args.get("runtimeDir", "")), "/dy_write_runtime")
