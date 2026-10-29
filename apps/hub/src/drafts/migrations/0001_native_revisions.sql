CREATE TABLE native_drafts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 8192),
  audit_seq INTEGER NOT NULL CHECK(audit_seq>0),
  mac TEXT NOT NULL CHECK(length(mac)=64)
) STRICT;
CREATE TABLE native_draft_revisions (
  draft_id TEXT NOT NULL REFERENCES native_drafts(id),
  rev INTEGER NOT NULL CHECK(rev BETWEEN 1 AND 10000),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152),
  previous TEXT NOT NULL CHECK(length(previous) IN (0,64)),
  mac TEXT NOT NULL CHECK(length(mac)=64),
  PRIMARY KEY(draft_id,rev)
) STRICT;
CREATE TABLE native_draft_locks (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  draft_id TEXT NOT NULL REFERENCES native_drafts(id),
  outbox_id TEXT UNIQUE NOT NULL CHECK(length(outbox_id)=26),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152),
  audit_seq INTEGER NOT NULL CHECK(audit_seq>0),
  mac TEXT NOT NULL CHECK(length(mac)=64)
) STRICT;
