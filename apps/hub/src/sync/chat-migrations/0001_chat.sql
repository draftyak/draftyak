CREATE TABLE chatcontent_checkpoints (
  account_id TEXT NOT NULL CHECK(length(account_id)=26),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL CHECK(length(user_id)=26),
  plugin_instance_id TEXT NOT NULL CHECK(length(plugin_instance_id)=26),
  mode TEXT NOT NULL CHECK(mode IN ('full','read_only')),
  cursor TEXT NOT NULL CHECK(length(CAST(cursor AS BLOB)) BETWEEN 1 AND 4096 AND cursor NOT GLOB '*[^!-~]*'),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(account_id,generation)
) STRICT;
CREATE INDEX chatcontent_checkpoints_owner ON chatcontent_checkpoints(account_id,user_id);

CREATE TABLE chatcontent_channels (
  account_id TEXT NOT NULL CHECK(length(account_id)=26),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL CHECK(length(user_id)=26),
  channel_id TEXT NOT NULL CHECK(length(channel_id) BETWEEN 1 AND 256 AND channel_id NOT GLOB '*[^!-~]*'),
  metadata_json TEXT NOT NULL CHECK(length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 16384),
  PRIMARY KEY(account_id,generation,channel_id)
) STRICT;
CREATE INDEX chatcontent_channels_owner ON chatcontent_channels(account_id,user_id);

CREATE TABLE chatcontent_threads (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  account_id TEXT NOT NULL CHECK(length(account_id)=26),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL CHECK(length(user_id)=26),
  channel_id TEXT NOT NULL CHECK(length(channel_id) BETWEEN 1 AND 256 AND channel_id NOT GLOB '*[^!-~]*'),
  thread_ts TEXT NOT NULL CHECK(length(thread_ts) BETWEEN 1 AND 256 AND thread_ts NOT GLOB '*[^!-~]*'),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  UNIQUE(account_id,generation,channel_id,thread_ts),
  UNIQUE(id,account_id,generation)
) STRICT;
CREATE INDEX chatcontent_threads_owner ON chatcontent_threads(account_id,user_id);

CREATE TABLE chatcontent_messages (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  account_id TEXT NOT NULL CHECK(length(account_id)=26),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL CHECK(length(user_id)=26),
  channel_id TEXT NOT NULL CHECK(length(channel_id) BETWEEN 1 AND 256 AND channel_id NOT GLOB '*[^!-~]*'),
  ts TEXT NOT NULL CHECK(length(ts) BETWEEN 1 AND 256 AND ts NOT GLOB '*[^!-~]*'),
  thread_ts TEXT CHECK(thread_ts IS NULL OR (length(thread_ts) BETWEEN 1 AND 256 AND thread_ts NOT GLOB '*[^!-~]*')),
  conversation_id TEXT,
  sent_at INTEGER CHECK(sent_at IS NULL OR sent_at BETWEEN 0 AND 9007199254740991),
  edited_at INTEGER CHECK(edited_at IS NULL OR edited_at BETWEEN 0 AND 9007199254740991),
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  payload_json TEXT CHECK(payload_json IS NULL OR length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 1048576),
  payload_sha256 TEXT CHECK(payload_sha256 IS NULL OR (length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK((deleted=1 AND payload_json IS NULL AND payload_sha256 IS NULL) OR
    (deleted=0 AND payload_json IS NOT NULL AND payload_sha256 IS NOT NULL AND sent_at IS NOT NULL AND thread_ts IS NOT NULL AND conversation_id IS NOT NULL)),
  UNIQUE(account_id,generation,channel_id,ts),
  FOREIGN KEY(conversation_id,account_id,generation) REFERENCES chatcontent_threads(id,account_id,generation)
) STRICT;
CREATE INDEX chatcontent_messages_owner ON chatcontent_messages(account_id,user_id);
CREATE INDEX chatcontent_messages_thread ON chatcontent_messages(account_id,generation,user_id,conversation_id,deleted,sent_at,ts);
