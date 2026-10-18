package com.draftyak.smsprobe

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Telephony
import kotlin.math.abs

// Not exported: the system's BOOT_COMPLETED and the probe's own sent, delivered and timer intents.
class ProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val store = probeStore(context)
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> if (store["bg.on"] == "1") {
                runCatching { ProbeService.start(context, StartCause.BOOT) }.onFailure {
                    val exempt = Timers.exempt(context)
                    BackgroundLog(store).started(StartCause.BOOT, false, exempt, null, 0, 0)
                }
            }
            ACTION_SENT, ACTION_DELIVERED -> if (SendLog.record(store, intent, resultCode)) {
                val sent = intent.action == ACTION_SENT
                ProbeLog.log(if (sent) ProbeEvent.PART_SENT else ProbeEvent.PART_DELIVERED)
            }
            ACTION_TIMER -> Timers.fired(context, store)
        }
    }
}

// The OTP probe: how long after an OTP-shaped DYTEST- text from the second number reached the phone
// its SMS_RECEIVED broadcast came (Android 17 holds OTP texts back about 3 hours), and which such
// texts' broadcasts haven't come. No text is kept.
object OtpProbe {
    const val DELAYED_MS = 600_000L
    const val SKEW_MS = 120_000L
    private val CODE = Regex("(?<![0-9])[0-9]{4,8}(?![0-9])")

    fun shaped(body: String) = body.startsWith(DytestBody.PREFIX) && CODE.containsMatchIn(body)

    // The text, read only when the sender is the second number, if it's OTP-shaped.
    fun body(second: SecondNumber?, address: String?, read: () -> String): String? =
        if (second == null || address == null || !second.matches(address)) null
        else read().takeIf(::shaped)

    // When the text reached the phone: the stored row's date nearest the SMSC's timestamp, at most
    // SKEW_MS before it and not used for an earlier sample, else the SMSC's timestamp.
    fun arrival(rows: List<Long>, smsc: Long, used: List<Long>): Long =
        rows.filter { it >= smsc - SKEW_MS && it !in used }.minByOrNull { abs(it - smsc) } ?: smsc

    fun arrivals(store: Store) = store.list("otp").map { it.substringAfter(',').toLong() }

    fun record(store: Store, arrived: Long, now: Long) =
        store.append("otp", "${(now - arrived).coerceAtLeast(0)},$arrived", 16)

    // The broadcasts' delays, then the stored texts (row dates) with no broadcast: delivered no.
    fun report(store: Store, rows: List<Long>, now: Long): Otp? {
        val webOtp = store["webotp"]?.let(WebOtp::valueOf) ?: WebOtp.NOT_TESTED
        val delays = store.list("otp").map { it.substringBefore(',').toLong() }
        val arrived = arrivals(store)
        val waiting = rows.filter { row -> arrived.none { abs(it - row) <= SKEW_MS } }
        val samples = delays.map { OtpSample(true, it, it >= DELAYED_MS, webOtp) } +
            waiting.map { OtpSample(false, delayed = now - it >= DELAYED_MS) }
        return samples.takeIf { it.isNotEmpty() }?.let(::Otp)
    }
}

// Exported only to the system's SMS broadcast (BROADCAST_SMS); other senders' texts are dropped
// before their text is read.
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val store = probeStore(context)
        val second = SecondNumber.of(store[SECOND_NUMBER] ?: return) ?: return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent)?.toList().orEmpty()
        val body = OtpProbe.body(second, parts.firstOrNull()?.originatingAddress) {
            parts.joinToString("") { it.messageBody.orEmpty() }
        } ?: return
        val now = System.currentTimeMillis()
        val rows = inbox(context, second, "body = ?", arrayOf(body)).map { it.first }
        val arrived = OtpProbe.arrival(rows, parts[0].timestampMillis, OtpProbe.arrivals(store))
        OtpProbe.record(store, arrived, now)
        ProbeLog.log(ProbeEvent.OTP_SAMPLE, ProbeCount.SECONDS to ((now - arrived) / 1_000).toInt())
    }
}

// The dates and bodies of inbox rows matching the selection; a body is read only once the row's
// address is the second number.
private fun inbox(context: Context, second: SecondNumber, where: String, args: Array<String>?) =
    runCatching {
        val columns = arrayOf("address", "date", "body")
        val uri = Telephony.Sms.Inbox.CONTENT_URI
        context.contentResolver.query(uri, columns, where, args, null)?.use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    if (!second.matches(cursor.getString(0).orEmpty())) continue
                    add(cursor.getLong(1) to cursor.getString(2).orEmpty())
                }
            }
        }
    }.getOrNull().orEmpty()

// The dates of OTP-shaped DYTEST- texts from the second number since the probe was installed.
fun otpRows(context: Context, second: SecondNumber?): List<Long> {
    second ?: return emptyList()
    val flags = PackageManager.PackageInfoFlags.of(0)
    val since = context.packageManager.getPackageInfo(context.packageName, flags).firstInstallTime
    val rows = inbox(context, second, "${dytest("body")} AND date >= ?", arrayOf("$since"))
    return rows.filter { OtpProbe.shaped(it.second) }.map { it.first }
}
