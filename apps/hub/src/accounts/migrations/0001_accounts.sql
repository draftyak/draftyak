CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=26),
  user_id TEXT NOT NULL CHECK(length(user_id)=26),
  plugin_instance_id TEXT NOT NULL CHECK(length(plugin_instance_id)=26),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  account_json TEXT CHECK(account_json IS NULL OR length(CAST(account_json AS BLOB)) BETWEEN 2 AND 8192)
) STRICT;
CREATE INDEX accounts_owner ON accounts(user_id,id);
CREATE INDEX accounts_plugin ON accounts(plugin_instance_id,id);
