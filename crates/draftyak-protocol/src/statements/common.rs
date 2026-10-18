use crate::sign::{base64url_decode, verifying_key_from_spki};
use serde::{Deserialize, Deserializer};
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub const TTL_MS: u64 = 120_000;
pub fn id(s: &str) -> bool {
    s.len() == 26
        && matches!(s.as_bytes()[0], b'0'..=b'7')
        && s.bytes()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
}
pub fn sha(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn key(s: &str) -> bool {
    base64url_decode(s).is_some_and(|der| verifying_key_from_spki(&der).is_ok())
}
pub fn nonce(s: &str) -> bool {
    base64url_decode(s).is_some_and(|bytes| bytes.len() == 16)
}
pub fn required_nullable<'de, D: Deserializer<'de>>(decoder: D) -> Result<Option<u64>, D::Error> {
    Option::<u64>::deserialize(decoder)
}
macro_rules! device_statement {
    ($name:ident,$wire:ident,{$($(#[$attribute:meta])* $field:ident:$typ:ty),* $(,)?},$extra:expr)=>{
        #[derive(Debug,Clone,serde::Serialize)]
        #[serde(rename_all="camelCase")]
        pub struct $name {pub v:u8,pub hub:String,pub epoch:u64,pub device:String,pub nonce:String,pub iat:u64,pub exp:u64,$($(#[$attribute])*pub $field:$typ),*}
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields,rename_all="camelCase")]
        struct $wire {v:u8,hub:String,epoch:u64,device:String,nonce:String,iat:u64,exp:u64,$($(#[$attribute])*$field:$typ),*}
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D:serde::Deserializer<'de>>(decoder:D)->Result<Self,D::Error>{
                let wire=<$wire as serde::Deserialize>::deserialize(decoder).map_err(|_|serde::de::Error::custom("STATEMENT_INVALID"))?;
                let body=Self{v:wire.v,hub:wire.hub,epoch:wire.epoch,device:wire.device,nonce:wire.nonce,iat:wire.iat,exp:wire.exp,$($field:wire.$field),*};
                if !body.valid(){return Err(serde::de::Error::custom("STATEMENT_INVALID"));}Ok(body)
            }
        }
        impl $name {pub fn valid(&self)->bool {self.v==1&&super::common::sha(&self.hub)&&(0..=super::common::MAX_SAFE).contains(&self.epoch)&&super::common::id(&self.device)&&super::common::nonce(&self.nonce)&&self.exp<=super::common::MAX_SAFE&&self.iat<=self.exp&&self.exp-self.iat<=super::common::TTL_MS&&($extra)(self)}
            pub fn is_fresh(&self,now:u64)->bool{self.valid()&&now>=self.iat&&now<=self.exp}
        }
    }
}
pub(crate) use device_statement;
