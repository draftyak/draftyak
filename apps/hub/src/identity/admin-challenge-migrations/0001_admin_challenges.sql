CREATE TABLE native_admin_challenges (
 id TEXT PRIMARY KEY CHECK(length(id)=26),
 nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=22),
 kind TEXT NOT NULL CHECK(kind='admin.v1'),
 target_id TEXT NOT NULL REFERENCES native_admin_operations(id) CHECK(length(target_id)=26),
 device_id TEXT NOT NULL REFERENCES devices(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 data_class TEXT NOT NULL CHECK(length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
 target_version INTEGER NOT NULL CHECK(target_version BETWEEN 1 AND 9007199254740991),
 statement BLOB NOT NULL CHECK(length(statement) BETWEEN 1 AND 16384),
 issued_at INTEGER NOT NULL CHECK(issued_at BETWEEN 0 AND 9007199254740991),
 expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN issued_at AND issued_at+120000),
 consumed_at INTEGER CHECK(consumed_at BETWEEN issued_at AND 9007199254740991),
 burned_at INTEGER CHECK(burned_at BETWEEN 0 AND 9007199254740991),
 signature TEXT CHECK(signature IS NULL OR length(signature)=86),
 CHECK((consumed_at IS NULL)=(signature IS NULL)),
 CHECK(consumed_at IS NULL OR burned_at IS NULL)
) STRICT;
CREATE INDEX native_admin_challenges_open ON native_admin_challenges(device_id,target_id) WHERE consumed_at IS NULL AND burned_at IS NULL;
CREATE TRIGGER native_admin_challenges_fixed BEFORE UPDATE OF id,nonce,kind,target_id,device_id,user_id,data_class,epoch,target_version,statement,issued_at,expires_at ON native_admin_challenges BEGIN SELECT RAISE(ABORT,'Challenge is fixed'); END;
CREATE TRIGGER native_admin_challenges_final BEFORE UPDATE ON native_admin_challenges WHEN OLD.consumed_at IS NOT NULL OR OLD.burned_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Challenge is settled'); END;
