CREATE TABLE plugin_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=26),
  plugin_id TEXT NOT NULL CHECK(length(CAST(plugin_id AS BLOB)) BETWEEN 1 AND 64),
  version TEXT NOT NULL CHECK(length(CAST(version AS BLOB)) BETWEEN 1 AND 128),
  descriptor TEXT NOT NULL CHECK(length(CAST(descriptor AS BLOB)) BETWEEN 2 AND 524288),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE(plugin_id,version)
) STRICT;
CREATE TABLE plugin_generations (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=26),
  plugin_id TEXT UNIQUE NOT NULL CHECK(length(CAST(plugin_id AS BLOB)) BETWEEN 1 AND 64),
  version_id TEXT NOT NULL REFERENCES plugin_versions(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('staged','disabled','quarantined'))
) STRICT;
CREATE TRIGGER plugin_versions_no_update BEFORE UPDATE ON plugin_versions BEGIN
  SELECT RAISE(ABORT,'Installed plugin versions are immutable');
END;
CREATE TRIGGER plugin_versions_no_delete BEFORE DELETE ON plugin_versions BEGIN
  SELECT RAISE(ABORT,'Installed plugin versions are immutable');
END;
