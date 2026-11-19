CREATE TABLE dytest_admin_faults (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 final_op INTEGER NOT NULL CHECK(final_op IN (0,1)),
 pin_material INTEGER NOT NULL CHECK(pin_material IN (0,1)),
 owner_user_id TEXT CHECK(owner_user_id IS NULL OR length(owner_user_id)=26)
) STRICT;
INSERT INTO dytest_admin_faults(singleton,final_op,pin_material,owner_user_id) VALUES(1,0,0,NULL);
CREATE TRIGGER dytest_admin_final_operation BEFORE UPDATE OF state ON native_admin_operations
WHEN NEW.state='applied' AND (SELECT final_op FROM dytest_admin_faults WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'DYTEST operation settlement failure'); END;
CREATE TRIGGER dytest_admin_pin_material AFTER UPDATE ON jobs_meta
WHEN (SELECT pin_material FROM dytest_admin_faults WHERE singleton=1)=1
BEGIN
 UPDATE approval_pins SET version=version+1
 WHERE user_id=(SELECT owner_user_id FROM dytest_admin_faults WHERE singleton=1);
END;
