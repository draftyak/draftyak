CREATE TABLE native_runtime_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  sync_paused INTEGER NOT NULL CHECK(sync_paused IN (0, 1))
) STRICT;
INSERT INTO native_runtime_settings(singleton, sync_paused) VALUES(1, 0);
