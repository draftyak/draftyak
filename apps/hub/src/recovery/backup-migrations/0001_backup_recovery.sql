CREATE TABLE native_backup_recovery (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 binding BLOB NOT NULL CHECK(length(binding)=69)
) STRICT;
