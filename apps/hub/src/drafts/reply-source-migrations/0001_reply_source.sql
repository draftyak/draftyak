CREATE TABLE native_reply_sources (
  draft_id TEXT PRIMARY KEY NOT NULL CHECK(length(draft_id)=26),
  initial_rev INTEGER NOT NULL CHECK(initial_rev=1),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 1048576),
  mac TEXT NOT NULL CHECK(length(mac)=64 AND mac NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY(draft_id) REFERENCES native_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY(draft_id,initial_rev) REFERENCES native_draft_revisions(draft_id,rev) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TRIGGER native_reply_sources_no_update BEFORE UPDATE ON native_reply_sources BEGIN
  SELECT RAISE(ABORT, 'Reply sources are immutable');
END;

CREATE TRIGGER native_reply_sources_no_replace BEFORE INSERT ON native_reply_sources
WHEN EXISTS (SELECT 1 FROM native_reply_sources WHERE draft_id=NEW.draft_id) BEGIN
  SELECT RAISE(ABORT, 'Reply sources are immutable');
END;
