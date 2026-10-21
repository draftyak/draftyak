# Native capture boundary

The runner selects fixed, provenance-checked native executable paths, argument
arrays, working directories and explicit environment entries. The capture API
does not establish executable provenance, policy authority or graph freshness.
It never starts a shell, searches PATH for an executable, or forwards process
output to the console. Shell shims and named shell interpreters are refused.

The createEvidenceDirectory API creates a new exclusive external directory.
An omitted directory uses a fresh OS temporary directory. Existing directories,
observed links in any ancestor, checkout containment and ancestors containing a
.git marker are refused. The opaque frozen handle is valid only in the current
process. Directory and file identities are checked again during writes,
completion and reads. Capture IDs use one lowercase ASCII letter followed by
at most 47 lowercase letters, digits or hyphens, without a trailing line
terminator. A run permits at most 32 distinct IDs; IDs are never reused,
including after failure.

The captureNativeProcess API uses native argument arrays with shell:false,
ignored stdin, separate stdout/stderr pipes and an explicit environment.
Environment keys are limited to platform home/temp/PATH, SystemRoot,
Cargo/Rustup location/toolchain/offline and color controls. No ambient
environment is inherited. On Windows, Node's fixed platform fallback keys are
explicitly blanked before applying caller entries, preventing Node from adding
ambient values. Windows keys are normalized to uppercase; duplicate case aliases
are refused. The runner supplies exact production values.
There are at most 64 arguments, 8 KiB per argument and 64 KiB in total;
environment values are at most 8 KiB each and 32 KiB in total.

The optional `CARGO` entry accepts only that exact key spelling. Its value must
pass the same absolute native-executable checks as the command, before capture
files or a child are created. Empty values, scripts, shell interpreters and case
aliases are refused. Omission never inherits an ambient `CARGO`. Arguments and
environment scalars are copied before filesystem validation awaits. The requested
invocation path is retained after validation, including its basename; it is not
replaced with the resolved path, which could change rustup proxy dispatch.
Native-header checks do not establish Cargo identity, toolchain provenance or
child-tool behavior. The trusted driver must separately bind and recheck its
selected tool. This optional entry does not connect a native audit driver or
change the production `BASIS_UNAVAILABLE` refusal.

Each stream has its own exclusive, non-following binary file named
capture-ID.stdout.bin or capture-ID.stderr.bin. Stdout is capped at 16 MiB and
stderr at 4 MiB. Each incoming native Buffer extent is checked before creating
a view or writing; backpressure keeps at most one pending write per stream.
A chunk exceeding the remaining budget is refused in full. A partial failed
capture therefore need not end exactly at its limit. Files are private where
platform modes apply, have one link, and are never overwritten.

The frozen result contains only runId, id, numeric exitCode or null,
allowlisted Node signal string or null, fixed failure code or null, and two
records containing file, bytes and sha256. The SHA-256 binds exactly the stored
bytes. An ordinary nonzero exit is preserved without becoming capture failure
or policy acceptance. No exception includes child prose, filesystem error text,
absolute paths or raw command output. A failure result cannot be consumed as
complete evidence.

The readCapturedBytes API accepts only the actual result object issued for the
same handle. Deserialized or copied records are refused. It rechecks scope,
file identity, one-link status, bounded size, EOF and SHA-256 before returning
bytes. The policy runner must additionally reject unexpected exits/signals and
bind capture IDs and digests to its fixed command plan.

The total execution budget is a safe integer from 50 ms through 600,000 ms.
Up to two seconds (half the budget for shorter runs) is reserved for teardown,
so a timed operation can be refused before the full budget elapses. Both a
settled child and closed pipes are required for normal completion. POSIX uses
an owned detached process group. Windows invokes the native SystemRoot
System32/taskkill.exe with /PID <owned-live-child> /T /F, without a shell,
and requires captured completion. Termination never selects an exited parent
or an unowned PID. If ownership or tree completion cannot be established,
including a parent that exits while descendants retain pipes, the result is
TREE_UNCONFIRMED; it does not authorize evidence consumption. No Job Object
launcher is available here, and arbitrary orphan-grandchild cleanup is not
guaranteed. The runner must not retry termination using a stale PID.

These checks assume a trusted local OS, executable provenance, clock and
filesystem. They detect observed replacement/link/content changes; they do not
defeat a privileged local process racing every filesystem observation. A wedged
host filesystem can also prevent file completion after child teardown.
The public errors/result formatting does not impose logging policy on native
tools. Raw files stay external and require appropriate handling by their reader.
## Native metadata file bridge

`withCapturedFile` is a privileged producer-only bridge for a native tool's fixed metadata-file argument. It accepts the original opaque run/capture objects, validates the live file before the callback, and validates the same identity and digest again after the awaited callback, including a throwing callback. A serialized capture cannot select a file. The absolute path exists only inside the trusted callback and is not a result field. This does not create an OS file lease or defeat concurrent change-and-restore attacks; exclusive trusted-host stability remains required.
