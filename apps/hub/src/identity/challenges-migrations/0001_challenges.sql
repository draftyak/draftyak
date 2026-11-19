CREATE TABLE approval_challenges (
 id TEXT PRIMARY KEY CHECK(length(id)=26),
 nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=22),
 kind TEXT NOT NULL CHECK(kind IN ('approval.send.v1','pair-confirm.v1')),
 target_id TEXT NOT NULL CHECK(length(target_id)=26),
 device_id TEXT NOT NULL REFERENCES devices(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 data_class TEXT NOT NULL CHECK(length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
 target_version INTEGER CHECK(target_version BETWEEN 1 AND 9007199254740991),
 statement BLOB NOT NULL CHECK(length(statement) BETWEEN 1 AND 16384),
 issued_at INTEGER NOT NULL CHECK(issued_at BETWEEN 0 AND 9007199254740991),
 expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN issued_at AND issued_at+120000),
 consumed_at INTEGER CHECK(consumed_at BETWEEN issued_at AND 9007199254740991),
 burned_at INTEGER CHECK(burned_at BETWEEN 0 AND 9007199254740991),
 signature TEXT CHECK(signature IS NULL OR length(signature)=86),
 CHECK((consumed_at IS NULL)=(signature IS NULL)),
 CHECK(kind<>'pair-confirm.v1' OR data_class='hub.state'),
 CHECK((kind='pair-confirm.v1')=(target_version IS NULL)),
 CHECK(consumed_at IS NULL OR burned_at IS NULL)
) STRICT;
CREATE INDEX approval_challenges_open ON approval_challenges(device_id,kind,target_id) WHERE consumed_at IS NULL AND burned_at IS NULL;
CREATE TRIGGER approval_challenges_fixed BEFORE UPDATE OF id,nonce,kind,target_id,device_id,user_id,data_class,epoch,target_version,statement,issued_at,expires_at ON approval_challenges BEGIN SELECT RAISE(ABORT,'Challenge is fixed'); END;
CREATE TRIGGER approval_challenges_final BEFORE UPDATE ON approval_challenges WHEN OLD.consumed_at IS NOT NULL OR OLD.burned_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Challenge is settled'); END;
CREATE TABLE pair_confirm_operations (
 id TEXT PRIMARY KEY CHECK(length(id)=26),
 approver_id TEXT NOT NULL REFERENCES devices(id),
 candidate_id TEXT NOT NULL REFERENCES devices(id),
 preset TEXT NOT NULL CHECK(preset IN ('desktop','mobile','cli')),
 digest TEXT NOT NULL CHECK(length(digest)=64),
 created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN created_at+1 AND created_at+120000),
 used_at INTEGER CHECK(used_at BETWEEN created_at AND 9007199254740991),
 CHECK(approver_id<>candidate_id)
) STRICT;
CREATE TRIGGER pair_confirm_operations_fixed BEFORE UPDATE OF id,approver_id,candidate_id,preset,digest,created_at,expires_at ON pair_confirm_operations BEGIN SELECT RAISE(ABORT,'Operation is fixed'); END;
CREATE TRIGGER pair_confirm_operations_final BEFORE UPDATE ON pair_confirm_operations WHEN OLD.used_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Operation is settled'); END;
