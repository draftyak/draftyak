CREATE TABLE hub_identity_rotations (
  seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 4096),
  id TEXT NOT NULL UNIQUE CHECK(
    length(CAST(id AS BLOB)) = 26 AND substr(id, 1, 1) BETWEEN '0' AND '7' AND
    id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  old_key TEXT NOT NULL CHECK(
    length(CAST(old_key AS BLOB)) = 122 AND substr(old_key, 1, 36) = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' AND
    old_key NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(old_key, 122, 1) IN ('A', 'Q', 'g', 'w')
  ),
  new_key TEXT NOT NULL UNIQUE CHECK(
    length(CAST(new_key AS BLOB)) = 122 AND substr(new_key, 1, 36) = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' AND
    new_key NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(new_key, 122, 1) IN ('A', 'Q', 'g', 'w') AND
    new_key <> old_key
  ),
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
  iat INTEGER NOT NULL CHECK(iat BETWEEN 0 AND 9007199254740991),
  statement BLOB NOT NULL CHECK(length(statement) BETWEEN 1 AND 1024),
  signature TEXT NOT NULL CHECK(
    length(CAST(signature AS BLOB)) = 86 AND signature NOT GLOB '*[^A-Za-z0-9_-]*'
  )
) STRICT;
CREATE TRIGGER hub_identity_rotations_no_update BEFORE UPDATE ON hub_identity_rotations BEGIN
  SELECT RAISE(ABORT, 'Hub identity rotations are append only');
END;
CREATE TRIGGER hub_identity_rotations_no_delete BEFORE DELETE ON hub_identity_rotations BEGIN
  SELECT RAISE(ABORT, 'Hub identity rotations are append only');
END;
CREATE TRIGGER hub_identity_rotations_successor BEFORE INSERT ON hub_identity_rotations
WHEN NEW.seq IS NOT (SELECT COALESCE(MAX(seq), 0) + 1 FROM hub_identity_rotations)
  OR (NEW.seq > 1 AND NEW.old_key IS NOT (SELECT new_key FROM hub_identity_rotations WHERE seq = NEW.seq - 1))
  OR EXISTS (SELECT 1 FROM hub_identity_rotations WHERE old_key = NEW.new_key OR new_key = NEW.new_key)
BEGIN
  SELECT RAISE(ABORT, 'Hub identity rotation must extend the chain');
END;
