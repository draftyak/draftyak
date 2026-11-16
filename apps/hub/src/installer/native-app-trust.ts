/** Fixed release-build input. Runtime callers cannot configure an application trust root. */
export interface NativeAppReleaseTrust {
	readonly version: string;
	readonly publicKeyDer: string;
	readonly executable: string;
	readonly entry: string;
	readonly module: string;
}

// A signed native release must supply its reviewed publisher key and exact installed layout.
// Development builds have no signed-application admission authority.
export const nativeAppReleaseTrust: Readonly<NativeAppReleaseTrust> | undefined = undefined;
