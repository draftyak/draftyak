// Test-only bindings for the signed NativeApp wrapper's one-bundle graph.
// The executable workload imports its virtual prelude and supplies the assertions.
import "reflect-metadata";

export { MasterKey, openHubSession } from "../../../src/index.ts";
export {
	assertNativeAppAdmissionCurrent,
	closeNativeAppAdmission,
	nativeAppAdmissionArchive,
	nativeAppAdmissionCandidateArchive,
	nativeAppAdmissionFormat,
	nativeAppAdmissionInputs,
	nativeAppAdmissionReviewInputs,
	openNativeAppAdmission,
} from "../../../src/installer/native-app-admission.ts";
export {
	assertNativePluginInstallerCatalogueCurrent,
	closeNativePluginInstaller,
	nativePluginInstallerCatalogue,
	openNativePluginInstaller,
} from "../../../src/plugins/installer/index.ts";
export { openNativeBackupRecovery } from "../../../src/recovery/backup-recovery.ts";
