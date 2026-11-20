CREATE TABLE plugin_registry_identities (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=26),
  plugin_id TEXT UNIQUE NOT NULL CHECK(length(CAST(plugin_id AS BLOB)) BETWEEN 1 AND 64),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO plugin_registry_identities(id,plugin_id,owner_user_id,epoch)
  SELECT id,plugin_id,owner_user_id,epoch FROM plugin_generations;
CREATE TABLE plugin_candidates (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=26),
  registry_id TEXT NOT NULL REFERENCES plugin_registry_identities(id),
  version_id TEXT NOT NULL REFERENCES plugin_versions(id),
  expected_generation INTEGER NOT NULL CHECK(expected_generation BETWEEN 0 AND 9007199254740990),
  from_version_id TEXT REFERENCES plugin_versions(id),
  from_state TEXT,
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  CHECK(registry_id<>version_id),
  CHECK((expected_generation=0 AND from_version_id IS NULL AND from_state IS NULL)
    OR (expected_generation>0 AND from_version_id IS NOT NULL AND from_state IS NOT NULL
      AND from_state IN ('staged','disabled','quarantined'))),
  UNIQUE(registry_id,version_id,expected_generation)
) STRICT;
CREATE TRIGGER plugin_registry_identities_no_update BEFORE UPDATE ON plugin_registry_identities BEGIN
  SELECT RAISE(ABORT,'Plugin registry identities are immutable');
END;
CREATE TRIGGER plugin_registry_identities_no_delete BEFORE DELETE ON plugin_registry_identities BEGIN
  SELECT RAISE(ABORT,'Plugin registry identities are immutable');
END;
CREATE TRIGGER plugin_candidates_no_update BEFORE UPDATE ON plugin_candidates BEGIN
  SELECT RAISE(ABORT,'Plugin candidate data is immutable');
END;
CREATE TRIGGER plugin_candidates_no_delete BEFORE DELETE ON plugin_candidates BEGIN
  SELECT RAISE(ABORT,'Plugin candidate data is immutable');
END;
