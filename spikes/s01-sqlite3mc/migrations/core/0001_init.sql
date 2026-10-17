CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT ''
) STRICT;

-- The index refers to seq: VACUUM and VACUUM INTO keep an INTEGER PRIMARY KEY, not implicit rowids.
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL
) STRICT;

CREATE INDEX messages_conversation ON messages (conversation_id, sent_at);

CREATE VIRTUAL TABLE fts_messages USING fts5 (
  subject,
  body,
  content = 'messages',
  content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- A delete removes the row's tokens from the index instead of adding a delete marker that holds them.
INSERT INTO fts_messages (fts_messages, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO fts_messages (rowid, subject, body) VALUES (new.seq, new.subject, new.body);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO fts_messages (fts_messages, rowid, subject, body)
  VALUES ('delete', old.seq, old.subject, old.body);
END;

CREATE TRIGGER messages_au AFTER UPDATE OF seq, subject, body ON messages BEGIN
  INSERT INTO fts_messages (fts_messages, rowid, subject, body)
  VALUES ('delete', old.seq, old.subject, old.body);
  INSERT INTO fts_messages (rowid, subject, body) VALUES (new.seq, new.subject, new.body);
END;
