CREATE TABLE native_admin_operations (
 id TEXT PRIMARY KEY CHECK(length(id)=26),
 kind TEXT NOT NULL CHECK(kind='account.mode-full'),
 owner_user_id TEXT NOT NULL REFERENCES users(id),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
 account_id TEXT NOT NULL CHECK(length(account_id)=26),
 account_generation INTEGER NOT NULL CHECK(account_generation BETWEEN 1 AND 9007199254740990),
 state TEXT NOT NULL CHECK(state IN ('pending','applied')),
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 2 AND 32768),
 audit_seq INTEGER NOT NULL CHECK(audit_seq BETWEEN 1 AND 9007199254740991),
 audit_mac TEXT NOT NULL CHECK(length(audit_mac)=64),
 mac TEXT NOT NULL CHECK(length(mac)=64)
) STRICT;
CREATE INDEX native_admin_operations_owner ON native_admin_operations(owner_user_id,state);
