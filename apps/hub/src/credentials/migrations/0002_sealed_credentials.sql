-- value now holds the vault's AES-256-GCM sealed credential; a refreshing row may keep its previous
-- value for restoration. Rows from 0001 held plaintext, so live ones are revoked rather than copied
-- and need an authorized replacement.
CREATE TABLE credentials_sealed (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('account','provider')),
  owner_id TEXT NOT NULL CHECK(length(owner_id)=26),
  kind TEXT NOT NULL CHECK(kind IN ('gmail-oauth','slack-token','slack-app-token','provider-key')),
  data_class TEXT NOT NULL GENERATED ALWAYS AS (CASE WHEN kind IN ('slack-token','slack-app-token') THEN 'slack.metadata' ELSE 'credentials' END) STORED,
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('active','refreshing','revoked','disconnected','deleted')),
  value BLOB CHECK(value IS NULL OR length(value) BETWEEN 30 AND 24605),
  CHECK((status='active' AND value IS NOT NULL) OR status='refreshing' OR (status NOT IN ('active','refreshing') AND value IS NULL)),
  CHECK((kind='provider-key' AND owner_kind='provider') OR (kind<>'provider-key' AND owner_kind='account'))
) STRICT;
INSERT INTO credentials_sealed(id,owner_kind,owner_id,kind,generation,status,value)
  SELECT id,owner_kind,owner_id,kind,
    CASE WHEN status IN ('active','refreshing') AND generation<9007199254740991 THEN generation+1 ELSE generation END,
    CASE WHEN status IN ('active','refreshing') THEN 'revoked' ELSE status END,
    NULL
  FROM credentials;
DROP TABLE credentials;
ALTER TABLE credentials_sealed RENAME TO credentials;
