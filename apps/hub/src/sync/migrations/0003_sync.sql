CREATE TABLE sync_scans (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26 AND length(CAST(id AS BLOB))=26 AND id GLOB '[0-7]*' AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  account_id TEXT NOT NULL CHECK(length(account_id)=26 AND length(CAST(account_id AS BLOB))=26 AND account_id GLOB '[0-7]*' AND account_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  user_id TEXT NOT NULL CHECK(length(user_id)=26 AND length(CAST(user_id AS BLOB))=26 AND user_id GLOB '[0-7]*' AND user_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  plugin_instance_id TEXT NOT NULL CHECK(length(plugin_instance_id)=26 AND length(CAST(plugin_instance_id AS BLOB))=26 AND plugin_instance_id GLOB '[0-7]*' AND plugin_instance_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  owner_epoch INTEGER NOT NULL CHECK(typeof(owner_epoch)='integer' AND owner_epoch BETWEEN 0 AND 9007199254740991),
  mode TEXT NOT NULL CHECK(mode IN ('full','read_only')),
  data_class TEXT NOT NULL DEFAULT 'gmail.metadata' CHECK(data_class='gmail.metadata'),
  job_id TEXT NOT NULL CHECK(length(job_id)=26 AND length(CAST(job_id AS BLOB))=26 AND job_id GLOB '[0-7]*' AND job_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  status TEXT NOT NULL CHECK(status IN ('active','waiting','cancelled','failed')),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 4096),
  resync_count INTEGER NOT NULL CHECK(typeof(resync_count)='integer' AND resync_count IN (0,1)),
  request_mode TEXT NOT NULL CHECK(request_mode IN ('initial','resync','delta')),
  since INTEGER CHECK(since IS NULL OR (typeof(since)='integer' AND since BETWEEN 0 AND 9007199254740991)),
  cursor TEXT CHECK(cursor IS NULL OR (typeof(cursor)='text' AND length(CAST(cursor AS BLOB)) BETWEEN 1 AND 4096 AND length(cursor)=length(CAST(cursor AS BLOB)) AND cursor NOT GLOB '*[^!-~]*')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  origin_cursor TEXT CHECK(origin_cursor IS NULL OR (typeof(origin_cursor)='text' AND length(CAST(origin_cursor AS BLOB)) BETWEEN 1 AND 4096 AND length(origin_cursor)=length(CAST(origin_cursor AS BLOB)) AND origin_cursor NOT GLOB '*[^!-~]*')),
  origin_revision INTEGER NOT NULL CHECK(typeof(origin_revision)='integer' AND origin_revision BETWEEN 0 AND 9007199254740991),
  CHECK((cursor IS NULL AND revision=0) OR (cursor IS NOT NULL AND revision>=1)),
  CHECK((origin_cursor IS NULL AND origin_revision=0) OR (origin_cursor IS NOT NULL AND origin_revision>=1)),
  CHECK(origin_revision<=revision),
  CHECK(since IS NOT NULL),
  UNIQUE(id,account_id,generation)
) STRICT;
CREATE UNIQUE INDEX sync_scans_active ON sync_scans(account_id) WHERE status='active';
CREATE INDEX sync_scans_owner ON sync_scans(account_id,user_id,generation,id);

CREATE TABLE sync_scan_pages (
  scan_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 4095),
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  job_id TEXT NOT NULL,
  previous_cursor TEXT CHECK(previous_cursor IS NULL OR (typeof(previous_cursor)='text' AND length(CAST(previous_cursor AS BLOB)) BETWEEN 1 AND 4096 AND length(previous_cursor)=length(CAST(previous_cursor AS BLOB)) AND previous_cursor NOT GLOB '*[^!-~]*')),
  previous_revision INTEGER NOT NULL CHECK(typeof(previous_revision)='integer' AND previous_revision BETWEEN 0 AND 9007199254740991),
  reported_more INTEGER NOT NULL CHECK(typeof(reported_more)='integer' AND reported_more IN (0,1)),
  resync_count INTEGER NOT NULL CHECK(typeof(resync_count)='integer' AND resync_count IN (0,1)),
  continuation_digest TEXT NOT NULL CHECK(typeof(continuation_digest)='text' AND length(continuation_digest)=64 AND length(CAST(continuation_digest AS BLOB))=64 AND continuation_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK((previous_cursor IS NULL AND previous_revision=0) OR (previous_cursor IS NOT NULL AND previous_revision>=1)),
  PRIMARY KEY(scan_id,ordinal),
  UNIQUE(account_id,generation,job_id),
  UNIQUE(scan_id,ordinal,account_id,generation),
  FOREIGN KEY(scan_id,account_id,generation) REFERENCES sync_scans(id,account_id,generation),
  FOREIGN KEY(account_id,generation,job_id) REFERENCES content_pages(account_id,generation,job_id)
) STRICT;
CREATE UNIQUE INDEX sync_scan_continuations ON sync_scan_pages(scan_id,resync_count,continuation_digest);
CREATE INDEX sync_scan_pages_account ON sync_scan_pages(account_id,generation,scan_id,ordinal);

CREATE TABLE sync_page_observations (
  scan_id TEXT NOT NULL,
  page_ordinal INTEGER NOT NULL CHECK(typeof(page_ordinal)='integer' AND page_ordinal BETWEEN 0 AND 4095),
  change_index INTEGER NOT NULL CHECK(typeof(change_index)='integer' AND change_index BETWEEN 0 AND 499),
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK(kind IN ('email.message','email.labels','email.deleted')),
  provider_id TEXT NOT NULL CHECK(typeof(provider_id)='text' AND length(CAST(provider_id AS BLOB)) BETWEEN 1 AND 256 AND length(provider_id)=length(CAST(provider_id AS BLOB)) AND provider_id NOT GLOB '*[^!-~]*'),
  thread_id TEXT CHECK(thread_id IS NULL OR (typeof(thread_id)='text' AND length(CAST(thread_id AS BLOB)) BETWEEN 1 AND 256 AND length(thread_id)=length(CAST(thread_id AS BLOB)) AND thread_id NOT GLOB '*[^!-~]*')),
  message_id TEXT CHECK(message_id IS NULL OR (length(message_id)=26 AND length(CAST(message_id AS BLOB))=26 AND message_id GLOB '[0-7]*' AND message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  CHECK((kind='email.deleted' AND thread_id IS NULL) OR (kind IN ('email.message','email.labels') AND thread_id IS NOT NULL)),
  PRIMARY KEY(scan_id,page_ordinal,change_index),
  FOREIGN KEY(scan_id,page_ordinal,account_id,generation) REFERENCES sync_scan_pages(scan_id,ordinal,account_id,generation)
) STRICT;
CREATE INDEX sync_page_observations_account ON sync_page_observations(account_id,generation,scan_id,page_ordinal,change_index);
-- message_id deliberately has no FK to current messages: a delete observation may retain an old native ID.
