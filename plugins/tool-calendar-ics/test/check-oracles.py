"""Development-only independent check; never imported by the plugin or workspace tests."""
import hashlib
import importlib.metadata
import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import dateutil.rrule

assert importlib.metadata.version("python-dateutil") == "2.9.0.post0"
fixture = Path(__file__).parent / "fixtures" / "recurrence-oracles.json"
cases = json.loads(fixture.read_text(encoding="utf-8"))
assert len(cases) == 45
assert sum(bool(case.get("unsupported")) for case in cases) == 4
for case in cases:
    start = datetime.strptime(case["start"], "%Y%m%d" if case.get("date") else "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    actual = [value.strftime("%Y-%m-%dT%H:%M:%SZ") for value in dateutil.rrule.rrulestr(case["rule"], dtstart=start)]
    assert actual and actual[0] == start.strftime("%Y-%m-%dT%H:%M:%SZ"), case["id"]
    assert actual == case["times"], case["id"]
module = Path(dateutil.rrule.__file__)
distribution = importlib.metadata.distribution("python-dateutil")
record = next(item for item in distribution.files if str(item).endswith(".dist-info/RECORD"))
wheel_sha = None
if len(sys.argv) == 2:
    wheel = Path(sys.argv[1])
    assert wheel.name == "python_dateutil-2.9.0.post0-py2.py3-none-any.whl"
    with zipfile.ZipFile(wheel) as archive:
        assert archive.read("dateutil/rrule.py") == module.read_bytes()
    wheel_sha = hashlib.sha256(wheel.read_bytes()).hexdigest()
print(json.dumps({"oracle": "python-dateutil", "version": distribution.version, "cases": len(cases), "rruleSha256": hashlib.sha256(module.read_bytes()).hexdigest(), "recordSha256": hashlib.sha256(distribution.locate_file(record).read_bytes()).hexdigest(), "wheelSha256": wheel_sha, "fixtureSha256": hashlib.sha256(fixture.read_bytes()).hexdigest(), "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}, sort_keys=True))
