use super::common::{device_statement, id, sha};
device_statement!(LoginStatement,Wire,{login:String,digest:String},|s:&LoginStatement|id(&s.login)&&sha(&s.digest));
