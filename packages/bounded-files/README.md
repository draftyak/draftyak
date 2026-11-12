# Bounded files

`@draftyak/bounded-files` is a private, dependency-free file-reading and portable
metadata component. It performs no discovery, parsing, writing or authorization.

`readBoundedRegularFile(path, {maximum, minimum?, expectedSize?})` synchronously
returns an independent `Buffer`. The path must use canonical native absolute
spelling, with no UNC prefix, links or linked ancestors. On Windows, colons beyond
the drive prefix refuse before I/O, including alternate/default-stream aliases;
POSIX native colon filenames remain ordinary files. The reader checks native
identity, one link, size and timestamps before/open/after the read and against the
current name. Reads use positional chunks of at most 64 KiB and an actual EOF
probe, followed by a matching second pass. On Windows the descriptor uses exclusive
file sharing: an existing reader or writer makes the operation refuse, and the
exclusive handle remains open through all checks. Other platforms keep their
ordinary sharing behavior. Metadata and matching passes are consistency checks,
not a universal atomic-filesystem-snapshot guarantee; callers needing authenticated
content must compare a trusted digest. Each operation closes its own descriptor
exactly once in `finally`; a failed close refuses that operation without disabling
later independent reads.

`maximum` is required and ranges from 1 byte through 512 MiB. `minimum` defaults
to zero. An explicit `expectedSize` must fit those bounds and match before reading.
Options are inert own data fields; proxies, accessors and extra fields refuse.

`portableRelativePath(value, {maximumLength, maximumComponents,
maximumComponentLength})` checks portable syntax and positive safe explicit
limits. Lengths count UTF-16 code units. It preserves primitive spelling and
rejects Windows device aliases, links' ambiguous path spellings, controls, format
characters and nonportable punctuation. It does not impose an artifact alphabet,
extension, private-file exclusion or Unicode normalization.

`assertPortableFileTree(alreadyCheckedPaths)` uses conservative lowercase collision
keys to reject duplicates/case aliases, inconsistent directory spelling and
file-as-ancestor collisions in either order. It preserves input spelling and does
not emulate every filesystem's Unicode collation. It traverses inert dense arrays
without sorting, mutating or invoking hooks. Callers validate paths and impose
their own tree count and aggregate limits.

`checkedFileRecord(value, {byteField: 'size' | 'bytes', minimum, maximum})`
admits exactly `path`, `sha256` and the selected byte field as enumerable own data
on an ordinary or null-prototype object. It returns a frozen independent
`{path, sha256, byteLength}`. The path is a well-formed primitive string; portable
syntax is checked separately. SHA-256 is exactly 64 lowercase hexadecimal
characters. Explicit integer byte bounds range from zero through 512 MiB.
Consumers map `byteLength` back to their existing size/bytes field and compare
the digest with the actual bytes; metadata alone proves neither identity nor
permission to read a file.

All refusals use `BoundedFileError` with the fixed message
`Bounded file operation refused.` and a `path`, `file`, `bounds` or `ownership`
code. Raw paths, values and native error details are not included. Path/tree
violations use `path`; malformed options use `bounds`; malformed metadata and
file checks use `file`; failed descriptor close uses `ownership`.

Selection, pre-open plan validation, counts, sorting, hashing, directory crawling,
publication, CLI lifecycle and installed-artifact authority remain with callers.
