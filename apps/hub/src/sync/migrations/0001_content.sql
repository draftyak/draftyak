CREATE TABLE content_checkpoints (
  account_id TEXT NOT NULL CHECK(
    length(account_id)=26 AND length(CAST(account_id AS BLOB))=26
    AND account_id GLOB '[0-7]*' AND account_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL CHECK(
    length(user_id)=26 AND length(CAST(user_id AS BLOB))=26
    AND user_id GLOB '[0-7]*' AND user_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  plugin_instance_id TEXT NOT NULL CHECK(
    length(plugin_instance_id)=26 AND length(CAST(plugin_instance_id AS BLOB))=26
    AND plugin_instance_id GLOB '[0-7]*' AND plugin_instance_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  mode TEXT NOT NULL CHECK(mode IN ('full','read_only')),
  cursor TEXT NOT NULL CHECK(
    length(CAST(cursor AS BLOB)) BETWEEN 1 AND 4096 AND length(cursor)=length(CAST(cursor AS BLOB))
    AND cursor NOT GLOB '*[^!-~]*'
  ),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(account_id,generation)
) STRICT;

CREATE INDEX content_checkpoints_owner ON content_checkpoints(account_id,user_id);

CREATE TABLE content_conversations (
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
  provider_id TEXT NOT NULL CHECK(
    length(provider_id) BETWEEN 1 AND 256 AND length(provider_id)=length(CAST(provider_id AS BLOB))
    AND provider_id NOT GLOB '*[^!-~]*'
  ),
  UNIQUE(account_id,generation,provider_id),
  UNIQUE(id,account_id,generation)
) STRICT;

CREATE INDEX content_conversations_owner ON content_conversations(account_id,user_id);

CREATE TABLE content_messages (
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
  provider_id TEXT NOT NULL CHECK(
    length(provider_id) BETWEEN 1 AND 256 AND length(provider_id)=length(CAST(provider_id AS BLOB))
    AND provider_id NOT GLOB '*[^!-~]*'
  ),
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id)=26 AND length(CAST(conversation_id AS BLOB))=26
    AND conversation_id GLOB '[0-7]*' AND conversation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  internal_date INTEGER NOT NULL CHECK(typeof(internal_date)='integer' AND internal_date BETWEEN 0 AND 9007199254740991),
  label_json TEXT NOT NULL CHECK(length(CAST(label_json AS BLOB))<=131841),
  size_bytes INTEGER CHECK(size_bytes IS NULL OR (typeof(size_bytes)='integer' AND size_bytes BETWEEN 0 AND 9007199254740991)),
  state TEXT NOT NULL DEFAULT 'unparsed' CHECK(state='unparsed'),
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK(direction='inbound'),
  UNIQUE(account_id,generation,provider_id),
  FOREIGN KEY(conversation_id,account_id,generation) REFERENCES content_conversations(id,account_id,generation)
) STRICT;

CREATE INDEX content_messages_owner ON content_messages(account_id,user_id);
CREATE INDEX content_messages_conversation ON content_messages(conversation_id,account_id,generation);
CREATE INDEX content_messages_page ON content_messages(account_id,generation,id);

CREATE TABLE content_pages (
  account_id TEXT NOT NULL CHECK(
    length(account_id)=26 AND length(CAST(account_id AS BLOB))=26
    AND account_id GLOB '[0-7]*' AND account_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  job_id TEXT NOT NULL CHECK(
    length(job_id)=26 AND length(CAST(job_id AS BLOB))=26
    AND job_id GLOB '[0-7]*' AND job_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  payload_digest TEXT NOT NULL CHECK(
    length(payload_digest)=64 AND length(CAST(payload_digest AS BLOB))=64
    AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  cursor TEXT NOT NULL CHECK(
    length(CAST(cursor AS BLOB)) BETWEEN 1 AND 4096 AND length(cursor)=length(CAST(cursor AS BLOB))
    AND cursor NOT GLOB '*[^!-~]*'
  ),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(account_id,generation,job_id)
) STRICT;
