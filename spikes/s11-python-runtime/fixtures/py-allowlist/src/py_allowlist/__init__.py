"""py-allowlist: the S11c C-extension allowlist probe (plan §15 S11 (c)).

Each bundle holds this probe plus one candidate's wheel closure from Pyodide's lock. The shim loads
every lock wheel before this module is imported (boot step 2), so a wheel that can't load fails the
boot. import_candidate then imports the candidate's native extension module, and run_candidate runs
one small call with a known answer. They are separate calls because a native abort ends the Pyodide
runtime: the call that dies shows which step failed. Reports are names, booleans and exception types.
"""

import importlib
import json


def _pydantic_core():
    from pydantic_core import SchemaValidator, core_schema

    schema = core_schema.typed_dict_schema(
        {"n": core_schema.typed_dict_field(core_schema.int_schema())}
    )
    return SchemaValidator(schema).validate_python({"n": "42"}) == {"n": 42}, None


def _orjson():
    import orjson

    value = {"a": [1, 2.5, "x"], "b": None}
    return orjson.loads(orjson.dumps(value)) == value, None


def _regex():
    import regex

    return regex.fullmatch(r"\p{L}+", "héllo") is not None, None


def _pyyaml():
    import yaml

    # CSafeLoader exists only when the libyaml C extension loaded.
    loaded = yaml.load("a: [1, 2]", Loader=yaml.CSafeLoader)
    return loaded == {"a": [1, 2]}, bool(yaml.__with_libyaml__)


def _rpds():
    import rpds

    return rpds.HashTrieMap({"a": 1}).insert("b", 2) == rpds.HashTrieMap({"a": 1, "b": 2}), None


def _msgspec():
    import msgspec

    class Point(msgspec.Struct):
        x: int

    point = msgspec.json.decode(b'{"x": 3}', type=Point)
    return point.x == 3 and msgspec.json.encode(point) == b'{"x":3}', None


def _lxml():
    from lxml import etree

    return etree.fromstring(b"<a><b>1</b></a>").findtext("b") == "1", None


SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def _cryptography():
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    digest = hashes.Hash(hashes.SHA256())
    digest.update(b"abc")
    aead = AESGCM(bytes(32))
    nonce = bytes(12)
    sealed = aead.encrypt(nonce, b"s11", None)
    return digest.finalize().hex() == SHA256_ABC and aead.decrypt(nonce, sealed, None) == b"s11", None


def _numpy():
    import numpy

    values = numpy.arange(10)
    return int(values.sum()) == 45 and float(numpy.dot(values, values)) == 285.0, None


# Candidate (as the lock names it) -> its package, its native extension module and the call to run.
PROBES = {
    "pydantic-core": ("pydantic_core", "pydantic_core._pydantic_core", _pydantic_core),
    "orjson": ("orjson", "orjson.orjson", _orjson),
    "regex": ("regex", "regex._regex", _regex),
    "pyyaml": ("yaml", "yaml._yaml", _pyyaml),
    "rpds-py": ("rpds", "rpds.rpds", _rpds),
    "msgspec": ("msgspec", "msgspec._core", _msgspec),
    "lxml": ("lxml", "lxml.etree", _lxml),
    "cryptography": ("cryptography", "cryptography.hazmat.bindings._rust", _cryptography),
    "numpy": ("numpy", "numpy._core._multiarray_umath", _numpy),
}

_SCHEMA = {
    "type": "object",
    "properties": {"candidate": {"type": "string"}},
    "required": ["candidate"],
}
TOOLS = [
    {
        "name": "import_candidate",
        "description": "Imports a candidate's native extension module.",
        "inputSchema": _SCHEMA,
    },
    {
        "name": "run_candidate",
        "description": "Runs a small call with a known answer.",
        "inputSchema": _SCHEMA,
    },
]


def _result(ok, structured):
    return json.dumps(
        {"content": [{"type": "text", "text": "ok" if ok else "failed"}], "structuredContent": structured}
    )


def _import(candidate):
    package, native, _ = PROBES[candidate]
    report = {"imported": False, "error": None, "moduleVersion": None}
    try:
        top = importlib.import_module(package)
        importlib.import_module(native)
    except BaseException as error:  # noqa: BLE001 - the probe reports why the import failed
        report["error"] = type(error).__name__
        return _result(False, report)
    version = getattr(top, "__version__", None)
    report["imported"] = True
    report["moduleVersion"] = version if isinstance(version, str) else None
    return _result(True, report)


def _run(candidate):
    report = {"ran": False, "error": None, "cExtension": None}
    try:
        ran, c_extension = PROBES[candidate][2]()
    except BaseException as error:  # noqa: BLE001 - the probe reports why the call failed
        report["error"] = type(error).__name__
        return _result(False, report)
    report["ran"] = bool(ran)
    report["cExtension"] = c_extension
    report["error"] = None if ran else "WrongAnswer"
    return _result(bool(ran), report)


class Plugin:
    api_version = 1

    def list_tools(self):
        return json.dumps(TOOLS)

    def call_tool(self, name, arguments, host):
        candidate = str(json.loads(arguments or "{}").get("candidate", ""))
        if candidate in PROBES and name == "import_candidate":
            return _import(candidate)
        if candidate in PROBES and name == "run_candidate":
            return _run(candidate)
        return json.dumps({"isError": True, "content": [{"type": "text", "text": "UNSUPPORTED"}]})


plugin = Plugin()
