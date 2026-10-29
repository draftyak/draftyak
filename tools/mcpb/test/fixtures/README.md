# MCPB format test reference

`mcpb-manifest-v0.3.schema.json` is the unmodified official JSON Schema from
[modelcontextprotocol/mcpb at 70fe3b34cd6dff1b3bba046638edc72a6467a4fb](https://github.com/modelcontextprotocol/mcpb/blob/70fe3b34cd6dff1b3bba046638edc72a6467a4fb/schemas/mcpb-manifest-v0.3.schema.json).
It is 7,902 bytes, with SHA-256
`3a0ac9d845711a1b9b17dfa5a52f8b60628239d6a86a9db417206a9efc78592d`.

This test-only reference has no execution or network behavior. The existing
workspace `@cfworker/json-schema` 4.1.1 validates the generated manifest against
it offline. No new dependency, client configuration or installed bundle is used.
