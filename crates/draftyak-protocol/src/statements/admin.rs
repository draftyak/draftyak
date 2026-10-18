use super::common::{device_statement,id,sha};
macro_rules! admin_groups {
 ($($group:ident => [$($kind:literal),* $(,)?]),* $(,)?) => {
  pub const ADMIN_GROUPS: &[(&str,&[&str])] = &[$((stringify!($group), &[$($kind),*])),*];
  pub const ADMIN_KINDS: &[&str] = &[$($($kind,)*)*];
 };
}
admin_groups! {
 plugins => ["plugin.install","plugin.upgrade"],
 accounts => ["account.connect","account.disconnect","account.mode-full"],
 policy => ["policy.routing-loosen","policy.auto-draft-enable"],
 tools => ["tool.instance-create","tool.secret-set","tool.enable","tool.posture-no-train"],
 access => ["access.token-mint","access.grant-widen","access.cimd-host-add","access.exposure-enable","access.bind-address-add","access.advertised-addresses-set"],
 security => ["security.device-capabilities","security.pin-change","security.key-rotate"],
 data => ["data.export"],
 sms => [],
}
device_statement!(AdminStatement,Wire,{op:String,kind:String,digest:String},|s:&AdminStatement|id(&s.op)&&ADMIN_KINDS.contains(&s.kind.as_str())&&sha(&s.digest));
