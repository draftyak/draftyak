CREATE TABLE owner_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  settings_json TEXT NOT NULL CHECK(length(CAST(settings_json AS BLOB)) BETWEEN 1 AND 4096)
) STRICT;
