CREATE TABLE credentials (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('account','provider')),
  owner_id TEXT NOT NULL CHECK(length(owner_id)=26),
  kind TEXT NOT NULL CHECK(kind IN ('gmail-oauth','slack-token','provider-key')),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('active','refreshing','revoked','disconnected','deleted')),
  value TEXT CHECK(value IS NULL OR length(CAST(value AS BLOB)) BETWEEN 1 AND 24576),
  CHECK((status='active' AND value IS NOT NULL) OR (status<>'active' AND value IS NULL)),
  CHECK((kind='provider-key' AND owner_kind='provider') OR (kind<>'provider-key' AND owner_kind='account'))
) STRICT;
