CREATE TABLE audit_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  audit_seq INTEGER NOT NULL DEFAULT 0,
  audit_head TEXT NOT NULL DEFAULT '',
  audit_tag TEXT NOT NULL DEFAULT ''
) STRICT;
INSERT INTO audit_meta(singleton) VALUES(1);
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  refs TEXT NOT NULL,
  previous TEXT NOT NULL,
  mac TEXT NOT NULL
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'Audit is append only');
END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'Audit is append only');
END;
