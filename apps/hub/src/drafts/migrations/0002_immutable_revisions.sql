CREATE TABLE native_draft_revisions_immutable (
  draft_id TEXT NOT NULL REFERENCES native_drafts(id),
  rev INTEGER NOT NULL CHECK(rev BETWEEN 1 AND 10000),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152),
  previous TEXT NOT NULL CHECK(length(previous) IN (0,64)),
  mac TEXT NOT NULL CHECK(length(mac)=64),
  PRIMARY KEY(draft_id,rev)
) STRICT, WITHOUT ROWID;
INSERT INTO native_draft_revisions_immutable(draft_id,rev,payload,previous,mac)
  SELECT draft_id,rev,payload,previous,mac FROM native_draft_revisions;
DROP TABLE native_draft_revisions;
ALTER TABLE native_draft_revisions_immutable RENAME TO native_draft_revisions;
CREATE TRIGGER native_draft_revisions_no_update BEFORE UPDATE ON native_draft_revisions BEGIN
  SELECT RAISE(ABORT, 'Draft revisions are immutable');
END;
CREATE TRIGGER native_draft_revisions_no_replace BEFORE INSERT ON native_draft_revisions
WHEN EXISTS (
  SELECT 1 FROM native_draft_revisions
  WHERE draft_id = NEW.draft_id AND rev = NEW.rev
) BEGIN
  SELECT RAISE(ABORT, 'Draft revisions are immutable');
END;
