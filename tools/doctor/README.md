# Offline runtime doctor

Check the Node version first, then run from the complete source checkout:

```sh
node --version
node --disable-sigusr1 tools/doctor/doctor.ts --data-dir <absolute-data-dir>
```

The source command uses native TypeScript stripping on supported Node. After a
workspace install, use `pnpm --filter @draftyak/doctor run doctor --help`,
`pnpm --filter @draftyak/doctor typecheck` and
`pnpm --filter @draftyak/doctor test`. Tests use the shared Vitest tiers; workers
receive `--disable-sigusr1`.
`pnpm doctor` is pnpm's own diagnostic command. This source command implements
[M10.1](../../docs/roadmap/m10.md#m101-offline-doctor); M10.2 provides the later
`draftyak doctor` integration in `apps/cli`.

The optional data directory must be absolute and contain well-formed Unicode.
Unpaired surrogates are refused before filesystem lookup, including in configured
sync roots, so filesystem string conversion cannot select a different path.
The command prints a fixed-code
JSON report and creates no data directory or support file. Unknown options,
duplicates and missing values are refused. A leading `--` is accepted for script
wrappers. Support bundles are post-MVP; `--bundle` is refused. There is no caller
artifact manifest, producer or arbitrary file-hashing option.

Exit `0` means checks passed or warned, `1` means a check failed, and `2` means
arguments or the fixed runtime policy could not be loaded. An omitted data
directory warns that its safety was not checked. The builtin-only version gate
runs before importing diagnostics, including for `--help` and linked entry paths.
It reads the minimum from `tools/fetch-node/versions.json` and reports
`NODE_UNSUPPORTED` below that floor when the entry can load. A sufficiently old
Node can reject `--disable-sigusr1` (native exit 9) or the TypeScript entry before
the bootstrap runs. `node --version` works before either requirement; if an old
Node supports native TypeScript but not that flag, invoking the command once
without the flag still refuses it as unsupported. Install the supported Node
before using the ordinary command. Importing the entry does not execute it;
`import.meta.main` handles direct invocation through a directory link on supported
Node. On a TypeScript-capable loader without that metadata, a builtin-only
canonical entry-path comparison distinguishes direct invocation from import.

Reports contain fixed check IDs, statuses, codes and explanations. They contain
no paths, command lines, environment values, filenames, raw exceptions or child
stderr. Master-key detection checks only whether `DRAFTYAK_MASTER_KEY` exists,
including an empty entry; it never retrieves its value. Directory inspection
reads only metadata and canonical paths. It never opens or enumerates user data,
databases, configuration, key files or logs.

Checks cover:

- Node's minimum version from the fixed workspace runtime policy.
- Runtime Unicode matching `SNAPSHOT_UNICODE_VERSION` from the protocol's snapshot
  module. A missing or different version fails with a fixed diagnostic; the report
  does not include the observed version.
- Effective `--disable-sigusr1` on this process: option names normalize `_` to
  `-` and ignore a boolean `=value` suffix, as Node does. The last positive or
  negated flag wins, and any active inspector fails. `NODE_OPTIONS` presence
  warns; its value is not interpreted or reported.
- A real child of the current native Node executable with fixed source and
  flags, an empty environment, no shell, ignored input, a five-second kill
  timeout and bounded output. It checks denied permission scopes, an actual
  denied filesystem metadata access, string-code refusal, unavailable SQLite,
  and acceptance of the signal-inspector and frozen-flags switches.
- Temporal presence. Only `typeof Temporal === 'undefined'` warns. In that case
  new schedules fail with `SCHEDULING_UNAVAILABLE`, calendar lookups are off and
  approved items still send. This check does not exercise time-zone conversion.
- Canonical existing directory ancestors, configured OneDrive roots and the
  private known sync-folder classification.
  That list includes Apple `Library/CloudStorage` and `Library/Mobile Documents`
  containers, Google Drive, OneDrive, Dropbox, Box and other named sync clients.
  Canonical known or configured synced paths fail with `DATA_DIR_SYNCED`. Junction
  aliases into those paths fail as aliases; an absent safe descendant warns without
  being created. Nonlocal or malformed Windows paths
  fail before lookup, including reserved device components and alternate streams.
  Absolute paths containing `.` or `..` components fail before lookup on every
  platform, including configured sync roots. Removing those components before
  resolving a symlink can change which directory the operating system selects.

The tool diagnoses its own process. Checking a separately running hub for missing
hardening is M10.2, not an attestation this command can make. The child probe
demonstrates the checked Node permission model and flags, not an OS sandbox or
every plugin escape property. It sends no signals, opens no listener and contacts
no network service. It does not execute the hub implementation.

Directory checks are a snapshot with no lock or guarantee against later path
replacement. Other sync clients without recognized names or configured roots
cannot be discovered automatically; mapped network storage is not identified.
The pure private classifier does not resolve paths or read environment variables.
It stays in this tool until M2.11's canonical hub implementation has actually
merged and flowed into M10; M10.11 then imports it and removes the private copy.
Python runtime verification against the hash list shipped with
`@draftyak/runtime-python` is M10.3 after M2c; this tool does not authenticate a
runtime supply chain.

The inline capability-probe program is a fixed string executed by native Node.
TypeScript checks the containing module, not the string program. Native tests
grant each exported permission scope and require `process.permission.has(scope)`
to return true, in addition to the all-denied production probe.
