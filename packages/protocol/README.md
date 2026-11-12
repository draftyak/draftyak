# Protocol package exports

Public subpaths use their exact canonical names in both the workspace and packed export maps. Adding a public module requires an explicit entry in both maps.

`@draftyak/protocol/plugin-stdio` is a Node-only entry; its implementation subpaths are private. Unknown subpaths and alternate-case aliases are not exported.

`@draftyak/protocol/plugin-argv` is also Node-only. `buildPluginArgv(spec)` builds the
complete canonical Node-runtime argv (excluding the executable). `spec` contains
`pluginDir`, optional `dataDir`, `entry`, optional `entryArgs`, and optional
`runtime: 'node'`. Python is unsupported. `checkPluginArgv(argv, expected)` returns
an empty problem list only for that exact canonical argv, including every fixed
flag, grant, value, order, entry and application argument. `expected` must come
from separately trusted parent configuration, never from the argv being checked.
Flag-looking application arguments after the entry are data; NUL arguments are
refused. The frozen allowlist/never-list describe exec flags, not application data.

Paths use the current OS's absolute-path grammar, reject wildcard/grant delimiters
and controls, and require disjoint plugin/data roots (case folded on Windows).
These are lexical checks only. The caller must supply already verified real paths
and still enforce link/regular-file checks, entry containment, bundle identity,
per-plugin grant policy, environment scrubbing and safe spawn/stdio handling.
This module does not read files, inspect executables or start a process.

`PLUGIN_NODE_MINIMUM_VERSION` is `26.5.1`. `isPluginNodeVersionSupported(version)`
accepts stable `major.minor.patch` releases at or above that floor, optionally
prefixed with `v`; it refuses prereleases, build suffixes and malformed versions.
The process consumer must check the actual executable and refuse a below-floor
launch. Pure version checks do not prove any platform's production sandbox.
