use super::common::{MAX_SAFE, device_statement, id, sha};
use crate::{
    flags::{Flag, FlagCode, flags_hash, required_ack_codes},
    snapshot::{SendSnapshotV1, check_current_send_snapshot, send_window},
};
device_statement!(SendStatement,Wire,{outbox:String,content_hash:String,flags_hash:String,flags_acked:Vec<FlagCode>,#[serde(deserialize_with="super::common::required_nullable")]not_before:Option<u64>,deliver_by:u64},|s:&SendStatement|id(&s.outbox)&&sha(&s.content_hash)&&sha(&s.flags_hash)&&s.flags_acked.windows(2).all(|pair|pair[0].as_str()<pair[1].as_str())&&s.not_before.is_none_or(|v|v<=MAX_SAFE)&&s.deliver_by<=MAX_SAFE);
pub fn check_send_window(statement: &SendStatement, snapshot: &SendSnapshotV1) -> bool {
    statement.valid()
        && check_current_send_snapshot(snapshot)
        && send_window(snapshot, statement.iat).is_ok_and(|w| {
            statement.not_before == w.not_before && statement.deliver_by == w.deliver_by
        })
}
pub fn check_flags_acked(statement: &SendStatement, flags: &[Flag]) -> bool {
    statement.valid()
        && flags_hash(flags).is_ok_and(|hash| hash == statement.flags_hash)
        && required_ack_codes(flags).is_ok_and(|required| {
            required
                .iter()
                .all(|code| statement.flags_acked.contains(code))
        })
}
