import type { OwnerSettingsFieldProps } from "./OwnerSettingsField.tsx";

interface SettingsEditorData {
	readonly editor: OwnerSettingsFieldProps;
	readonly submission: "idle" | "pending" | "failed";
	/** Local presentation reset after an actual canonical PUT response, not a server revision. */
	readonly submissionVersion?: number;
	readonly refresh?:
		| { readonly status: "pending" }
		| { readonly status: "failed"; readonly retry: () => void | Promise<void> };
}

export type OwnerSettingsState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly retry: () => void | Promise<void> }
	| ({ readonly status: "ready" } & SettingsEditorData)
	| ({
			readonly status: "setup";
			readonly recoveredAttempt?: true;
			/** Local intent identity, never a server revision or permission. */
			readonly recoveryKey?: object;
	  } & SettingsEditorData);
