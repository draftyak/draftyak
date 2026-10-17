// The S10 app: compile-only. The command keeps the transport skeleton linked into the mobile
// library; nothing invokes it.
#[tauri::command]
fn transport_check() -> u32 {
    transport_skeleton::run_check()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![transport_check])
        .run(tauri::generate_context!())
        .expect("the DraftYak S10 app failed to start");
}
