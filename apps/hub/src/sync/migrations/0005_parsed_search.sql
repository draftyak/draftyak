-- SOURCE PROPOSAL ONLY. No migration number or production adoption is assigned.
-- Known preimage: original 0002 cfe6232fdd4d393ca46e6792acba371dc53ecf91.
-- Actual post-0004 namespace/columns/triggers/purge joins must be bound by its owner.
-- Keep original 0002, 0003_sync and 0004_sync_anchors unchanged; Raw 0002 is separate.
-- This proposal handles the known body projection, not full ParsedMail/digest validation.
-- Target SQLite/SQLCipher, trusted_schema=OFF, migration runner and full cascades
-- still require qualification. No engine/runtime/performance acceptance is asserted.

CREATE TEMP TABLE dyparsed_search_reject(reason TEXT NOT NULL) STRICT;
CREATE TEMP TRIGGER dyparsed_search_reject_insert
BEFORE INSERT ON dyparsed_search_reject
BEGIN
  SELECT RAISE(ROLLBACK, 'PARSED_SEARCH_LEGACY_INCOMPATIBLE');
END;

-- Fail before destructive DDL on a different or unestablished table shape.
INSERT INTO dyparsed_search_reject
SELECT 'utf8_database_encoding' WHERE (SELECT encoding FROM pragma_encoding) IS NOT 'UTF-8';
-- Original native migrate() owns the transaction and holds foreign keys OFF
-- while rebuilding tables. Its mandatory foreign_key_check after this whole
-- file must succeed before the pending set commits; it restores ON in finally.
-- Also reject original orphan references before any destructive DDL below.
INSERT INTO dyparsed_search_reject
SELECT 'foreign_keys_migration_contract'
WHERE (SELECT foreign_keys FROM pragma_foreign_keys) IS NOT 0;
INSERT INTO dyparsed_search_reject
SELECT 'orphan_original_message' FROM main.content_parsed_messages AS p
WHERE NOT EXISTS (SELECT 1 FROM main.content_messages AS m WHERE m.id=p.message_id);
INSERT INTO dyparsed_search_reject
SELECT 'trusted_schema_off' WHERE (SELECT trusted_schema FROM pragma_trusted_schema) IS NOT 0;
INSERT INTO dyparsed_search_reject
SELECT 'secure_delete' WHERE (SELECT secure_delete FROM pragma_secure_delete) IS NOT 1;
INSERT INTO dyparsed_search_reject
SELECT 'memory_temp_store' WHERE (SELECT temp_store FROM pragma_temp_store) IS NOT 2;
INSERT INTO dyparsed_search_reject
SELECT 'original_strict_rowid_table'
WHERE NOT EXISTS (SELECT 1 FROM pragma_table_list
  WHERE schema='main' AND name='content_parsed_messages' AND type='table' AND strict=1 AND wr=0);
INSERT INTO dyparsed_search_reject
SELECT 'original_columns'
WHERE (SELECT group_concat(signature,'|') FROM
  (SELECT name || ':' || type || ':' || "notnull" || ':' || pk AS signature
   FROM pragma_table_xinfo('content_parsed_messages','main') ORDER BY cid)) IS NOT
'message_id:TEXT:1:1|account_id:TEXT:1:0|generation:INTEGER:1:0|user_id:TEXT:1:0|plugin_instance_id:TEXT:1:0|mode:TEXT:1:0|provider_id:TEXT:1:0|thread_id:TEXT:1:0|account_digest:TEXT:1:0|metadata_digest:TEXT:1:0|source_cursor:TEXT:1:0|source_revision:INTEGER:1:0|raw_ref:TEXT:1:0|raw_sha256:TEXT:1:0|raw_bytes:INTEGER:1:0|parsed_json:TEXT:1:0|parsed_digest:TEXT:1:0|association:TEXT:1:0';
INSERT INTO dyparsed_search_reject
SELECT 'existing_new_objects' WHERE EXISTS
 (SELECT 1 FROM main.sqlite_schema WHERE name IN
  ('content_parsed_messages_search_transition','content_parsed_fts',
   'content_parsed_search_page','content_parsed_fts_ai','content_parsed_fts_ad',
   'content_parsed_fts_au','content_parsed_body_bi','content_parsed_body_bu'));
INSERT INTO dyparsed_search_reject
SELECT 'unallocated_parsed_table_trigger' WHERE EXISTS
 (SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='content_parsed_messages');
INSERT INTO dyparsed_search_reject
SELECT 'unallocated_inbound_foreign_key' WHERE EXISTS
 (SELECT 1 FROM main.sqlite_schema AS s, pragma_foreign_key_list(s.name,'main') AS f
  WHERE s.type='table' AND f."table" COLLATE NOCASE='content_parsed_messages');
INSERT INTO dyparsed_search_reject
SELECT 'unallocated_index' WHERE
 (SELECT group_concat(name,'|') FROM
  (SELECT name FROM main.sqlite_schema
   WHERE type='index' AND tbl_name='content_parsed_messages' AND sql IS NOT NULL ORDER BY name)) IS NOT
 'content_parsed_owner|content_parsed_page|content_parsed_thread';

-- Old DDL checked only JSON byte length. Do not cast, coalesce, truncate or skip.
INSERT INTO dyparsed_search_reject
SELECT 'invalid_json' FROM main.content_parsed_messages WHERE json_valid(parsed_json) IS NOT 1;
INSERT INTO dyparsed_search_reject
SELECT 'duplicate_json_member' FROM main.content_parsed_messages AS p
WHERE EXISTS (SELECT 1 FROM json_tree(p.parsed_json) AS j
 WHERE typeof(j.key)='text' GROUP BY j.parent,j.key HAVING count(*)<>1);
INSERT INTO dyparsed_search_reject
SELECT 'body_shape' FROM main.content_parsed_messages AS p
WHERE json_type(parsed_json) IS NOT 'object'
 OR json_type(parsed_json,'$.body') IS NOT 'object'
 OR json_type(parsed_json,'$.body.text') IS NOT 'text'
 OR (SELECT count(*) FROM json_each(p.parsed_json,'$.body'))<>4
 OR EXISTS (SELECT 1 FROM json_each(p.parsed_json,'$.body')
            WHERE key NOT IN ('text','removals','links','suspectedInstructions'))
 OR json_type(parsed_json,'$.body.removals') IS NOT 'object'
 OR json_type(parsed_json,'$.body.links') IS NOT 'array'
 OR json_type(parsed_json,'$.body.suspectedInstructions') NOT IN ('true','false');
INSERT INTO dyparsed_search_reject
SELECT 'body_bytes' FROM main.content_parsed_messages
WHERE length(CAST(json_extract(parsed_json,'$.body.text') AS BLOB))>160000;

-- Index the materialized ASCII hexadecimal view as BLOB bytes; cast only
-- each two-byte slice back to TEXT for the unchanged hexadecimal rules.
-- Count the entire decoded UTF8 BLOB, including embedded U+0000. Byte-aligned
-- rules reject overlong encodings, surrogate scalars, lone continuation bytes,
-- truncated encodings and codepoints above U+10FFFF. Astral scalars count as
-- two UTF16 units. There is no SQLite length(TEXT) assumption in this walk.
CREATE TEMP TABLE dyparsed_search_body_metrics(
 message_id TEXT PRIMARY KEY NOT NULL,
 scalars INTEGER NOT NULL,
 utf16_units INTEGER NOT NULL
) STRICT;
CREATE TEMP TRIGGER dyparsed_search_body_metrics_reject
BEFORE INSERT ON dyparsed_search_body_metrics
WHEN NEW.scalars>40000 OR NEW.utf16_units>80000
BEGIN SELECT RAISE(ROLLBACK, 'PARSED_SEARCH_LEGACY_BODY_BOUND'); END;
WITH RECURSIVE
 body_bytes(message_id,bytes) AS MATERIALIZED (
  SELECT message_id,CAST(json_extract(parsed_json,'$.body.text') AS BLOB)
  FROM main.content_parsed_messages),
 bodies(message_id,h,n) AS MATERIALIZED (
  SELECT message_id,CAST(hex(bytes) AS BLOB),length(bytes)*2 FROM body_bytes),
 rules(lo,hi,slo,shi,width,units) AS (VALUES
  ('00','7F',NULL,NULL,1,1),('C2','DF','80','BF',2,1),
  ('E0','E0','A0','BF',3,1),('E1','EC','80','BF',3,1),
  ('ED','ED','80','9F',3,1),('EE','EF','80','BF',3,1),
  ('F0','F0','90','BF',4,2),('F1','F3','80','BF',4,2),('F4','F4','80','8F',4,2)),
 walk(message_id,n,pos,chunk_start,chunk,scalars,utf16_units) AS (
  SELECT message_id,n,1,1,substr(h,1,1030),0,0 FROM bodies
  UNION ALL
  SELECT w.message_id,w.n,w.pos+2*r.width,
   CASE WHEN w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
    THEN w.pos+2*r.width ELSE w.chunk_start END,
   CASE WHEN w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
    THEN substr(b.h,w.pos+2*r.width,1030) ELSE w.chunk END,
   w.scalars+1,w.utf16_units+r.units
  FROM walk AS w JOIN rules AS r
   ON CAST(substr(w.chunk,w.pos-w.chunk_start+1,2) AS TEXT) BETWEEN r.lo AND r.hi
   AND (r.width=1 OR CAST(substr(w.chunk,w.pos-w.chunk_start+3,2) AS TEXT) BETWEEN r.slo AND r.shi)
   AND (r.width<=2 OR CAST(substr(w.chunk,w.pos-w.chunk_start+5,2) AS TEXT) BETWEEN '80' AND 'BF')
   AND (r.width<=3 OR CAST(substr(w.chunk,w.pos-w.chunk_start+7,2) AS TEXT) BETWEEN '80' AND 'BF')
  LEFT JOIN bodies AS b ON b.message_id=w.message_id
   AND w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
  WHERE w.pos<=w.n AND w.scalars<=40000 AND w.utf16_units<=80000)
INSERT INTO dyparsed_search_body_metrics
SELECT w.message_id,w.scalars,w.utf16_units
FROM walk AS w WHERE w.pos>w.n;
INSERT INTO dyparsed_search_reject
SELECT 'invalid_or_overbound_body_utf8'
WHERE (SELECT count(*) FROM dyparsed_search_body_metrics)<>
      (SELECT count(*) FROM main.content_parsed_messages);
INSERT INTO dyparsed_search_reject
SELECT 'removals_shape' FROM main.content_parsed_messages AS p
WHERE (SELECT count(*) FROM json_each(p.parsed_json,'$.body.removals'))<>5
 OR EXISTS (SELECT 1 FROM json_each(p.parsed_json,'$.body.removals')
   WHERE key NOT IN ('hidden','invisible','quoted','truncated','uris') OR type<>'integer');
-- Separate the element-type assertion so malformed string values never reach
-- a nested json_each(l.value) call before the explicit transaction rollback.
INSERT INTO dyparsed_search_reject
SELECT 'link_element_type' FROM main.content_parsed_messages AS p
WHERE EXISTS (SELECT 1 FROM json_each(p.parsed_json,'$.body.links') WHERE type<>'object');
INSERT INTO dyparsed_search_reject
SELECT 'link_shape' FROM main.content_parsed_messages AS p
WHERE (SELECT count(*) FROM json_each(p.parsed_json,'$.body.links'))>20000
 OR EXISTS (SELECT 1 FROM json_each(p.parsed_json,'$.body.links') AS l
   WHERE (SELECT count(*) FROM json_each(l.value))<>2
    OR EXISTS (SELECT 1 FROM json_each(l.value) WHERE key NOT IN ('index','host'))
    OR json_type(l.value,'$.index') IS NOT 'integer'
    OR json_extract(l.value,'$.index')<0
    OR json_extract(l.value,'$.index')>(SELECT utf16_units FROM dyparsed_search_body_metrics WHERE message_id=p.message_id)
    OR json_type(l.value,'$.host') IS NOT 'text');
CREATE TABLE main.content_parsed_messages_search_transition (
  seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 9007199254740991),
  message_id TEXT UNIQUE NOT NULL CHECK(length(message_id)=26 AND length(CAST(message_id AS BLOB))=26 AND message_id GLOB '[0-7]*' AND message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
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
  scope_token TEXT NOT NULL CHECK(scope_token = 'dyparsedv1z' || lower(hex(user_id)) || 'z' || lower(hex(account_id)) || 'z' || CAST(generation AS TEXT) || 'z' || lower(hex(plugin_instance_id)) || 'z' || lower(hex(mode)) || 'z' || account_digest),
  cleaned_body TEXT NOT NULL CHECK(length(cleaned_body)<=40000 AND length(CAST(cleaned_body AS BLOB))<=160000),
  FOREIGN KEY(message_id) REFERENCES content_messages(id) ON DELETE CASCADE
) STRICT;

-- Deterministic new safe seq; do not rewrite any original column or digest.
INSERT INTO main.content_parsed_messages_search_transition
(seq,message_id,account_id,generation,user_id,plugin_instance_id,mode,provider_id,thread_id,account_digest,metadata_digest,source_cursor,source_revision,raw_ref,raw_sha256,raw_bytes,parsed_json,parsed_digest,association,scope_token,cleaned_body)
SELECT row_number() OVER (ORDER BY message_id),message_id,account_id,generation,user_id,plugin_instance_id,mode,provider_id,thread_id,account_digest,metadata_digest,source_cursor,source_revision,raw_ref,raw_sha256,raw_bytes,parsed_json,parsed_digest,association,
 'dyparsedv1z' || lower(hex(user_id)) || 'z' || lower(hex(account_id)) || 'z' || CAST(generation AS TEXT) || 'z' || lower(hex(plugin_instance_id)) || 'z' || lower(hex(mode)) || 'z' || account_digest,json_extract(parsed_json,'$.body.text')
FROM main.content_parsed_messages;
INSERT INTO dyparsed_search_reject
SELECT 'row_count_changed' WHERE
 (SELECT count(*) FROM main.content_parsed_messages_search_transition)<>
 (SELECT count(*) FROM main.content_parsed_messages);

DROP TRIGGER content_parsed_invalidate_update;
DROP TABLE main.content_parsed_messages;
ALTER TABLE main.content_parsed_messages_search_transition RENAME TO content_parsed_messages;

CREATE INDEX content_parsed_owner ON content_parsed_messages(account_id,user_id);
CREATE INDEX content_parsed_page ON content_parsed_messages(account_id,generation,user_id,message_id);
CREATE INDEX content_parsed_thread ON content_parsed_messages(account_id,generation,user_id,plugin_instance_id,mode,thread_id,message_id);
CREATE INDEX content_parsed_search_page ON content_parsed_messages(scope_token,message_id);

CREATE TRIGGER content_parsed_invalidate_update
AFTER UPDATE ON content_messages
BEGIN
  DELETE FROM content_parsed_messages WHERE message_id=OLD.id;
END;

CREATE VIRTUAL TABLE main.content_parsed_fts USING fts5(
 scope_token,cleaned_body,content='content_parsed_messages',content_rowid='seq',
 tokenize='unicode61 remove_diacritics 2');
INSERT INTO content_parsed_fts(content_parsed_fts,rank) VALUES('secure-delete',1);

CREATE TRIGGER content_parsed_fts_ai AFTER INSERT ON content_parsed_messages
BEGIN
 INSERT INTO content_parsed_fts(rowid,scope_token,cleaned_body) VALUES(NEW.seq,NEW.scope_token,NEW.cleaned_body);
END;
CREATE TRIGGER content_parsed_fts_ad AFTER DELETE ON content_parsed_messages
BEGIN
 INSERT INTO content_parsed_fts(content_parsed_fts,rowid,scope_token,cleaned_body)
 VALUES('delete',OLD.seq,OLD.scope_token,OLD.cleaned_body);
END;
CREATE TRIGGER content_parsed_fts_au AFTER UPDATE OF seq,scope_token,cleaned_body ON content_parsed_messages
BEGIN
 INSERT INTO content_parsed_fts(content_parsed_fts,rowid,scope_token,cleaned_body)
 VALUES('delete',OLD.seq,OLD.scope_token,OLD.cleaned_body);
 INSERT INTO content_parsed_fts(rowid,scope_token,cleaned_body) VALUES(NEW.seq,NEW.scope_token,NEW.cleaned_body);
END;
INSERT INTO content_parsed_fts(rowid,scope_token,cleaned_body)
SELECT seq,scope_token,cleaned_body FROM content_parsed_messages;

-- Actual content_messages DELETE/account purge cascades through the retained FK
-- and then content_parsed_fts_ad. Direct generation/stale-row DELETE uses the
-- same trigger. No new Raw/journal/scan/anchor purge producer is invented here.
-- Maintain true NUL-safe bounds for future writer rows as well as backfill.
CREATE TRIGGER content_parsed_body_bi BEFORE INSERT ON content_parsed_messages
BEGIN
  SELECT RAISE(ABORT, 'PARSED_SEARCH_BODY_INVALID')
  WHERE typeof(NEW.cleaned_body)<>'text'
    OR length(CAST(NEW.cleaned_body AS BLOB))>160000
    OR NOT EXISTS (
     WITH RECURSIVE
      body_bytes(bytes) AS MATERIALIZED (SELECT CAST(NEW.cleaned_body AS BLOB)),
      body(h,n) AS MATERIALIZED (SELECT CAST(hex(bytes) AS BLOB),length(bytes)*2 FROM body_bytes),
      rules(lo,hi,slo,shi,width,units) AS (VALUES
       ('00','7F',NULL,NULL,1,1),('C2','DF','80','BF',2,1),
       ('E0','E0','A0','BF',3,1),('E1','EC','80','BF',3,1),
       ('ED','ED','80','9F',3,1),('EE','EF','80','BF',3,1),
       ('F0','F0','90','BF',4,2),('F1','F3','80','BF',4,2),('F4','F4','80','8F',4,2)),
      walk(n,pos,chunk_start,chunk,scalars,utf16_units) AS (
       SELECT n,1,1,substr(h,1,1030),0,0 FROM body
       UNION ALL
       SELECT w.n,w.pos+2*r.width,
        CASE WHEN w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
         THEN w.pos+2*r.width ELSE w.chunk_start END,
        CASE WHEN w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
         THEN substr(b.h,w.pos+2*r.width,1030) ELSE w.chunk END,
        w.scalars+1,w.utf16_units+r.units
       FROM walk AS w JOIN rules AS r
        ON CAST(substr(w.chunk,w.pos-w.chunk_start+1,2) AS TEXT) BETWEEN r.lo AND r.hi
        AND (r.width=1 OR CAST(substr(w.chunk,w.pos-w.chunk_start+3,2) AS TEXT) BETWEEN r.slo AND r.shi)
        AND (r.width<=2 OR CAST(substr(w.chunk,w.pos-w.chunk_start+5,2) AS TEXT) BETWEEN '80' AND 'BF')
        AND (r.width<=3 OR CAST(substr(w.chunk,w.pos-w.chunk_start+7,2) AS TEXT) BETWEEN '80' AND 'BF')
       LEFT JOIN body AS b ON w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
       WHERE w.pos<=w.n AND w.scalars<=40000 AND w.utf16_units<=80000)
     SELECT 1 FROM walk AS w
     WHERE w.pos>w.n AND w.scalars<=40000 AND w.utf16_units<=80000);
END;
CREATE TRIGGER content_parsed_body_bu BEFORE UPDATE OF cleaned_body ON content_parsed_messages
BEGIN
  SELECT RAISE(ABORT, 'PARSED_SEARCH_BODY_INVALID')
  WHERE typeof(NEW.cleaned_body)<>'text'
    OR length(CAST(NEW.cleaned_body AS BLOB))>160000
    OR NOT EXISTS (
     WITH RECURSIVE
      body_bytes(bytes) AS MATERIALIZED (SELECT CAST(NEW.cleaned_body AS BLOB)),
      body(h,n) AS MATERIALIZED (SELECT CAST(hex(bytes) AS BLOB),length(bytes)*2 FROM body_bytes),
      rules(lo,hi,slo,shi,width,units) AS (VALUES
       ('00','7F',NULL,NULL,1,1),('C2','DF','80','BF',2,1),
       ('E0','E0','A0','BF',3,1),('E1','EC','80','BF',3,1),
       ('ED','ED','80','9F',3,1),('EE','EF','80','BF',3,1),
       ('F0','F0','90','BF',4,2),('F1','F3','80','BF',4,2),('F4','F4','80','8F',4,2)),
      walk(n,pos,chunk_start,chunk,scalars,utf16_units) AS (
       SELECT n,1,1,substr(h,1,1030),0,0 FROM body
       UNION ALL
       SELECT w.n,w.pos+2*r.width,
        CASE WHEN w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
         THEN w.pos+2*r.width ELSE w.chunk_start END,
        CASE WHEN w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
         THEN substr(b.h,w.pos+2*r.width,1030) ELSE w.chunk END,
        w.scalars+1,w.utf16_units+r.units
       FROM walk AS w JOIN rules AS r
        ON CAST(substr(w.chunk,w.pos-w.chunk_start+1,2) AS TEXT) BETWEEN r.lo AND r.hi
        AND (r.width=1 OR CAST(substr(w.chunk,w.pos-w.chunk_start+3,2) AS TEXT) BETWEEN r.slo AND r.shi)
        AND (r.width<=2 OR CAST(substr(w.chunk,w.pos-w.chunk_start+5,2) AS TEXT) BETWEEN '80' AND 'BF')
        AND (r.width<=3 OR CAST(substr(w.chunk,w.pos-w.chunk_start+7,2) AS TEXT) BETWEEN '80' AND 'BF')
       LEFT JOIN body AS b ON w.pos+2*r.width>w.chunk_start+1023 AND w.pos+2*r.width<=w.n
       WHERE w.pos<=w.n AND w.scalars<=40000 AND w.utf16_units<=80000)
     SELECT 1 FROM walk AS w
     WHERE w.pos>w.n AND w.scalars<=40000 AND w.utf16_units<=80000);
END;

DROP TRIGGER temp.dyparsed_search_body_metrics_reject;
DROP TABLE temp.dyparsed_search_body_metrics;
DROP TRIGGER temp.dyparsed_search_reject_insert;
DROP TABLE temp.dyparsed_search_reject;
