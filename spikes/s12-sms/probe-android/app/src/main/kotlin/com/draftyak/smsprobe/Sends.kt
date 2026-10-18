package com.draftyak.smsprobe

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.provider.Telephony

const val MAX_SENDS = 20
const val ACTION_SENT = "com.draftyak.smsprobe.SENT"
const val ACTION_DELIVERED = "com.draftyak.smsprobe.DELIVERED"
private const val MAX_PARTS = 16

enum class SendOutcome { SENT, REFUSED, LIMIT }

// Each send vector in one sendMultipartTextMessage call, only to the owner-entered second number
// (checked here); at most MAX_SENDS per install, counted before each send under one lock.
class SendProbe(private val store: Store, private val sms: SmsApi) {
    fun send(second: SecondNumber?, to: String, vector: SegmentVector, now: Long): SendOutcome =
        synchronized(SendProbe::class.java) {
            require(vector.send && vector.body.startsWith(DytestBody.PREFIX)) { "not a send" }
            if (second == null || !second.matches(to)) {
                store["send.refused"] = "${store.int("send.refused") + 1}"
                return SendOutcome.REFUSED
            }
            val n = store.int("send.count")
            if (n >= MAX_SENDS) return SendOutcome.LIMIT
            val parts = sms.divideMessage(vector.body)
            val ucs2 = sms.calculateLength(vector.body)[3] == 3
            val encoding = if (ucs2) SmsEncoding.UCS2 else SmsEncoding.GSM7
            store["send.count"] = "${n + 1}"
            store["send.$n"] = "${vector.id.name},$now,${parts.size},${encoding.name}"
            sms.sendMultipart(second.number, parts, n)
            SendOutcome.SENT
        }

    // One send at a time: before the next, every part's sent result (at most 60 s), then 3 s, so
    // Android has written the sent row, which it does once the last part is sent.
    fun settle(send: Int, sleep: (Long) -> Unit, elapsed: () -> Long) {
        val until = elapsed() + 60_000
        while (!SendLog.sent(store, send) && elapsed() < until) sleep(250)
        sleep(3_000)
    }

    // Stops at the first refusal or the limit.
    fun sendAll(
        second: SecondNumber?,
        to: String,
        vectors: List<SegmentVector>,
        clock: () -> Long,
        settle: (Int) -> Unit = {},
    ): List<SendOutcome> = buildList {
        for (vector in vectors.filter { it.send }) {
            if (isNotEmpty()) settle(store.int("send.count") - 1)
            add(send(second, to, vector, clock()))
            if (last() != SendOutcome.SENT) break
        }
    }
}

// Explicit (ProbeReceiver), immutable sent and delivered intents, one per part, and their results.
object SendLog {
    fun intent(context: Context, action: String, send: Int, part: Int): PendingIntent {
        val intent = Intent(context, ProbeReceiver::class.java).setAction(action)
            .putExtra("send", send).putExtra("part", part)
        val code = (send * 2 + if (action == ACTION_SENT) 0 else 1) * MAX_PARTS + part
        return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_IMMUTABLE)
    }

    // A part's sent result code, or its delivery report's arrival, as ms after the send started.
    fun record(store: Store, action: String?, send: Int, part: Int, code: Int, now: Long): Boolean {
        if (send !in 0 until MAX_SENDS || part !in 0 until MAX_PARTS) return false
        val start = store["send.$send"]?.split(',')?.getOrNull(1)?.toLongOrNull() ?: return false
        val ms = (now - start).coerceAtLeast(0)
        when (action) {
            ACTION_SENT -> store["send.$send.sent.$part"] = "$code,$ms"
            ACTION_DELIVERED -> store["send.$send.delivered.$part"] = "$ms"
            else -> return false
        }
        return true
    }

    fun record(store: Store, intent: Intent, code: Int): Boolean = record(
        store, intent.action, intent.getIntExtra("send", -1), intent.getIntExtra("part", -1), code,
        System.currentTimeMillis(),
    )

    // True once every part of the send has its sent result.
    fun sent(store: Store, send: Int): Boolean {
        val parts = store["send.$send"]?.split(',')?.getOrNull(2)?.toIntOrNull() ?: return true
        return (0 until parts).all { store["send.$send.sent.$it"] != null }
    }
}

// A provider row that isn't inbound, whose address is the second number.
class SentRow(val date: Long, val body: String, val status: Int)

// Only rows stored with the destination the send probe passed, which Android keeps as given.
fun sentRows(context: Context, second: SecondNumber?, store: Store): List<SentRow> {
    val first = store["send.0"]?.split(',')?.getOrNull(1) ?: return emptyList()
    second ?: return emptyList()
    val columns = arrayOf("address", "body", "date", "status")
    val where = "type != 1 AND date >= ? AND address = ?"
    return context.contentResolver.query(
        Telephony.Sms.CONTENT_URI, columns, where, arrayOf(first, second.number), null,
    )?.use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                if (!second.matches(cursor.getString(0).orEmpty())) continue
                add(SentRow(cursor.getLong(2), cursor.getString(1).orEmpty(), cursor.getInt(3)))
            }
        }
    }.orEmpty()
}

// Immutable delivered intents can't carry the status report, so a part whose report arrived takes
// the status the reports wrote to the sent row.
private fun delivery(arrived: Long?, status: Int?): DeliveryResult = when {
    arrived == null -> DeliveryResult.NONE
    status == Telephony.TextBasedSmsColumns.STATUS_COMPLETE -> DeliveryResult.DELIVERED
    status != null && status >= Telephony.TextBasedSmsColumns.STATUS_FAILED -> DeliveryResult.FAILED
    else -> DeliveryResult.PENDING
}

// A send's rows date from its start: its whole text until the same vector's next send, and one of
// its parts until the next send (two vectors share a first part). "Sent row once": sentRows 1 and
// sentRowBodyEqual.
fun sendsOf(store: Store, vectors: List<SegmentVector>, sms: SmsApi, rows: List<SentRow>): Sends? {
    val count = store.int("send.count").coerceAtMost(MAX_SENDS)
    val refused = store.int("send.refused")
    if (count == 0 && refused == 0) return null
    val log = (0 until count).map { store["send.$it"].orEmpty().split(',') }
    val results = log.mapIndexedNotNull { n, entry ->
        val vector = vectors.firstOrNull { it.id.name == entry[0] } ?: return@mapIndexedNotNull null
        val start = entry[1].toLong()
        val later = log.drop(n + 1)
        val next = later.firstOrNull()?.get(1)?.toLong() ?: Long.MAX_VALUE
        val nextSame = later.firstOrNull { it[0] == entry[0] }?.get(1)?.toLong() ?: Long.MAX_VALUE
        val parts = sms.divideMessage(vector.body)
        val text = parts.joinToString("")
        val mine = rows.filter {
            it.date >= start &&
                (it.body == text && it.date < nextSame || it.body in parts && it.date < next)
        }
        val partCount = entry[2].toInt().coerceAtMost(MAX_PARTS)
        val sent = (0 until partCount).mapNotNull { store["send.$n.sent.$it"]?.split(',') }
        val delivered = (0 until partCount).map { store["send.$n.delivered.$it"]?.toLongOrNull() }
        val status = mine.firstOrNull { it.body == text }?.status
        val deliveries = delivered.map { delivery(it, status) }
        SendResult(
            id = vector.id,
            partsSent = sent.count { it[0] == "-1" },
            encoding = SmsEncoding.valueOf(entry[3]),
            partsDelivered = deliveries.count { it == DeliveryResult.DELIVERED },
            sentResults = sent.map { it[0].toInt() },
            deliveryResults = deliveries,
            sentRows = mine.size,
            sentRowBodyEqual = mine.any { it.body == vector.body },
            lastSentMs = sent.maxOfOrNull { it[1].toLong() },
            lastDeliveredMs = delivered.filterNotNull().maxOrNull(),
        )
    }
    return Sends(count, results, refused)
}
