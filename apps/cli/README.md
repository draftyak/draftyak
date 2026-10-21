# CLI payload

`@draftyak/cli` is a private workspace package. The executable and distribution
name remain `draftyak`; distribution and protected launchers belong to packaging.
This package publishes nothing.

`main(argv: readonly string[]): Promise<number>` is the inert payload API. Importing
it performs no command discovery, I/O, environment intake or process lifecycle
registration. Calls snapshot literal arguments before the first await and return
an integer from 0 through 255. The API never calls `process.exit` or changes
`process.exitCode`. `CLI_PAYLOAD` and `isCliExitCode` are exported through
`@draftyak/cli/payload-contract` for launchers and packers.

Arguments are dense native arrays with own string data elements. Arrays from
another realm work; proxies, accessor elements and holes refuse. Each string
must be well formed and contain no NUL. Limits are 256 arguments, 65,536 UTF-8
bytes per argument and 262,144 UTF-8 bytes total, inclusive. No trimming,
normalization, shell expansion, coercion or environment substitution occurs.

Only `help` is currently implemented. No arguments, `help`, `--help` and `-h`
list the installed commands on stderr. Invalid argument data and command loading
or execution failures return 1 with `Command refused.` on stderr; unknown
commands return 2 with that same diagnostic. Help options it does not implement
return 2. Diagnostics never echo arguments or native exceptions. The dispatcher
writes no stdout, including unknown `mcp` invocations. A future bridge owns MCP
framing on stdout for its entire invocation.

## Discovery and building

Commands export exactly `command: Command` from `src/commands/<name>.ts`.
Diagnostic modules export exactly `check: DoctorCheck` from
`src/doctor/checks/<id>.ts`. Names are lowercase ASCII letters/digits separated
by single hyphens, at most 64 characters, and match the filename. Supporting
modules stay outside those registry directories. Modules must be inert when
imported. There is no handwritten registration list or caller-selected load root.

`loadDoctorChecks()` and `runDoctorChecks(mode)` are exported through
`@draftyak/cli/doctor`; no doctor command is installed yet. Check modes are
`local` and `public`; only the fixed statuses `ok`, `warn` and `error` leave a
check. Missing checks produce an explicit unavailable report with exit code 1.
Malformed or duplicate records refuse; thrown or invalid check results become
`error`. Real native checks and commands remain their feature owners' work.

Run `pnpm --filter @draftyak/cli build`. The pinned TypeScript compiler emits the
complete source tree and declarations. Its native AST API checks that module
dependencies are Node builtins or relative modules within this package; computed
imports are confined to the fixed module loader. Payload imports/re-exports of
`module`, `node:module`, `process` or `node:process` are unsupported, including
renamed, namespace and dynamic imports. Named `getBuiltinModule`/`mainModule`
references and string or no-substitution template member lookups or binding keys
of those names refuse, including quoted and computed keys in destructuring
declarations and assignments. Nested object/array targets follow the same rule;
ordinary quoted-key object construction and default-value data remain data. Literal
`process` member lookups and binding keys also refuse; global `process` is
supported only through direct static properties such as `process.stderr`.
Computed lookup, destructuring or aliasing that global refuses. Use ordinary builtin or in-package
relative ESM imports instead. All command and check files are
compiled automatically. The build generates an exact installed filename/hash
catalog and refuses a missing emitted registry module.

The entry is `dist/main.mjs`, staged as `cli/main.mjs`; preserve the entire `dist`
tree inside `cli`, including `package.json`. An explicit ESM package boundary
makes support `.js` modules work beneath a CommonJS ancestor. Supported module
loading resolves only builtins and the owned relative closure, without workspace
dependencies or ancestor `node_modules` resolution. Installed
discovery checks the catalog for missing, extra, linked or changed files before
loading commands/checks. The catalog and framework are trusted payload code;
distribution integrity must authenticate the complete payload before import.
These checks do not replace packaging's outer artifact verification.
The dependency audit does not establish confinement for arbitrary reflective or
generated JavaScript and is not an operating-system sandbox.

Run package unit/typecheck/build checks and the strict heavy tier for compiled,
isolated staging and automatic discovery. Native hub lifecycle, authority,
unlock/control and real diagnostics remain M2.11 acceptance after their services
merge; this payload mechanism does not implement them.
