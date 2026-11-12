CREATE TABLE native_gmail_send_receipts (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES native_send_attempts(id) CHECK(length(attempt_id)=26),
  receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 4259840)
) STRICT;
