//! Keep-awake and resume (plan §7 Bundled sidecar), with no Tauri, so their tests also run on CI's
//! plain runners.
//!
//! - **Keep-awake.** From the hub's `{keepAwake: untilMs}` until `{keepAwake: null}` the app holds
//!   the system awake: `PowerSetRequest(PowerRequestSystemRequired)` on Windows, an `IOPMAssertion`
//!   of type `PreventUserIdleSystemSleep` on macOS, a logind `idle` inhibitor in `block` mode on
//!   Linux. The hold also ends once `untilMs` passes, when the hub that asked for it exits and when
//!   the app quits, so a hub that dies holding it can't keep the system awake. A refusal is logged
//!   on stderr and reported, never fatal; the next frame tries again.
//! - **Resume.** After each OS wake (`PBT_APMRESUMEAUTOMATIC`, `NSWorkspaceDidWakeNotification`,
//!   logind's `PrepareForSleep(false)`) the app sends the hub `{power: "resumed"}`.
//!
//! [`Power`] runs both on its own thread over a [`Layer`], the OS side ([`native`]), which tests
//! replace with a mock such as [`LogindRefuses`]. Every change is a [`Report`].

use std::io;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::sidecar::Event;

/// What a [`Layer`] calls after each OS resume, with the OS's name for it.
pub type Wake = Arc<dyn Fn(&'static str) + Send + Sync>;

/// Who holds the system awake, as logind lists it and the macOS assertion's name starts.
pub const HOLDER: &str = "DraftYak Spike Desktop";
/// Why, as logind lists it and the assertion's name ends.
pub const REASON: &str = "a scheduled send is due";
/// The longest the controller waits, so a deadline survives a change of the wall clock.
const MAX_WAIT: Duration = Duration::from_secs(5);

/// Windows: the power broadcast every resume sends (`PBT_APMRESUMESUSPEND` follows it only when
/// a user is present).
pub fn resumed_by_broadcast(event: u32) -> Option<&'static str> {
    (event == 0x12).then_some("PBT_APMRESUMEAUTOMATIC")
}

/// logind's `PrepareForSleep(start)`: `false` once the system has resumed.
pub fn resumed_by_logind(start: bool) -> Option<&'static str> {
    (!start).then_some("PrepareForSleep(false)")
}

/// The OS side of keep-awake and resume.
pub trait Layer: Send {
    /// How it holds the system awake.
    fn method(&self) -> &'static str;
    /// Starts holding the system awake.
    fn hold(&mut self) -> Result<(), String>;
    /// Stops holding it; called only while held.
    fn release(&mut self) -> Result<(), String>;
    /// Registers `wake` for each OS resume; `Ok` describes the registration.
    fn listen(&mut self, wake: Wake) -> Result<Value, String>;
    /// Delivers a suspend and resume as far as this process can without sleeping (spike control
    /// only), and names what it delivered: macOS posts the notification to NSWorkspace's center,
    /// Windows calls the registered callback itself, Linux calls `wake` behind the signal's filter.
    fn simulate_wake(&mut self) -> Result<Vec<&'static str>, String>;
    /// What the OS reports about keep-awake, where this process can read it.
    fn observe(&self) -> Value {
        Value::Null
    }
}

/// What [`Power`] reports, on its own thread.
#[derive(Clone, Debug, PartialEq)]
pub enum Report {
    Listening {
        detail: Value,
    },
    NotListening {
        error: String,
    },
    Held {
        generation: u32,
        until_ms: u64,
        method: &'static str,
    },
    /// A new `untilMs` while held.
    Extended {
        generation: u32,
        until_ms: u64,
    },
    Refused {
        generation: u32,
        method: &'static str,
        error: String,
    },
    Released {
        why: &'static str,
    },
    ReleaseFailed {
        why: &'static str,
        error: String,
    },
    /// `forwarded` once [`Power::connect`] has given it somewhere to go.
    Resumed {
        via: &'static str,
        forwarded: bool,
    },
}

impl Report {
    /// `{"event": "power", "action": "<kind>", ...}`, as the spike app prints it.
    pub fn to_json(&self) -> Value {
        let mut value = match self {
            Report::Listening { detail } => json!({ "action": "listening", "detail": detail }),
            Report::NotListening { error } => json!({ "action": "notListening", "error": error }),
            Report::Held { generation, until_ms, method } => json!({
                "action": "held", "generation": generation, "untilMs": until_ms, "method": method,
            }),
            Report::Extended { generation, until_ms } => {
                json!({ "action": "extended", "generation": generation, "untilMs": until_ms })
            }
            Report::Refused { generation, method, error } => json!({
                "action": "refused", "generation": generation, "method": method, "error": error,
            }),
            Report::Released { why } => json!({ "action": "released", "why": why }),
            Report::ReleaseFailed { why, error } => {
                json!({ "action": "releaseFailed", "why": why, "error": error })
            }
            Report::Resumed { via, forwarded } => {
                json!({ "action": "resumed", "via": via, "forwarded": forwarded })
            }
        };
        value["event"] = json!("power");
        value
    }
}

enum Msg {
    KeepAwake(u32, Option<u64>),
    HubEnded(u32),
    Woke(&'static str),
    Connect(Box<dyn Fn() + Send>),
    Simulate(Sender<Result<Vec<&'static str>, String>>),
    Status(Sender<Value>),
    Stop(Sender<()>),
}

/// Feeds the supervisor's events to [`Power`]; cheap to clone into its event closure.
#[derive(Clone)]
pub struct Handle(Sender<Msg>);

impl Handle {
    /// A `{keepAwake}` frame from hub `generation`.
    pub fn keep_awake(&self, generation: u32, until_ms: Option<u64>) {
        let _ = self.0.send(Msg::KeepAwake(generation, until_ms));
    }

    /// Hub `generation` exited: a hold it asked for ends with it.
    pub fn hub_ended(&self, generation: u32) {
        let _ = self.0.send(Msg::HubEnded(generation));
    }

    /// Passes on what keep-awake follows: `keepAwake` frames and hub exits.
    pub fn follow(&self, event: &Event) {
        match *event {
            Event::KeepAwake { generation, until_ms } => self.keep_awake(generation, until_ms),
            Event::Exited { generation, .. } => self.hub_ended(generation),
            _ => {}
        }
    }
}

/// Keep-awake and resume on their own thread, until [`Power::stop`] or drop.
pub struct Power {
    tx: Sender<Msg>,
}

impl Power {
    /// Registers the resume listener, then follows what [`Power::handle`] passes on.
    pub fn start(
        mut layer: Box<dyn Layer>,
        report: impl FnMut(Report) + Send + 'static,
    ) -> io::Result<Power> {
        let (tx, rx) = mpsc::channel();
        let woke = tx.clone();
        let wake: Wake = Arc::new(move |via| {
            let _ = woke.send(Msg::Woke(via));
        });
        thread::Builder::new().name("power".into()).spawn(move || {
            let listening = layer.listen(wake);
            Controller::new(layer, Box::new(report), listening).run(&rx);
        })?;
        Ok(Power { tx })
    }

    pub fn handle(&self) -> Handle {
        Handle(self.tx.clone())
    }

    /// What a resume runs from now on: the app sends the hub `{power: "resumed"}`.
    pub fn connect(&self, on_resume: impl Fn() + Send + 'static) {
        let _ = self.tx.send(Msg::Connect(Box::new(on_resume)));
    }

    /// The hold, the counts, the resume listener and what the OS reports.
    pub fn status(&self) -> Value {
        let (reply, answer) = mpsc::channel();
        let _ = self.tx.send(Msg::Status(reply));
        answer.recv_timeout(MAX_WAIT).unwrap_or(Value::Null)
    }

    /// See [`Layer::simulate_wake`].
    pub fn simulate_wake(&self) -> Result<Vec<&'static str>, String> {
        let (reply, answer) = mpsc::channel();
        let _ = self.tx.send(Msg::Simulate(reply));
        answer.recv_timeout(MAX_WAIT).map_err(|_| "keep-awake has stopped".to_string())?
    }

    /// Releases any hold and ends the thread; later calls do nothing.
    pub fn stop(&self) {
        let (done, stopped) = mpsc::channel();
        if self.tx.send(Msg::Stop(done)).is_ok() {
            let _ = stopped.recv_timeout(MAX_WAIT);
        }
    }
}

impl Drop for Power {
    fn drop(&mut self) {
        self.stop();
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

struct Controller {
    layer: Box<dyn Layer>,
    report: Box<dyn FnMut(Report) + Send>,
    listening: Result<Value, String>,
    on_resume: Option<Box<dyn Fn() + Send>>,
    /// The hub generation that asked, and until when.
    hold: Option<(u32, u64)>,
    /// Holds, releases, refusals and resumes.
    counts: [u32; 4],
    last_refusal: Option<String>,
}

impl Controller {
    fn new(
        layer: Box<dyn Layer>,
        mut report: Box<dyn FnMut(Report) + Send>,
        listening: Result<Value, String>,
    ) -> Controller {
        match &listening {
            Ok(detail) => report(Report::Listening { detail: detail.clone() }),
            Err(error) => {
                eprintln!("app: no resume listener: {error}");
                report(Report::NotListening { error: error.clone() });
            }
        }
        let (on_resume, hold, last_refusal) = (None, None, None);
        Controller { layer, report, listening, on_resume, hold, counts: [0; 4], last_refusal }
    }

    fn run(&mut self, rx: &Receiver<Msg>) {
        loop {
            let message = match self.hold {
                Some((_, until)) => {
                    let left = Duration::from_millis(until.saturating_sub(now_ms()));
                    rx.recv_timeout(left.min(MAX_WAIT))
                }
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match message {
                Ok(Msg::KeepAwake(generation, Some(until))) if until > now_ms() => {
                    self.keep(generation, until);
                }
                Ok(Msg::KeepAwake(_, None)) => self.release("null frame"),
                Ok(Msg::KeepAwake(..)) => self.release("untilMs passed"),
                Ok(Msg::HubEnded(generation)) => {
                    if self.hold.is_some_and(|(asked, _)| asked == generation) {
                        self.release("hub exited");
                    }
                }
                Ok(Msg::Woke(via)) => {
                    self.counts[3] += 1;
                    let forwarded = self.on_resume.as_ref().map(|on_resume| on_resume()).is_some();
                    (self.report)(Report::Resumed { via, forwarded });
                }
                Ok(Msg::Connect(on_resume)) => self.on_resume = Some(on_resume),
                Ok(Msg::Simulate(reply)) => {
                    let _ = reply.send(self.layer.simulate_wake());
                }
                Ok(Msg::Status(reply)) => {
                    let _ = reply.send(self.status());
                }
                Ok(Msg::Stop(done)) => {
                    self.release("shutdown");
                    let _ = done.send(());
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return self.release("shutdown"),
            }
            if self.hold.is_some_and(|(_, until)| until <= now_ms()) {
                self.release("deadline");
            }
        }
    }

    fn keep(&mut self, generation: u32, until_ms: u64) {
        if self.hold.is_some() {
            self.hold = Some((generation, until_ms));
            return (self.report)(Report::Extended { generation, until_ms });
        }
        let method = self.layer.method();
        match self.layer.hold() {
            Ok(()) => {
                self.hold = Some((generation, until_ms));
                self.counts[0] += 1;
                (self.report)(Report::Held { generation, until_ms, method });
            }
            Err(error) => {
                eprintln!("app: keep-awake refused ({method}): {error}");
                self.counts[2] += 1;
                self.last_refusal = Some(error.clone());
                (self.report)(Report::Refused { generation, method, error });
            }
        }
    }

    fn release(&mut self, why: &'static str) {
        if self.hold.take().is_none() {
            return;
        }
        match self.layer.release() {
            Ok(()) => {
                self.counts[1] += 1;
                (self.report)(Report::Released { why });
            }
            Err(error) => {
                eprintln!("app: keep-awake release failed: {error}");
                (self.report)(Report::ReleaseFailed { why, error });
            }
        }
    }

    fn status(&self) -> Value {
        let resume = match &self.listening {
            Ok(detail) => detail.clone(),
            Err(error) => json!({ "registered": false, "error": error }),
        };
        let [holds, releases, refusals, resumes] = self.counts;
        json!({
            "method": self.layer.method(),
            "held": self.hold.is_some(),
            "generation": self.hold.map(|(generation, _)| generation),
            "untilMs": self.hold.map(|(_, until)| until),
            "holds": holds,
            "releases": releases,
            "refusals": refusals,
            "lastRefusal": self.last_refusal,
            "resume": resume,
            "resumes": resumes,
            "observed": self.layer.observe(),
        })
    }
}

/// A mocked layer (the app's `DRAFTYAK_SPIKE_POWER=logind-refuses`): every hold fails the way
/// zbus reports logind refusing an inhibitor, and resumes come only from
/// [`Layer::simulate_wake`].
#[derive(Default)]
pub struct LogindRefuses {
    wake: Option<Wake>,
}

impl LogindRefuses {
    pub const REFUSAL: &str = "org.freedesktop.DBus.Error.AccessDenied: Access denied";
}

impl Layer for LogindRefuses {
    fn method(&self) -> &'static str {
        "logind Inhibit(idle, block), mocked"
    }

    fn hold(&mut self) -> Result<(), String> {
        Err(LogindRefuses::REFUSAL.into())
    }

    fn release(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn listen(&mut self, wake: Wake) -> Result<Value, String> {
        self.wake = Some(wake);
        Ok(json!({ "via": "mock", "registered": true, "resumesOn": "PrepareForSleep(false)" }))
    }

    fn simulate_wake(&mut self) -> Result<Vec<&'static str>, String> {
        let wake = self.wake.as_ref().ok_or("no resume listener")?;
        wake("PrepareForSleep(false)");
        Ok(vec!["PrepareForSleep(true)", "PrepareForSleep(false)"])
    }
}

/// This OS's layer.
pub fn native() -> Box<dyn Layer> {
    Box::new(os::Native::default())
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;
    use std::{io, ptr};

    use serde_json::{Value, json};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Power::{
        CallNtPowerInformation, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, ES_SYSTEM_REQUIRED,
        HPOWERNOTIFY, PowerClearRequest, PowerCreateRequest,
        PowerRegisterSuspendResumeNotification, PowerRequestSystemRequired, PowerSetRequest,
        PowerUnregisterSuspendResumeNotification, SystemExecutionState,
    };
    use windows_sys::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
    };

    use super::{HOLDER, Layer, REASON, Wake, resumed_by_broadcast};

    struct Request(HANDLE);

    // SAFETY: a power request handle may be used and closed from any thread.
    unsafe impl Send for Request {}

    #[derive(Default)]
    pub struct Native {
        request: Option<Request>,
        /// The callback's context, which lives as long as the process.
        wake: Option<&'static Wake>,
        registration: Option<HPOWERNOTIFY>,
    }

    fn failed(what: &str) -> String {
        format!("{what} failed: {}", io::Error::last_os_error())
    }

    // The system calls this on a thread of its own for each suspend and resume broadcast.
    unsafe extern "system" fn on_broadcast(
        context: *const c_void,
        event: u32,
        _setting: *const c_void,
    ) -> u32 {
        // SAFETY: the context is the leaked Wake that listen() registered with this callback.
        let wake = unsafe { &*context.cast::<Wake>() };
        if let Some(via) = resumed_by_broadcast(event) {
            wake(via);
        }
        ERROR_SUCCESS
    }

    impl Layer for Native {
        fn method(&self) -> &'static str {
            "PowerSetRequest(PowerRequestSystemRequired)"
        }

        fn hold(&mut self) -> Result<(), String> {
            let mut reason: Vec<u16> =
                format!("{HOLDER}: {REASON}").encode_utf16().chain([0]).collect();
            let context = REASON_CONTEXT {
                Version: POWER_REQUEST_CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 { SimpleReasonString: reason.as_mut_ptr() },
            };
            let handle = unsafe { PowerCreateRequest(&context) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(failed("PowerCreateRequest"));
            }
            let request = Request(handle);
            if unsafe { PowerSetRequest(request.0, PowerRequestSystemRequired) } == 0 {
                let error = failed("PowerSetRequest");
                unsafe { CloseHandle(request.0) };
                return Err(error);
            }
            self.request = Some(request);
            Ok(())
        }

        fn release(&mut self) -> Result<(), String> {
            let Some(request) = self.request.take() else {
                return Ok(());
            };
            let cleared = unsafe { PowerClearRequest(request.0, PowerRequestSystemRequired) } != 0;
            let error = (!cleared).then(|| failed("PowerClearRequest"));
            unsafe { CloseHandle(request.0) };
            error.map_or(Ok(()), Err)
        }

        fn listen(&mut self, wake: Wake) -> Result<Value, String> {
            let wake: &'static Wake = Box::leak(Box::new(wake));
            // The callback and its context stay valid for as long as the registration exists.
            let parameters = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
                Callback: Some(on_broadcast),
                Context: ptr::from_ref(wake).cast_mut().cast(),
            }));
            let mut registration = ptr::null_mut();
            let recipient: HANDLE = ptr::from_mut(parameters).cast();
            let code = unsafe {
                PowerRegisterSuspendResumeNotification(
                    DEVICE_NOTIFY_CALLBACK,
                    recipient,
                    &mut registration,
                )
            };
            if code != ERROR_SUCCESS {
                let error = io::Error::from_raw_os_error(code as i32);
                return Err(format!("PowerRegisterSuspendResumeNotification failed: {error}"));
            }
            self.wake = Some(wake);
            self.registration = Some(registration as HPOWERNOTIFY);
            Ok(json!({
                "via": "PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK)",
                "registered": !registration.is_null(),
                "resumesOn": "PBT_APMRESUMEAUTOMATIC",
            }))
        }

        fn simulate_wake(&mut self) -> Result<Vec<&'static str>, String> {
            let wake = self.wake.ok_or("no resume listener")?;
            let context = ptr::from_ref(wake).cast();
            let broadcasts = [
                ("PBT_APMSUSPEND", PBT_APMSUSPEND),
                ("PBT_APMRESUMEAUTOMATIC", PBT_APMRESUMEAUTOMATIC),
                ("PBT_APMRESUMESUSPEND", PBT_APMRESUMESUSPEND),
            ];
            for (_, event) in broadcasts {
                // SAFETY: the callback and context listen() registered, called as the system does.
                unsafe { on_broadcast(context, event, ptr::null()) };
            }
            Ok(broadcasts.map(|(name, _)| name).to_vec())
        }

        fn observe(&self) -> Value {
            let mut state = 0u32;
            let output = (&raw mut state).cast();
            let size = size_of::<u32>() as u32;
            let status = unsafe {
                CallNtPowerInformation(SystemExecutionState, ptr::null(), 0, output, size)
            };
            if status != 0 {
                return json!({ "error": format!("CallNtPowerInformation: 0x{status:08x}") });
            }
            json!({
                "systemExecutionState": state,
                "systemRequired": state & ES_SYSTEM_REQUIRED != 0,
            })
        }
    }

    impl Drop for Native {
        fn drop(&mut self) {
            let _ = self.release();
            if let Some(registration) = self.registration.take() {
                unsafe { PowerUnregisterSuspendResumeNotification(registration) };
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    use std::ffi::c_void;
    use std::ptr::{self, NonNull};

    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;
    use serde_json::{Value, json};

    use super::{HOLDER, Layer, REASON, Wake};

    type CFStringRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    const LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> CFStringRef;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: CFStringRef,
            level: u32,
            name: CFStringRef,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    /// A CFString, released on drop.
    struct CfString(CFStringRef);

    impl CfString {
        fn new(text: &str) -> Result<CfString, String> {
            let length = text.len() as isize;
            let value =
                unsafe { CFStringCreateWithBytes(ptr::null(), text.as_ptr(), length, UTF8, 0) };
            if value.is_null() {
                return Err(format!("CFStringCreateWithBytes failed for {text:?}"));
            }
            Ok(CfString(value))
        }
    }

    impl Drop for CfString {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    #[derive(Default)]
    pub struct Native {
        assertion: Option<u32>,
        listening: bool,
    }

    impl Layer for Native {
        fn method(&self) -> &'static str {
            "IOPMAssertionCreateWithName(PreventUserIdleSystemSleep)"
        }

        fn hold(&mut self) -> Result<(), String> {
            let kind = CfString::new("PreventUserIdleSystemSleep")?;
            let name = CfString::new(&format!("{HOLDER}: {REASON}"))?;
            let mut id = 0;
            let code = unsafe { IOPMAssertionCreateWithName(kind.0, LEVEL_ON, name.0, &mut id) };
            if code != 0 {
                return Err(format!("IOPMAssertionCreateWithName returned 0x{code:08x}"));
            }
            self.assertion = Some(id);
            Ok(())
        }

        fn release(&mut self) -> Result<(), String> {
            let Some(id) = self.assertion.take() else {
                return Ok(());
            };
            match unsafe { IOPMAssertionRelease(id) } {
                0 => Ok(()),
                code => Err(format!("IOPMAssertionRelease returned 0x{code:08x}")),
            }
        }

        fn listen(&mut self, wake: Wake) -> Result<Value, String> {
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                wake("NSWorkspaceDidWakeNotification");
            });
            // SAFETY: AppKit's own name, with no object and no queue, so the block runs on the
            // posting thread; the center keeps its own copy of the block.
            let observer = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidWakeNotification),
                    None,
                    None,
                    &block,
                )
            };
            // The observer stays registered for as long as the app runs.
            std::mem::forget(observer);
            self.listening = true;
            Ok(json!({
                "via": "NSWorkspace notificationCenter, NSWorkspaceDidWakeNotification",
                "registered": true,
                "resumesOn": "NSWorkspaceDidWakeNotification",
            }))
        }

        fn simulate_wake(&mut self) -> Result<Vec<&'static str>, String> {
            if !self.listening {
                return Err("no resume listener".into());
            }
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            // SAFETY: AppKit's own name, posted with no object, as NSWorkspace posts it.
            unsafe { center.postNotificationName_object(NSWorkspaceDidWakeNotification, None) };
            Ok(vec!["NSWorkspaceDidWakeNotification"])
        }
    }

    impl Drop for Native {
        fn drop(&mut self) {
            let _ = self.release();
        }
    }
}

#[cfg(target_os = "linux")]
mod os {
    use std::os::fd::OwnedFd;
    use std::thread;

    use serde_json::{Value, json};
    use zbus::blocking::{Connection, Proxy};

    use super::{HOLDER, Layer, REASON, Wake, resumed_by_logind};

    fn manager() -> zbus::Result<Proxy<'static>> {
        let path = "/org/freedesktop/login1";
        let interface = "org.freedesktop.login1.Manager";
        Proxy::new(&Connection::system()?, "org.freedesktop.login1", path, interface)
    }

    fn text(error: zbus::Error) -> String {
        error.to_string()
    }

    #[derive(Default)]
    pub struct Native {
        /// logind holds the inhibitor until every copy of this descriptor is closed.
        inhibitor: Option<OwnedFd>,
        wake: Option<Wake>,
    }

    impl Layer for Native {
        fn method(&self) -> &'static str {
            "logind Inhibit(idle, block)"
        }

        fn hold(&mut self) -> Result<(), String> {
            let body = ("idle", HOLDER, REASON, "block");
            let fd: zbus::zvariant::OwnedFd =
                manager().and_then(|manager| manager.call("Inhibit", &body)).map_err(text)?;
            self.inhibitor = Some(fd.into());
            Ok(())
        }

        fn release(&mut self) -> Result<(), String> {
            self.inhibitor = None;
            Ok(())
        }

        fn listen(&mut self, wake: Wake) -> Result<Value, String> {
            let manager = manager().map_err(text)?;
            let preparing: bool = manager.get_property("PreparingForSleep").map_err(text)?;
            let signals = manager.receive_signal("PrepareForSleep").map_err(text)?;
            let delivered = wake.clone();
            let thread = thread::Builder::new().name("logind-sleep".into());
            let spawned = thread.spawn(move || {
                for message in signals {
                    let start = message.body().deserialize::<bool>().ok();
                    if let Some(via) = start.and_then(resumed_by_logind) {
                        delivered(via);
                    }
                }
            });
            spawned.map_err(|error| error.to_string())?;
            self.wake = Some(wake);
            Ok(json!({
                "via": "logind PrepareForSleep signal (org.freedesktop.login1.Manager)",
                "registered": true,
                "resumesOn": "PrepareForSleep(false)",
                "preparingForSleep": preparing,
            }))
        }

        fn simulate_wake(&mut self) -> Result<Vec<&'static str>, String> {
            let wake = self.wake.as_ref().ok_or("no resume listener")?;
            for start in [true, false] {
                if let Some(via) = resumed_by_logind(start) {
                    wake(via);
                }
            }
            Ok(vec!["PrepareForSleep(true)", "PrepareForSleep(false)"])
        }
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod os {
    use serde_json::Value;

    use super::{Layer, Wake};

    #[derive(Default)]
    pub struct Native;

    impl Layer for Native {
        fn method(&self) -> &'static str {
            "none"
        }

        fn hold(&mut self) -> Result<(), String> {
            Err("keep-awake isn't implemented on this OS".into())
        }

        fn release(&mut self) -> Result<(), String> {
            Ok(())
        }

        fn listen(&mut self, _wake: Wake) -> Result<Value, String> {
            Err("resume notifications aren't implemented on this OS".into())
        }

        fn simulate_wake(&mut self) -> Result<Vec<&'static str>, String> {
            Err("no resume listener".into())
        }
    }
}
