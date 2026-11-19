CREATE TABLE rawcontent_objects (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id)=26 AND length(CAST(id AS BLOB))=26
    AND id GLOB '[0-7]*' AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  user_id TEXT NOT NULL CHECK(
    length(user_id)=26 AND length(CAST(user_id AS BLOB))=26
    AND user_id GLOB '[0-7]*' AND user_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  account_id TEXT NOT NULL CHECK(
    length(account_id)=26 AND length(CAST(account_id AS BLOB))=26
    AND account_id GLOB '[0-7]*' AND account_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  plugin_instance_id TEXT NOT NULL CHECK(
    length(plugin_instance_id)=26 AND length(CAST(plugin_instance_id AS BLOB))=26
    AND plugin_instance_id GLOB '[0-7]*' AND plugin_instance_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  mode TEXT NOT NULL CHECK(mode IN ('full','read_only')),
  owner_epoch INTEGER NOT NULL CHECK(typeof(owner_epoch)='integer' AND owner_epoch BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('staged','committed','discarding')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(
    typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND 9007199254740991
    AND expires_at-created_at BETWEEN 1 AND 60000
  ),
  max_bytes INTEGER NOT NULL CHECK(typeof(max_bytes)='integer' AND max_bytes BETWEEN 0 AND 33554432),
  byte_count INTEGER NOT NULL CHECK(typeof(byte_count)='integer' AND byte_count BETWEEN 0 AND max_bytes),
  chunk_count INTEGER NOT NULL CHECK(typeof(chunk_count)='integer' AND chunk_count BETWEEN 0 AND 512),
  sha256 TEXT NOT NULL,
  CHECK(
    (state IN ('staged','discarding') AND sha256='')
    OR (
      state='committed' AND length(sha256)=64 AND length(CAST(sha256 AS BLOB))=64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
      AND chunk_count=(byte_count+65535)/65536
    )
  )
) STRICT;

CREATE INDEX rawcontent_staging ON rawcontent_objects(state,account_id,id);
CREATE INDEX rawcontent_expiry ON rawcontent_objects(user_id,state,expires_at,id);

CREATE TABLE rawcontent_chunks (
  object_id TEXT NOT NULL CHECK(
    length(object_id)=26 AND length(CAST(object_id AS BLOB))=26
    AND object_id GLOB '[0-7]*' AND object_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq BETWEEN 0 AND 511),
  bytes BLOB NOT NULL CHECK(typeof(bytes)='blob' AND length(bytes) BETWEEN 1 AND 65536),
  sha256 TEXT NOT NULL CHECK(
    length(sha256)=64 AND length(CAST(sha256 AS BLOB))=64
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY(object_id,seq),
  FOREIGN KEY(object_id) REFERENCES rawcontent_objects(id) ON DELETE NO ACTION
) STRICT;
