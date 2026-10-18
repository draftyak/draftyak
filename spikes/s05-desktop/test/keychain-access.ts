// One keychain item's access list as `security dump-keychain -a` prints it (Apple's Security
// source, SecurityTool/macOS/keychain_utilities.c, print_access), reduced to content-free facts
// for keyring-macos.json. `security` lists an entry's applications only in the app-list form,
// whose subject always ends in a keychain-prompt subject (OSX/libsecurity_keychain/lib/ACL.cpp,
// ACL::parse; SecACL.cpp, SecACLCopySimpleContents). With prompts allowed, securityd asks the user
// through that subject when a binary the item doesn't trust, such as an update with a new code
// identity, wants the item, and Always Allow adds that binary and its partition ID
// (securityd/src/acl_keychain.cpp; acls.cpp, extendPartition).

// keyring-macos.json's `prompts`: how the probe runs. Evidence strings stay within the kit's 256
// characters, which the unit tests check, because only a billed macOS run reaches this case.
export const KEYCHAIN_PROMPTS =
	"off (SecKeychainSetUserInteractionAllowed false): a check only a prompt could pass fails as errSecAuthFailed (-25293); a step needing UI that can't be shown fails as errSecInteractionNotAllowed (-25308)";

export interface AccessEntry {
	readonly authorizations: readonly string[];
	/** Whether its prompt asks for the keychain's password; null when `security` shows neither. */
	readonly requirePassword: boolean | null;
	/**
	 * appList: trusted apps and a keychain-prompt subject; anyApp: no app check; partitionIds and
	 * integrity: the item's partition list and digest; custom: a form `security` can't list.
	 */
	readonly form: "appList" | "anyApp" | "partitionIds" | "integrity" | "custom";
	/** appList: each trusted app's code requirement, by its first keyword (cdhash, identifier…). */
	readonly apps?: readonly string[];
	/** partitionIds: each partition ID's kind (cdhash, teamid, apple…). */
	readonly partitionIds?: readonly string[];
}

export interface ItemAccess {
	readonly entries: readonly AccessEntry[];
	/** Whether an entry that authorizes decrypt holds a keychain-prompt subject; null if none does. */
	readonly decryptPrompt: boolean | null;
}

const keyword = (text: string): string => {
	const found = /^[(!\s]*([a-z]+)\b/.exec(text)?.[1];
	return found ?? "other";
};

function entry(lines: readonly string[]): AccessEntry {
	const authorizations = (/^authorizations \(\d+\):(.*)$/.exec(lines[0] ?? "")?.[1] ?? "")
		.split(" ")
		.filter((tag) => tag !== "");
	const requirePassword = lines.includes("require-password")
		? true
		: lines.includes("don't-require-password")
			? false
			: null;
	const shared = { authorizations, requirePassword };
	if (authorizations.includes("partition_id")) {
		const ids = lines.find((line) => line.startsWith("description: "))?.slice(13) ?? "";
		const kinds = ids.startsWith("invalid partition ID")
			? ["invalid"]
			: ids.split(", ").map((id) => /^([a-z]+):/.exec(id)?.[1] ?? "other");
		return { ...shared, form: "partitionIds", partitionIds: kinds };
	}
	if (authorizations.includes("integrity")) return { ...shared, form: "integrity" };
	if (lines.includes("applications: <null>")) return { ...shared, form: "anyApp" };
	if (!lines.some((line) => /^applications \(\d+\):$/.test(line))) {
		return { ...shared, form: "custom" };
	}
	const apps = lines
		.filter((line) => line.startsWith("requirement: "))
		.map((line) => keyword(line.slice(13)));
	return { ...shared, form: "appList", apps };
}

/** The access list of the item whose account is `account`; undefined when the dump has none. */
export function itemAccess(dump: string, account: string): ItemAccess | undefined {
	const accountLine = `"acct"<blob>="${account}"`;
	const item = dump
		.split(/^(?=keychain: )/m)
		.map((text) => text.split(/\r?\n/))
		.find((lines) => lines.some((line) => line.trim() === accountLine));
	const start = item?.findIndex((line) => /^access: \d+ entries$/.test(line)) ?? -1;
	if (item === undefined || start < 0) return undefined;
	const groups: string[][] = [];
	for (const line of item.slice(start + 1)) {
		if (/^\s+entry \d+:$/.test(line)) groups.push([]);
		else if (line.trim() !== "") groups.at(-1)?.push(line.trim());
	}
	const entries = groups.map(entry);
	const decrypting = entries.filter(
		(found) => found.authorizations.includes("decrypt") || found.authorizations.includes("any"),
	);
	const decryptPrompt =
		decrypting.length === 0 ? null : decrypting.some((found) => found.form === "appList");
	return { entries, decryptPrompt };
}
