CREATE TABLE gmail_credentials (
 account_id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(account_id AS BLOB))=26),
 user_id TEXT NOT NULL CHECK(length(CAST(user_id AS BLOB))=26),
 credential_ref TEXT UNIQUE NOT NULL REFERENCES credentials(id),
 invalid_at INTEGER,
 delete_at INTEGER,
 CHECK((invalid_at IS NULL AND delete_at IS NULL) OR
       (invalid_at IS NOT NULL AND delete_at IS NOT NULL AND
        invalid_at >= 0 AND delete_at >= invalid_at AND delete_at <= 9007199254740991))
) STRICT;
