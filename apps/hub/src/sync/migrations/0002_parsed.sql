CREATE TABLE content_parsed_messages (
  message_id TEXT PRIMARY KEY NOT NULL CHECK(length(message_id)=26 AND length(CAST(message_id AS BLOB))=26 AND message_id GLOB '[0-7]*' AND message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  account_id TEXT NOT NULL CHECK(length(account_id)=26 AND length(CAST(account_id AS BLOB))=26 AND account_id GLOB '[0-7]*' AND account_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL CHECK(length(user_id)=26 AND length(CAST(user_id AS BLOB))=26 AND user_id GLOB '[0-7]*' AND user_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  plugin_instance_id TEXT NOT NULL CHECK(length(plugin_instance_id)=26 AND length(CAST(plugin_instance_id AS BLOB))=26 AND plugin_instance_id GLOB '[0-7]*' AND plugin_instance_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  mode TEXT NOT NULL CHECK(mode IN ('full','read_only')),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 256 AND length(provider_id)=length(CAST(provider_id AS BLOB)) AND provider_id NOT GLOB '*[^!-~]*'),
  thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 256 AND length(thread_id)=length(CAST(thread_id AS BLOB)) AND thread_id NOT GLOB '*[^!-~]*'),
  account_digest TEXT NOT NULL CHECK(length(account_digest)=64 AND length(CAST(account_digest AS BLOB))=64 AND account_digest NOT GLOB '*[^0-9a-f]*'),
  metadata_digest TEXT NOT NULL CHECK(length(metadata_digest)=64 AND length(CAST(metadata_digest AS BLOB))=64 AND metadata_digest NOT GLOB '*[^0-9a-f]*'),
  source_cursor TEXT NOT NULL CHECK(length(CAST(source_cursor AS BLOB)) BETWEEN 1 AND 4096 AND length(source_cursor)=length(CAST(source_cursor AS BLOB)) AND source_cursor NOT GLOB '*[^!-~]*'),
  source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision BETWEEN 1 AND 9007199254740991),
  raw_ref TEXT NOT NULL CHECK(length(raw_ref)=26 AND length(CAST(raw_ref AS BLOB))=26 AND raw_ref GLOB '[0-7]*' AND raw_ref NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND length(CAST(raw_sha256 AS BLOB))=64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
  raw_bytes INTEGER NOT NULL CHECK(typeof(raw_bytes)='integer' AND raw_bytes BETWEEN 1 AND 33554432),
  parsed_json TEXT NOT NULL CHECK(length(CAST(parsed_json AS BLOB)) BETWEEN 2 AND 4194304),
  parsed_digest TEXT NOT NULL CHECK(length(parsed_digest)=64 AND length(CAST(parsed_digest AS BLOB))=64 AND parsed_digest NOT GLOB '*[^0-9a-f]*'),
  association TEXT NOT NULL CHECK(association='unverified'),
  FOREIGN KEY(message_id) REFERENCES content_messages(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX content_parsed_owner ON content_parsed_messages(account_id,user_id);
CREATE INDEX content_parsed_page ON content_parsed_messages(account_id,generation,user_id,message_id);
CREATE INDEX content_parsed_thread ON content_parsed_messages(account_id,generation,user_id,plugin_instance_id,mode,thread_id,message_id);

CREATE TRIGGER content_parsed_invalidate_update
AFTER UPDATE ON content_messages
BEGIN
  DELETE FROM content_parsed_messages WHERE message_id=OLD.id;
END;
