import * as z from "zod";

// First import of the view: zod decides whether to compile a schema with new Function when the
// schema is built, and module-level schemas in the SDK are built on import. Under the view's CSP
// even the probe for eval is a reported violation.
z.config({ jitless: true });
