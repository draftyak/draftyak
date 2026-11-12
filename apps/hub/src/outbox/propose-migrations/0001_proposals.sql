CREATE TABLE outbox (
  id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=26),
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL CHECK(length(CAST(account_id AS BLOB))=26),
  draft_id TEXT NOT NULL REFERENCES native_drafts(id),
  state TEXT NOT NULL CHECK(state IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','SENDING','RETRY_WAIT','UNKNOWN','SENT','FAILED','NEEDS_REAPPROVAL','CANCELLED','REJECTED','SUPERSEDED','EXPIRED')),
  schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('now','at')),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152),
  audit_seq INTEGER NOT NULL CHECK(audit_seq BETWEEN 1 AND 9007199254740991),
  mac TEXT NOT NULL CHECK(length(CAST(mac AS BLOB))=64)
) STRICT;
CREATE UNIQUE INDEX outbox_one_live_draft ON outbox(draft_id)
  WHERE state IN ('APPROVED','SCHEDULED','SENDING','RETRY_WAIT','UNKNOWN');
CREATE INDEX outbox_draft ON outbox(draft_id,state);
CREATE INDEX outbox_scheduled ON outbox(account_id,schedule_kind,state);
