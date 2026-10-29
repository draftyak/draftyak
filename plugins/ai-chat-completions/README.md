# Compatible completed-response core

This package constructs request descriptors and validates completed responses for
JSON-schema, JSON-object and Ollama formats. It opens no network connection,
constructs no vendor client and reads no credentials. Production mounting and
actual transport/broker authority are separate work.

`createCompatibleCore(input, trustedResolution)` requires resolution metadata
from a trusted native caller. The helper checks the existing canonical endpoint
shape and association with that supplied hostname/classification. It does not
resolve DNS, verify an address, mint egress evidence or grant trust. Presets are
configuration candidates only. Every actual request still requires the host
broker's independent current DNS, destination, URL, port and account policy.

`build()` sends the hub's supplied system and user prompt parts unchanged, with
the selected response format in separate request fields and `stream: false`.
It freezes the descriptor and records body/header hashes. `verifier()` binds the
exact endpoint, headers, body and hashes; it supplies no network authority.

`parse()` checks bounded copied response bytes, completion state, exact model,
refusal/truncation and usage before accepting shared draft output. Tool/function
calls never become drafts. Request bodies are capped at 8,388,608 UTF-8 bytes,
completed response bodies at 262,144 bytes and draft content at 131,072 UTF-8
bytes. Typed-array length/buffer accessors are not trusted; shared/subclassed
storage is refused. Model lists contain at most 500 entries.

`generate()` invokes a trusted injected transport once. It checks cancellation
before and after the call and returns invalid-schema issues without changing the
prompt or retrying. The hub owns its one repair budget and must build any repair
prompt itself. `probe()` uses one such call with synthetic content.

```powershell
pnpm --filter @draftyak/ai-chat-completions test
pnpm --filter @draftyak/ai-chat-completions typecheck
pnpm --filter @draftyak/ai-chat-completions build
```

The only runtime dependency is the merged shared protocol package. All tests use
synthetic values and injected transports. Limits apply after a complete body is
supplied; actual transport accumulation, stream/progress/deadline enforcement
and production integration remain separate. This is a prepared M7 foundation.
