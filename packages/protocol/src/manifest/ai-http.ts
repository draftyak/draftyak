// API shapes only. An additional native profile adds one entry here; no transport is defined.
export const AI_HTTP_PROFILES = [
	"messages-api-v1",
	"responses-api-v1",
	"chat-completions-v1",
] as const;
Object.freeze(AI_HTTP_PROFILES);
export type AiProfile = (typeof AI_HTTP_PROFILES)[number];
