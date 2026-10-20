export interface CertProvider {
	readonly id: string;
	/** CSR and public chain only; the private certificate key remains native. */
	obtain(csrDer: Uint8Array, names: readonly string[]): Promise<readonly Uint8Array[]>;
	readonly renewBeforeMs: number;
}
