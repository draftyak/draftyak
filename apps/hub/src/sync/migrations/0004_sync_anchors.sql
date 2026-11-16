CREATE TABLE sync_scan_anchors (
  scan_id TEXT PRIMARY KEY NOT NULL,
  anchor_version INTEGER NOT NULL CHECK(typeof(anchor_version)='integer' AND anchor_version=1),
  sampled_at INTEGER NOT NULL CHECK(typeof(sampled_at)='integer' AND sampled_at BETWEEN 0 AND 9007199254740991),
  history_days INTEGER NOT NULL CHECK(typeof(history_days)='integer' AND history_days BETWEEN 1 AND 365),
  anchor_job_id TEXT NOT NULL CHECK(length(anchor_job_id)=26 AND length(CAST(anchor_job_id AS BLOB))=26 AND anchor_job_id GLOB '[0-7]*' AND anchor_job_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  job_created_at INTEGER NOT NULL CHECK(typeof(job_created_at)='integer' AND job_created_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY(scan_id) REFERENCES sync_scans(id) ON DELETE CASCADE
) STRICT;
-- Existing scans intentionally receive no anchor. Native bounded recovery retires an active unanchored scan.
