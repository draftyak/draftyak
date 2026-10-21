# Raw database object-tree consistency

`verifyDatabaseObjectTree(expectedCommitId, objects)` is a synchronous, pure
consistency check over supplied Git object data. It does not read a repository,
filesystem, cache, network, clock or native tool. Its ordinary frozen result is
not an issued database session or evidence of source authenticity, freshness,
physical cleanliness, exclusive ownership or immutability. Production policy
availability is unchanged.

## Input and identity

Each closed data record has exactly `id`, `type` and `bytes`. The ID is canonical
lowercase 40-character hexadecimal; type is `commit`, `tree` or `blob`; bytes
are the decompressed raw payload, without a Git header. The object list must be
dense, nonempty and free of duplicate IDs or additional members. Accessor DTOs,
unknown fields, symbol members and foreign record prototypes are refused.

Non-shared Uint8Array/Buffer views are copied over their exact extent using
intrinsic accessors, before interpretation. Shared backing memory is unsupported
and refused. No buffer, blob content, commit message or unrelated header value
is returned or rendered. Failure is always `DatabaseObjectError` with
`code: INVALID_INPUT` and message `invalid database object tree`, without input
text, paths or underlying exception diagnostics.

Every object ID must equal SHA-1 of ASCII `type`, one space, canonical decimal
payload length, NUL and the raw bytes. This establishes Git identity only; it is
not a claim about SHA-1 collision resistance or trusted source delivery. In
parallel, the inventory binds SHA-256 of the same header-plus-payload bytes
(`objectSha256`) and of payload bytes alone (`contentSha256`).

The expected root must be the supplied commit object. Its first line must be
exactly `tree <40-lowercase-hex>\n`; a blank-line header/message separator is
required. A second `tree ` header before that separator is refused. Other
headers and the entire message remain opaque, including non-UTF8 message bytes.
This is not full semantic commit validation: it does not validate signatures,
identities, timestamps, parent declarations or commit-message grammar. Parent
history is not part of the supported closure and must not be supplied as extras.

## Supported tree closure

Tree entries are parsed as binary `mode SPACE name NUL 20-byte-object-id`.
Only exact modes `40000` (directory), `100644` and `100755` (regular file) are
supported. Symlinks, submodules, special modes, alternate spellings, truncation,
dangling IDs and type mismatches refuse. Input tree order must match Git byte
ordering, comparing a directory name with a trailing slash and a file name with
a terminating NUL. Duplicate names and ASCII case collisions refuse separately.

The initial portable component subset is nonempty ASCII letters, digits, dot,
underscore and hyphen. Dot/dot-dot, case-insensitive `.git`, trailing dot,
Windows device basenames (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`,
`LPT0`–`LPT9`, including extensions) refuse. Spaces, separators, colon, controls,
non-ASCII, Unicode and other punctuation are unsupported and refuse; nothing is
normalized. This conservative subset is a compatibility restriction, not proof
that every upstream name or host filesystem is representable. Physical path
containment, reparse points, links, modes and host behavior require a separate
producer.

Exactly the root commit and all recursively referenced tree/blob objects must
be supplied, with no missing or extra object. Reused blob/tree IDs are supplied
once but every directory/file path is expanded, counted and bound. Empty trees
are valid. The root directory has no empty-path row; its ID is `treeId`.

| Fixed bound | Maximum |
| --- | --- |
| Supplied objects | 10,000 |
| Unique parsed entries / expanded path rows | 10,000 each |
| Total raw payload bytes, including commit and trees | 64 MiB |
| One blob / commit / tree | 8 MiB / 64 KiB / 1 MiB |
| Components in a path | 64 |
| One full path / component | 4096 / 255 ASCII bytes |

An exact cap is allowed when all other conditions pass; any overflow refuses
without a partial inventory. Bounds cover supplied data and expanded DAG paths.
The host JavaScript runtime and built-ins remain trusted; the API is not a
sandbox for hostile executable Proxy traps or concurrent privileged host code.

## Frozen metadata and digest

Version1 output has `commitId`, `treeId`, `objectCount`, `entryCount`,
`totalObjectBytes`, `objects`, `entries` and `digest`. Each object row is
`{id,type,bytes,objectSha256,contentSha256}`. Each expanded entry row is
`{path,mode,id,type,bytes,contentSha256}` and includes directories. Rows, arrays
and result are frozen; they contain no raw buffer. Objects sort by ID and paths
sort by full exact path, both by UTF8 bytes rather than locale order.

The digest is SHA-256 of domain
`draftyak/native-dependency-policy/database-object-tree/v1\0` (ending with an
actual NUL) followed by UTF8 JSON.stringify of the ordered tuple array:

```text
[1, commitId, treeId, totalObjectBytes,
 objects.map([id, type, bytes, objectSha256, contentSha256]),
 entries.map([path, mode, id, type, bytes, contentSha256])]
```

The mapping notation describes tuple construction; field order is explicit.
Reordering supplied objects leaves the result unchanged. Changed accepted bytes,
paths or modes change the relevant hashes and inventory identity. Hashes bind
opaque content without asserting its meaning or current delivery. Future
physical materialization must separately prove exact bytes/modes, completeness,
cache/source/tool binding and stability before/after use. Current-source
delivery, host/ABA limits, native interoperability and operational policy
acceptance are outside this component.
