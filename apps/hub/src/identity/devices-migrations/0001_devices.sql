CREATE TABLE device_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch BETWEEN 0 AND 9007199254740991),
  bootstrap_done INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_done IN (0, 1)),
  owner_user_id TEXT REFERENCES users(id),
  CHECK(bootstrap_done = 0 OR owner_user_id IS NOT NULL)
) STRICT;
INSERT INTO device_authority(singleton) VALUES(1);
CREATE TABLE devices (
  id TEXT PRIMARY KEY CHECK(length(id) = 26 AND NOT id GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  user_id TEXT REFERENCES users(id),
  role TEXT NOT NULL CHECK(role = 'device'),
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 256),
  spki_sha256 TEXT NOT NULL UNIQUE
    CHECK(length(spki_sha256) = 64 AND NOT spki_sha256 GLOB '*[^0-9a-f]*'),
  approval_key TEXT NOT NULL UNIQUE CHECK(length(approval_key) = 122
    AND substr(approval_key, 1, 36) = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'
    AND NOT approval_key GLOB '*[^A-Za-z0-9_-]*'),
  key_class TEXT CHECK(key_class IS NULL OR key_class IN ('keyring', 'dev')),
  claim_window TEXT NOT NULL CHECK(claim_window IN ('sidecar', 'pairing')),
  paired_epoch INTEGER NOT NULL CHECK(paired_epoch BETWEEN 0 AND 9007199254740991),
  paired_at INTEGER NOT NULL CHECK(paired_at BETWEEN 0 AND 9007199254740991),
  capabilities INTEGER NOT NULL DEFAULT 0 CHECK(capabilities BETWEEN 0 AND 31),
  confirmed_epoch INTEGER CHECK(confirmed_epoch BETWEEN 0 AND 9007199254740991),
  confirmed_via TEXT CHECK(confirmed_via IN ('bootstrap', 'approver', 'cli', 'recovery')),
  confirmed_preset TEXT CHECK(confirmed_preset IN ('desktop', 'mobile', 'cli')),
  confirmed_by TEXT REFERENCES devices(id),
  confirmed_at INTEGER CHECK(confirmed_at BETWEEN 0 AND 9007199254740991),
  revoked_at INTEGER CHECK(revoked_at BETWEEN 0 AND 9007199254740991),
  CHECK((confirmed_epoch IS NULL) = (capabilities = 0)),
  CHECK((confirmed_epoch IS NULL) = (confirmed_via IS NULL)),
  CHECK((confirmed_epoch IS NULL) = (confirmed_preset IS NULL)),
  CHECK((confirmed_epoch IS NULL) = (confirmed_at IS NULL)),
  CHECK(coalesce(confirmed_via = 'approver', 0) = (confirmed_by IS NOT NULL)),
  CHECK(CASE confirmed_via WHEN 'cli' THEN confirmed_preset = 'cli'
    WHEN 'bootstrap' THEN confirmed_preset = 'desktop'
    WHEN 'recovery' THEN confirmed_preset = 'desktop' ELSE 1 END),
  CHECK((capabilities & ~(CASE confirmed_preset WHEN 'desktop' THEN 31 WHEN 'mobile' THEN 7
    WHEN 'cli' THEN 3 ELSE 0 END)) = 0),
  CHECK(confirmed_epoch IS NULL OR user_id IS NOT NULL)
) STRICT;
CREATE TRIGGER device_authority_no_delete BEFORE DELETE ON device_authority BEGIN
  SELECT RAISE(ABORT, 'Device authority is permanent');
END;
CREATE TRIGGER device_authority_forward BEFORE UPDATE ON device_authority
WHEN NEW.epoch < OLD.epoch
  OR NEW.epoch > OLD.epoch + 1
  OR (NEW.epoch = OLD.epoch + 1 AND NEW.bootstrap_done <> 0)
  OR (NEW.epoch = OLD.epoch AND OLD.bootstrap_done = 1 AND NEW.bootstrap_done = 0)
  OR (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NOT OLD.owner_user_id)
BEGIN
  SELECT RAISE(ABORT, 'Device authority only moves forward');
END;
CREATE TRIGGER devices_no_delete BEFORE DELETE ON devices BEGIN
  SELECT RAISE(ABORT, 'Devices are never deleted');
END;
CREATE TRIGGER devices_fixed_identity BEFORE UPDATE OF
  id, role, spki_sha256, approval_key, key_class, claim_window, paired_epoch, paired_at
ON devices BEGIN
  SELECT RAISE(ABORT, 'Device identity is fixed');
END;
CREATE TRIGGER devices_final_revocation BEFORE UPDATE ON devices
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Device revocation is final');
END;
CREATE TRIGGER devices_forward BEFORE UPDATE ON devices
WHEN (OLD.confirmed_epoch IS NOT NULL AND
  (NEW.confirmed_epoch IS NULL OR NEW.confirmed_epoch < OLD.confirmed_epoch))
  OR (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id)
BEGIN
  SELECT RAISE(ABORT, 'Device confirmation only moves forward');
END;
CREATE TRIGGER devices_preset_fixed BEFORE UPDATE ON devices
WHEN NEW.confirmed_epoch IS OLD.confirmed_epoch AND
  (NEW.confirmed_preset IS NOT OLD.confirmed_preset OR NEW.confirmed_via IS NOT OLD.confirmed_via)
BEGIN
  SELECT RAISE(ABORT, 'Confirmation policy is fixed within its epoch');
END;
