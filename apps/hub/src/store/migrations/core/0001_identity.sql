CREATE TABLE hub_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  identity_wrapped BLOB,
  statement_wrapped BLOB,
  identity_cert TEXT
) STRICT;
INSERT INTO hub_meta(singleton) VALUES(1);
CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE approval_pins (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  salt BLOB NOT NULL,
  hash BLOB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
) STRICT;
