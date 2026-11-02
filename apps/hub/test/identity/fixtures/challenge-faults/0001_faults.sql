CREATE TABLE dytest_challenge_faults (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 pin_record INTEGER NOT NULL CHECK(pin_record IN (0,1)),
 pair_commit INTEGER NOT NULL CHECK(pair_commit IN (0,1)),
 outbox_state INTEGER NOT NULL CHECK(outbox_state IN (0,1))
) STRICT;
INSERT INTO dytest_challenge_faults(singleton,pin_record,pair_commit,outbox_state) VALUES(1,0,0,0);
CREATE TRIGGER dytest_pin_record BEFORE UPDATE ON approval_pins
WHEN (SELECT pin_record FROM dytest_challenge_faults WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'DYTEST PIN record failure'); END;
CREATE TRIGGER dytest_pair_commit BEFORE UPDATE OF used_at ON pair_confirm_operations
WHEN (SELECT pair_commit FROM dytest_challenge_faults WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'DYTEST pair commit failure'); END;
CREATE TRIGGER dytest_fail_apply BEFORE UPDATE OF state ON outbox
WHEN (SELECT outbox_state FROM dytest_challenge_faults WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'DYTEST final apply failure'); END;
