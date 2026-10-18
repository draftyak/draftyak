# Remote MCP foundations

This branch combines bounded untrusted metadata transport/cache bytes,
purpose-specific CIMD limits, immutable metadata configuration and optional native
socket CIDR filtering directly on the current `origin/m9` base `5fbaf89`. It changes
no protocol contracts and imports no unmerged native kernel dependency.

Combined verification passes 131 tests across five files. Ordinary frozen
installation, hub typecheck, scoped Biome, whitespace checks and repository guard
pass; guard reports zero findings in 792 files. These are component and local
transport checks, not a public authorization-server acceptance run.

Full Windows verification remains pending the shared benchmark rule. A later
submission must reconcile with the current base and include that verification.
Public routes/issuer, metadata-document acceptance, registration/consent, token
rotation, native listener/proxy-policy wiring, device-session enforcement and
actual client/tunnel acceptance remain separate work and owner-controlled gates.
No public server or vendor request is introduced by this branch.
