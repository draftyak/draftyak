CREATE TABLE jobs_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1)
) STRICT;
INSERT INTO jobs_meta(singleton) VALUES(1);
CREATE TABLE jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK(length(id) = 26),
  account_id TEXT NOT NULL CHECK(length(account_id) = 26),
  owner_id TEXT NOT NULL CHECK(length(owner_id) = 26),
  kind TEXT NOT NULL CHECK(kind IN ('sync', 'draft', 'retention', 'reconcile')),
  ref_id TEXT NOT NULL CHECK(length(ref_id) = 26),
  state TEXT NOT NULL CHECK(state IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 20),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  next_at INTEGER NOT NULL CHECK(next_at BETWEEN 0 AND 9007199254740991),
  lease_until INTEGER CHECK(lease_until BETWEEN 0 AND 9007199254740991),
  token TEXT CHECK(length(token) = 64),
  CHECK(attempts <= max_attempts),
  CHECK((state = 'RUNNING' AND lease_until IS NOT NULL AND token IS NOT NULL)
     OR (state != 'RUNNING' AND lease_until IS NULL AND token IS NULL))
) STRICT;
CREATE UNIQUE INDEX jobs_one_running_account ON jobs(account_id) WHERE state = 'RUNNING';
CREATE INDEX jobs_pending ON jobs(account_id, state, next_at, seq);
CREATE INDEX jobs_expiring ON jobs(state, lease_until, seq);
