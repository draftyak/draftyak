CREATE TABLE native_provider_consents (
 account_id TEXT NOT NULL CHECK(length(account_id)=26),
 instance_id TEXT NOT NULL CHECK(length(instance_id)=26),
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 16384),
 mac TEXT NOT NULL CHECK(length(mac)=64),
 PRIMARY KEY (account_id, instance_id)
) STRICT;
