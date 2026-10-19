package com.draftyak.smsprobe

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.text.InputType
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.atomic.AtomicBoolean

const val PREFS = "probe"
const val SECOND_NUMBER = "second-number"
private const val MESSAGES_PACKAGE = "com.google.android.apps.messaging"
private const val GRANTED = PackageManager.PERMISSION_GRANTED
private const val LOCAL_NETWORK = Manifest.permission.ACCESS_LOCAL_NETWORK
private val PERMISSIONS = arrayOf(
    Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.SEND_SMS,
    Manifest.permission.READ_PHONE_STATE, Manifest.permission.POST_NOTIFICATIONS,
)
private val sending = AtomicBoolean()

// Every probe starts from a button here; the send probe also needs the owner's confirmation.
// Intents can open this screen but start nothing; opening it restarts a background test that's on.
class MainActivity : Activity() {
    private val store by lazy { probeStore(this) }
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this)
        val number = EditText(this).apply {
            hint = "Second number, as +<country code><number>"
            inputType = InputType.TYPE_CLASS_PHONE
            setText(store[SECOND_NUMBER].orEmpty())
        }
        val save = Button(this).apply { text = "Save second number" }
        save.setOnClickListener {
            // Not while a run sends: its first send may not be counted yet.
            val saved = if (sending.get()) null else saveSecondNumber(store, number.text.toString())
            status.text = when (saved) {
                SaveOutcome.SAVED -> "Saved."
                SaveOutcome.INVALID -> "Enter 7 to 15 digits, optionally after a +."
                SaveOutcome.PINNED -> "Not saved: texts were already sent to the saved number."
                null -> "Still sending the last run."
            }
            ProbeLog.log(
                if (saved == SaveOutcome.SAVED) ProbeEvent.SECOND_NUMBER_SAVED
                else ProbeEvent.SECOND_NUMBER_REFUSED,
            )
        }
        val write = Button(this).apply { text = "Write report" }
        write.setOnClickListener { work { writeReport(buildReport(this, store)) } }
        val standin = EditText(this).apply {
            hint = "Stand-in, as ${Standin.hosts[0]}:<port>"
            setText(store["standin"].orEmpty())
        }
        fun button(label: String, action: () -> Unit) = Button(this).apply {
            text = label
            setOnClickListener { action() }
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            listOf(
                number, save, write,
                button("Send the test texts to the second number") { confirmSends(number) },
                button("Start background test") { background(true) },
                button("Stop background test") { background(false) },
                button("Doze runs: forced or natural") { toggleDoze() },
                button("Kill the probe (its service should restart)") { kill() },
                standin,
                button("TLS probe, then report to the stand-in") { tls(standin.text.toString()) },
                button("Record an install") { recordInstall() },
                button("Record WebOTP") { recordWebOtp() },
                status,
            ).forEach(::addView)
        }
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            view.setPadding(bars.left + 32, bars.top + 32, bars.right + 32, bars.bottom + 32)
            insets
        }
        setContentView(ScrollView(this).apply { addView(root) })
        val missing = PERMISSIONS.filter { checkSelfPermission(it) != GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1)
        if (store["bg.on"] == "1") runCatching { ProbeService.start(this, StartCause.UI) }
    }

    private fun work(task: () -> String) {
        status.text = "Working..."
        Thread {
            val text = runCatching(task).getOrElse { "Failed: ${it.javaClass.simpleName}." }
            runOnUiThread { status.text = text }
        }.start()
    }

    private fun writeReport(report: Report?): String {
        if (report == null) {
            ProbeLog.log(ProbeEvent.REPORT_NOT_WRITTEN)
            return "Not written: the Android version or the clock isn't in the schema's range."
        }
        val bytes = runCatching { ReportStore.write(filesDir, report) }.getOrElse {
            ProbeLog.log(ProbeEvent.REPORT_NOT_WRITTEN)
            return "Not written: ${it.javaClass.simpleName}."
        }
        ProbeLog.log(ProbeEvent.REPORT_WRITTEN, ProbeCount.BYTES to bytes)
        return "Wrote files/${ReportStore.FILE_NAME} ($bytes bytes)."
    }

    // The dialog names the saved destination (it stays on the screen); the field must agree.
    private fun confirmSends(field: EditText) {
        val second = SecondNumber.of(store[SECOND_NUMBER].orEmpty())
        if (second == null || SecondNumber.of(field.text.toString())?.number != second.number) {
            status.text = "Save the second number first: the field and the saved number differ."
            return
        }
        val sms = AndroidSms(this)
        val vectors = SegmentVectors.load(this).filter { it.send }
        val left = MAX_SENDS - store.int("send.count")
        val texts = vectors.take(left.coerceAtLeast(0))
        val parts = texts.sumOf { sms.divideMessage(it.body).size }
        AlertDialog.Builder(this).setTitle("Send ${texts.size} DYTEST- texts ($parts parts)?")
            .setMessage("Only to ${second.number}; texts may cost money. Sends left: $left.")
            .setPositiveButton("Send") { _, _ ->
                if (!sending.compareAndSet(false, true)) status.text = "Still sending the last run."
                else work { try { sendAll(sms, vectors, second) } finally { sending.set(false) } }
            }
            .setNegativeButton("Cancel", null).show()
    }

    private fun sendAll(sms: SmsApi, vectors: List<SegmentVector>, second: SecondNumber): String {
        val probe = SendProbe(store, sms)
        val clock = System::currentTimeMillis
        val outcomes = probe.sendAll(second, second.number, vectors, clock) {
            probe.settle(it, Thread::sleep, SystemClock::elapsedRealtime)
        }
        val sent = outcomes.count { it == SendOutcome.SENT }
        ProbeLog.log(ProbeEvent.SENDS_DONE, ProbeCount.SENT to sent)
        return "Sent $sent (${outcomes.lastOrNull()?.name}). Write the report once they arrive."
    }

    private fun background(on: Boolean) {
        store["bg.on"] = if (on) "1" else null
        if (on) ProbeService.start(this, StartCause.UI)
        if (!on) stopService(Intent(this, ProbeService::class.java))
        status.text = if (on) "Background test on." else "Background test off."
    }

    private fun toggleDoze() {
        store["doze"] = if (store["doze"] == "natural") null else "natural"
        status.text = "Doze runs are labelled ${store["doze"] ?: "forced"}."
    }

    // The after-kill case on demand: the process dies as when Android kills it, with no task to
    // reopen, and the sticky service's restart (or its absence) is recorded.
    private fun kill() {
        if (store["bg.on"] != "1") return run { status.text = "Start the background test first." }
        finishAndRemoveTask()
        Process.killProcess(Process.myPid())
    }

    private fun tls(standin: String) {
        val host = standin.substringBeforeLast(':')
        val port = standin.substringAfterLast(':').toIntOrNull()
        if (host !in Standin.hosts || port == null) {
            status.text = "Enter one of ${Standin.hosts}, a colon and the stand-in's port."
            return
        }
        // Only a LAN stand-in asks for ACCESS_LOCAL_NETWORK, once; later runs go ahead anyway. A
        // tailnet result counts only without the grant (plan section 7: VPN links fall outside it).
        val kind = Standin.kind(host)
        val granted = checkSelfPermission(LOCAL_NETWORK) == GRANTED
        if (kind == HostKind.LAN && !granted && store["lan.asked"] == null) {
            store["lan.asked"] = "1"
            requestPermissions(arrayOf(LOCAL_NETWORK), 2)
            return
        }
        val keep = kind == HostKind.LAN || kind == HostKind.TAILNET && !granted
        store["standin"] = standin
        work {
            var written = ""
            val probe = TlsProbe(filesDir) { if (keep) store["reach.$kind"] = it.name }
            val run = probe.run(host, port) { tls ->
                buildReport(this, store, tls)?.also { written = writeReport(it) }
            }
            // An unreached stand-in leaves the last TLS section as it was.
            val tls = run.tls?.also { TlsStore.save(store, it) }
            if (run.reportReply == null) written = writeReport(buildReport(this, store))
            ProbeLog.log(ProbeEvent.TLS_DONE, ProbeCount.ATTEMPTS to tls?.attempts.orEmpty().size)
            val summary = tls?.let { "TLS ${it.result.wire}, key ${it.keyClass?.wire}" }
            val note = if (kind == HostKind.TAILNET && granted) " Tailnet result not kept." else ""
            "${summary ?: "Stand-in not reached"}, EKM equal ${tls?.ekmEqual}, stand-in (valid, " +
                "written) ${run.reportReply}.$note $written"
        }
    }

    // Owner observations are picked from lists of the schema's values, never typed.
    private fun <E : Wire> pick(title: String, values: List<E>, then: (E) -> Unit) {
        val labels = values.map { it.wire }.toTypedArray()
        AlertDialog.Builder(this).setTitle(title)
            .setItems(labels) { _, i -> then(values[i]) }.show()
    }

    private fun recordInstall() = pick("Install path", InstallPath.entries) { path ->
        pick("Installed", listOf(Tri.YES, Tri.NO)) { installed ->
            pick("Restricted settings", RestrictedSettings.entries) { restricted ->
                pick("Play Protect", PlayProtect.entries) { protect ->
                    pick("Advanced Protection", AdvancedProtection.entries) { advanced ->
                        val item = listOf<Kebab>(path, installed, restricted, protect, advanced)
                        store.append("install", item.joinToString(",") { it.name }, 16)
                        status.text = "Install recorded."
                    }
                }
            }
        }
    }

    private fun recordWebOtp() = pick("WebOTP", listOf(WebOtp.OFFERED, WebOtp.NOT_OFFERED)) {
        store["webotp"] = it.name
        status.text = "WebOTP recorded."
    }
}

// The device section from public APIs; a value outside the schema's shape is left out. No public
// API gives the OEM version (One UI's is a system property), so oemVersion is never set.
internal fun readDevice(context: Context, sms: SmsApi): Device? {
    val messages = runCatching {
        context.packageManager
            .getPackageInfo(MESSAGES_PACKAGE, PackageManager.PackageInfoFlags.of(0)).versionName
    }.getOrNull()
    val telephony = context.getSystemService(TelephonyManager::class.java)
    val subscriptions = context.getSystemService(SubscriptionManager::class.java)
    return Device(
        manufacturer = Manufacturer.of(Build.MANUFACTURER),
        androidVersion = ShortVersion.of(Build.VERSION.RELEASE) ?: return null,
        sdkLevel = Build.VERSION.SDK_INT,
        securityPatchVersion = DateVersion.of(Build.VERSION.SECURITY_PATCH),
        buildVersion = BuildVersion.of(Build.ID),
        messagesVersion = MessagesVersion.fromVersionName(messages),
        messagesIsDefault = Telephony.Sms.getDefaultSmsPackage(context) == MESSAGES_PACKAGE,
        smsFormat = runCatching { smsFormat(sms) }.getOrNull(),
        simSlots = runCatching { telephony.activeModemCount }.getOrNull(),
        activeSubscriptions = runCatching { subscriptions.activeSubscriptionInfoCount }.getOrNull(),
    )
}

// An install the owner recorded: path, installed, restricted settings, Play Protect and Advanced
// Protection, on this phone's Android version.
fun installOf(item: String, android: ShortVersion?): Install? = runCatching {
    val (path, installed, restricted, protect, advanced) = item.split(',')
    Install(
        InstallPath.valueOf(path), installed == Tri.YES.name, android,
        RestrictedSettings.valueOf(restricted), PlayProtect.valueOf(protect),
        AdvancedProtection.valueOf(advanced),
    )
}.getOrNull()

// Every section the probe can fill; a section that fails is left out.
fun buildReport(context: Context, store: Store, tls: Tls? = TlsStore.load(store)): Report? {
    val sms = AndroidSms(context)
    val now = System.currentTimeMillis()
    val second = SecondNumber.of(store[SECOND_NUMBER].orEmpty())
    val vectors = runCatching { SegmentVectors.load(context) }.getOrNull()
    val installed = runCatching {
        val flags = PackageManager.PackageInfoFlags.of(0)
        context.packageManager.getPackageInfo(context.packageName, flags).firstInstallTime
    }.getOrDefault(0L)
    val own = runCatching { ownSends(store, vectors.orEmpty(), sms, installed) }
        .getOrDefault(emptyList())
    val inventory = runCatching { InventoryReader(context, second, own).read(now) }.getOrNull()
    val permission = when {
        context.checkSelfPermission(LOCAL_NETWORK) == GRANTED -> LocalNetworkPermission.GRANTED
        store["lan.asked"] != null -> LocalNetworkPermission.DENIED
        else -> LocalNetworkPermission.NOT_REQUESTED
    }
    fun reach(kind: HostKind) = store["reach.$kind"]?.let(Reach::valueOf) ?: Reach.NOT_TESTED
    val rows = runCatching { sentRows(context, second, store) }.getOrDefault(emptyList())
    val device = readDevice(context, sms) ?: return null
    val installs = store.list("install").mapNotNull { installOf(it, device.androidVersion) }
    return Report(
        ProbeVersion.CURRENT, UtcTime.of(now) ?: return null, device,
        inventory = inventory?.inventory,
        threadMix = inventory?.threadMix,
        vectors = runCatching { vectors?.map { runVector(it, sms) }?.let(::Vectors) }.getOrNull(),
        sends = runCatching { sendsOf(store, vectors.orEmpty(), sms, rows) }.getOrNull(),
        background = BackgroundLog(store).report(),
        tls = tls,
        network = Network(permission, reach(HostKind.LAN), reach(HostKind.TAILNET)),
        otp = runCatching { OtpProbe.report(store, otpRows(context, second), now) }.getOrNull(),
        install = installs.ifEmpty { null },
        testMessages = inventory?.testMessages,
    )
}
