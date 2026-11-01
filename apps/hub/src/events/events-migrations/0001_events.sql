CREATE TABLE events (
  seq INTEGER PRIMARY KEY CHECK (seq BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL CHECK (length(CAST(user_id AS BLOB)) = 26),
  account_id TEXT CHECK (account_id IS NULL OR length(CAST(account_id AS BLOB)) = 26),
  data_class TEXT NOT NULL CHECK (length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (length(CAST(kind AS BLOB)) BETWEEN 1 AND 64),
  ids TEXT NOT NULL CHECK (length(CAST(ids AS BLOB)) BETWEEN 2 AND 4096),
  at INTEGER NOT NULL CHECK (at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE INDEX events_user_seq ON events(user_id, seq);
CREATE INDEX events_at_seq ON events(at, seq);
CREATE TABLE event_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_seq INTEGER NOT NULL CHECK (last_seq BETWEEN 0 AND 9007199254740991),
  floor_seq INTEGER NOT NULL CHECK (floor_seq BETWEEN 0 AND last_seq)
) STRICT;
INSERT INTO event_meta(singleton, last_seq, floor_seq) VALUES (1, 0, 0);
