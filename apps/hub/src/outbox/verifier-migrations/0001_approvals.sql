CREATE TABLE approvals (
 id TEXT PRIMARY KEY CHECK(length(id)=26),
 outbox_id TEXT NOT NULL CHECK(length(outbox_id)=26),
 account_id TEXT NOT NULL CHECK(length(account_id)=26),
 data_class TEXT NOT NULL CHECK(length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64),
 challenge_id TEXT NOT NULL UNIQUE REFERENCES approval_challenges(id),
 device_id TEXT NOT NULL REFERENCES devices(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 flags_hash TEXT NOT NULL CHECK(length(flags_hash)=64),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
 target_version INTEGER NOT NULL CHECK(target_version BETWEEN 1 AND 9007199254740991),
 iat INTEGER NOT NULL CHECK(iat BETWEEN 0 AND 9007199254740991),
 not_before INTEGER CHECK(not_before BETWEEN 0 AND 9007199254740991),
 deliver_by INTEGER NOT NULL CHECK(deliver_by BETWEEN iat AND 9007199254740991),
 accepted_at INTEGER NOT NULL CHECK(accepted_at BETWEEN iat AND 9007199254740991),
 consumed_at INTEGER CHECK(consumed_at BETWEEN accepted_at AND 9007199254740991),
 voided_at INTEGER CHECK(voided_at BETWEEN accepted_at AND 9007199254740991),
 void_reason TEXT CHECK(void_reason IN ('missed','new_reply','channel_changed','approver_revoked','credential_lost','plugin_quarantined','policy','restored','not_found')),
 audit_seq INTEGER NOT NULL CHECK(audit_seq>0),
 audit_mac TEXT NOT NULL CHECK(length(audit_mac)=64),
 mac TEXT NOT NULL CHECK(length(mac)=64),
 CHECK((voided_at IS NULL)=(void_reason IS NULL)),
 CHECK(not_before IS NULL OR not_before<=deliver_by),
 CHECK(consumed_at IS NULL OR voided_at IS NULL)
) STRICT;
CREATE UNIQUE INDEX approvals_one_live_user ON approvals(outbox_id,user_id) WHERE consumed_at IS NULL AND voided_at IS NULL;
CREATE INDEX approvals_live_item ON approvals(outbox_id,content_hash,flags_hash,epoch) WHERE consumed_at IS NULL AND voided_at IS NULL;
CREATE TRIGGER approvals_fixed BEFORE UPDATE OF id,outbox_id,account_id,data_class,challenge_id,device_id,user_id,content_hash,flags_hash,epoch,target_version,iat,not_before,deliver_by,accepted_at ON approvals BEGIN SELECT RAISE(ABORT,'Approval is fixed'); END;
CREATE TRIGGER approvals_final BEFORE UPDATE ON approvals WHEN OLD.consumed_at IS NOT NULL OR OLD.voided_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Approval is settled'); END;
