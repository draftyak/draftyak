CREATE TABLE main.gmail_poll_journal (
    account_id TEXT NOT NULL COLLATE BINARY
        CHECK (length(CAST(account_id AS BLOB)) BETWEEN 1 AND 256 AND instr(account_id, char(0)) = 0),
    generation INTEGER NOT NULL
        CHECK (generation BETWEEN 0 AND 9007199254740991),
    plugin_instance_id TEXT NOT NULL COLLATE BINARY
        CHECK (length(CAST(plugin_instance_id AS BLOB)) BETWEEN 1 AND 256 AND instr(plugin_instance_id, char(0)) = 0),
    owner_epoch INTEGER NOT NULL
        CHECK (owner_epoch BETWEEN 0 AND 9007199254740991),
    mode TEXT NOT NULL COLLATE BINARY CHECK (mode IN ('full', 'read_only')),
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) BETWEEN 1 AND 16384),
    PRIMARY KEY (account_id, generation, plugin_instance_id, owner_epoch, mode)
) STRICT;
