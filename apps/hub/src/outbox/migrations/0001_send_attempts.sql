CREATE TABLE native_send_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  outbox_id TEXT UNIQUE NOT NULL CHECK(length(outbox_id)=26),
  ticket_id TEXT UNIQUE NOT NULL CHECK(length(ticket_id)=26),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768),
  body BLOB NOT NULL CHECK(length(body)<=33554432),
  state TEXT NOT NULL CHECK(state IN ('ISSUED','REDEEMED','SENDING','SENT','FAILED','UNKNOWN','NEEDS_REAPPROVAL','EXPIRED')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  audit_seq INTEGER NOT NULL CHECK(audit_seq>0),
  mac TEXT NOT NULL CHECK(length(mac)=64)
) STRICT;
