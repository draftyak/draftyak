package com.draftyak.smsprobe

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Telephony
import android.text.InputType
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

private const val PREFS = "probe"
private const val SECOND_NUMBER = "second-number"
private const val MESSAGES_PACKAGE = "com.google.android.apps.messaging"

// The skeleton's screen: the owner enters the second number, which stays in app-private storage,
// and writes a report with the device section. M0.37b adds the probes and their buttons.
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val status = TextView(this)
        val number = EditText(this).apply {
            hint = "Second number, as +<country code><number>"
            inputType = InputType.TYPE_CLASS_PHONE
            setText(prefs.getString(SECOND_NUMBER, ""))
        }
        val save = Button(this).apply { text = "Save second number" }
        save.setOnClickListener {
            val entered = number.text.toString()
            val valid = SecondNumber.of(entered) != null
            if (valid) prefs.edit().putString(SECOND_NUMBER, entered).apply()
            status.text = if (valid) "Saved." else "Enter 7 to 15 digits, optionally after a +."
            ProbeLog.log(
                if (valid) ProbeEvent.SECOND_NUMBER_SAVED else ProbeEvent.SECOND_NUMBER_REFUSED,
            )
        }
        val write = Button(this).apply { text = "Write report" }
        write.setOnClickListener { status.text = writeReport() }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            listOf(number, save, write, status).forEach(::addView)
        }
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            view.setPadding(bars.left + 32, bars.top + 32, bars.right + 32, bars.bottom + 32)
            insets
        }
        setContentView(root)
    }

    private fun writeReport(): String {
        val device = readDevice(this)
        val createdAt = UtcTime.of(System.currentTimeMillis())
        if (device == null || createdAt == null) {
            ProbeLog.log(ProbeEvent.REPORT_NOT_WRITTEN)
            return "Not written: the Android version or the clock isn't in the schema's range."
        }
        val report = Report(ProbeVersion.CURRENT, createdAt, device)
        val bytes = runCatching { ReportStore.write(filesDir, report) }.getOrElse {
            ProbeLog.log(ProbeEvent.REPORT_NOT_WRITTEN)
            return "Not written: ${it.javaClass.simpleName}."
        }
        ProbeLog.log(ProbeEvent.REPORT_WRITTEN, ProbeCount.BYTES to bytes)
        return "Wrote files/${ReportStore.FILE_NAME} ($bytes bytes)."
    }
}

// The device section from public APIs; a value outside the schema's shape is left out. M0.37b adds
// smsFormat, simSlots and activeSubscriptions, and decides oemVersion (no public API gives it).
internal fun readDevice(context: Context): Device? {
    val messages = runCatching {
        context.packageManager
            .getPackageInfo(MESSAGES_PACKAGE, PackageManager.PackageInfoFlags.of(0)).versionName
    }.getOrNull()
    return Device(
        manufacturer = Manufacturer.of(Build.MANUFACTURER),
        androidVersion = ShortVersion.of(Build.VERSION.RELEASE) ?: return null,
        sdkLevel = Build.VERSION.SDK_INT,
        securityPatchVersion = DateVersion.of(Build.VERSION.SECURITY_PATCH),
        buildVersion = BuildVersion.of(Build.ID),
        messagesVersion = MessagesVersion.fromVersionName(messages),
        messagesIsDefault = Telephony.Sms.getDefaultSmsPackage(context) == MESSAGES_PACKAGE,
    )
}
