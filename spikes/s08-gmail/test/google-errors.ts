// Gmail error bodies, after "Resolve errors" in the Gmail API guides
// (https://developers.google.com/workspace/gmail/api/guides/handle-errors). The 403 bodies are the
// documented examples. The 429 bodies are built from the documented message texts ("Too many
// concurrent requests for user"; "User-rate limit exceeded" with "(Mail sending)" and a time to
// retry): M0.29 records the live concurrency shape, and "Mail sending" is never provoked.

export interface GoogleErrorBody {
	readonly error: {
		readonly errors: readonly {
			readonly domain: string;
			readonly reason: string;
			readonly message: string;
		}[];
		readonly code: number;
		readonly message: string;
		readonly status: string;
	};
}

function body(
	code: number,
	reason: string,
	message: string,
	status: string,
	domain = "usageLimits",
): GoogleErrorBody {
	return { error: { errors: [{ domain, reason, message }], code, message, status } };
}

export const concurrent429: GoogleErrorBody = body(
	429,
	"rateLimitExceeded",
	"Too many concurrent requests for user",
	"RESOURCE_EXHAUSTED",
);

// Without retryAt: the same lock, should Gmail ever leave out the time.
export function mailSending429(retryAt?: string, reason = "rateLimitExceeded"): GoogleErrorBody {
	const after = retryAt === undefined ? "" : `  Retry after ${retryAt}`;
	const message = `User-rate limit exceeded.${after} (Mail sending)`;
	return body(429, reason, message, "RESOURCE_EXHAUSTED");
}

export const userRateLimit403: GoogleErrorBody = body(
	403,
	"userRateLimitExceeded",
	"User Rate Limit Exceeded",
	"PERMISSION_DENIED",
);
export const rateLimit403: GoogleErrorBody = body(
	403,
	"rateLimitExceeded",
	"Rate Limit Exceeded",
	"PERMISSION_DENIED",
);
export const dailyLimit403: GoogleErrorBody = body(
	403,
	"dailyLimitExceeded",
	"Daily Limit Exceeded",
	"PERMISSION_DENIED",
);
export const domainPolicy403: GoogleErrorBody = body(
	403,
	"domainPolicy",
	"The domain administrators have disabled Gmail apps.",
	"PERMISSION_DENIED",
	"global",
);
export const invalid400: GoogleErrorBody = body(
	400,
	"invalidArgument",
	"Invalid To header",
	"INVALID_ARGUMENT",
	"global",
);
export const backend500: GoogleErrorBody = body(
	500,
	"backendError",
	"Backend Error",
	"INTERNAL",
	"global",
);

export function errorResponse(
	status: number,
	value: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8", ...headers },
	});
}
