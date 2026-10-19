package com.draftyak.smsprobe

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.Telephony

const val WINDOW_DAYS = 90
private const val TRANSACTION_ID = "tr_id"
private const val CONTENT_TYPE = "ct_t"

// An SMS or MMS-table row without address or text; markers are the columns marking it as RCS.
class MessageRow(
    val id: Long,
    val thread: Long,
    val table: ProviderTable,
    val box: Int,
    val time: Long,
    val markers: Set<String> = emptySet(),
)

// RCS markers: tr_id starting "proto:", a ct_t that isn't an MMS multipart type, or a non-empty,
// non-zero value in a column whose name contains "rcs".
fun marks(column: String, value: String?): Boolean = when (column) {
    TRANSACTION_ID -> value?.startsWith("proto:") == true
    CONTENT_TYPE -> !value.isNullOrEmpty() && !value.startsWith("application/vnd.wap.multipart")
    else -> !value.isNullOrEmpty() && value != "0"
}

// The first marker kind found on any row identifies RCS: tr_id, then ct_t, then rcs columns.
fun rcsRule(rows: List<MessageRow>): Pair<RcsIdMethod, Set<String>> {
    val marked = rows.flatMapTo(mutableSetOf()) { it.markers }
    return when {
        TRANSACTION_ID in marked -> RcsIdMethod.MMS_TRANSACTION_ID to setOf(TRANSACTION_ID)
        CONTENT_TYPE in marked -> RcsIdMethod.MMS_CONTENT_TYPE to setOf(CONTENT_TYPE)
        marked.isNotEmpty() -> RcsIdMethod.COLUMN to marked
        else -> RcsIdMethod.NONE to emptySet()
    }
}

fun MessageRow.transport(rule: Set<String>): Transport = when {
    markers.any(rule::contains) -> Transport.RCS
    table == ProviderTable.SMS -> Transport.SMS
    else -> Transport.MMS
}

// SMS type or MMS msg_box: 1 inbox; 2 sent, 4 outbox, 5 failed, 6 queued; other boxes (drafts).
fun direction(box: Int): Direction? = when (box) {
    1 -> Direction.INBOUND
    2, 4, 5, 6 -> Direction.OUTBOUND
    else -> null
}

fun messageCounts(rows: List<MessageRow>, rule: Set<String>, groups: Set<Long>): Messages {
    fun count(transport: Transport, group: Boolean?): Directions {
        val boxes = rows.filter { it.transport(rule) == transport }
            .filter { group == null || (it.thread in groups) == group }.map { direction(it.box) }
        return Directions(
            boxes.count { it == Direction.INBOUND }, boxes.count { it == Direction.OUTBOUND },
            boxes.count { it == null },
        )
    }
    return Messages(
        count(Transport.SMS, null), count(Transport.MMS, false), count(Transport.MMS, true),
        count(Transport.RCS, false), count(Transport.RCS, true),
    )
}

// Threads with a message in the last WINDOW_DAYS days by the transports seen in them.
fun threadMix(rows: List<MessageRow>, rule: Set<String>, groups: Set<Long>, now: Long): ThreadMix {
    val threads = rows.filter { it.time >= now - WINDOW_DAYS * 86_400_000L }.groupBy { it.thread }
        .mapValues { (_, list) -> list.mapTo(mutableSetOf()) { it.transport(rule) } }
    fun only(vararg transports: Transport) = threads.values.count { it == transports.toSet() }
    val (sms, mms, rcs) = Triple(Transport.SMS, Transport.MMS, Transport.RCS)
    return ThreadMix(
        WINDOW_DAYS, threads.size, threads.keys.count(groups::contains), only(sms), only(mms),
        only(rcs), only(sms, mms), only(sms, rcs), only(mms, rcs), only(sms, mms, rcs),
    )
}

fun rcsSection(rows: List<MessageRow>, method: RcsIdMethod, rule: Set<String>): Rcs {
    val rcs = rows.filter { it.transport(rule) == Transport.RCS }
    val outgoing = when {
        rcs.any { direction(it.box) == Direction.OUTBOUND } -> Tri.YES
        rcs.isNotEmpty() -> Tri.NO
        else -> Tri.UNKNOWN
    }
    return Rcs(method, ColumnName.list(rule.toTypedArray()), outgoing)
}

class InventoryResult(
    val inventory: Inventory,
    val threadMix: ThreadMix?,
    val testMessages: List<TestMessage>,
)

// A case-sensitive DYTEST- prefix test for a provider column (SQLite's LIKE ignores case).
fun dytest(column: String) = "$column GLOB '${DytestBody.PREFIX}*'"

// The probe's own sends aren't test messages: a row holding one of their texts, whole or a part,
// stored in that send's time range. Any other text is one, even when it starts like them.
fun ownSend(body: String, date: Long, sends: List<OwnSend>) =
    sends.any { date in it.dates && body in it.bodies }

// The report's 40 test messages: MMS and RCS rows first, keeping at least 20 when there are more
// SMS rows, so SMS rows can't push out the RCS markers.
fun testMessageOrder(sms: List<TestMessage>, mms: List<TestMessage>): List<TestMessage> {
    val kept = mms.take(maxOf(20, 40 - sms.size))
    return kept + sms.take(40 - kept.size)
}

// What READ_SMS sees, counted on the phone. Column names come only from Cursor.getColumnNames() of
// queries that match no row, and counts from _id alone; only DYTEST- rows are read with their text,
// and only TestMessage.of keeps one. `sends` are the texts the send probe sent (ownSends).
class InventoryReader(
    context: Context,
    private val second: SecondNumber?,
    private val sends: List<OwnSend>,
) {
    private val resolver = context.contentResolver

    private fun <T> query(uri: Uri, columns: Array<String>?, where: String?, read: (Cursor) -> T) =
        runCatching { resolver.query(uri, columns, where, null, null)?.use(read) }.getOrNull()

    private fun provider(table: ProviderTable, uri: Uri, rows: Boolean = true) = runCatching {
        resolver.query(uri, null, "0 = 1", null, null)?.use {
            val count = if (rows) query(uri, arrayOf("_id"), null, Cursor::getCount) else null
            Provider(table, true, rows = count, columns = ColumnName.list(it.columnNames))
        } ?: Provider(table, false, ProviderFailure.NOT_FOUND)
    }.getOrElse {
        val security = it is SecurityException
        Provider(table, false, if (security) ProviderFailure.SECURITY else ProviderFailure.OTHER)
    }

    private fun rows(table: ProviderTable, provider: Provider): List<MessageRow> {
        val sms = table == ProviderTable.SMS
        val markers = provider.columns.orEmpty().map { it.text }
            .filter { it == TRANSACTION_ID || it == CONTENT_TYPE || "rcs" in it }
        val columns = arrayOf("_id", "thread_id", if (sms) "type" else "msg_box", "date") + markers
        val uri = if (sms) Telephony.Sms.CONTENT_URI else Telephony.Mms.CONTENT_URI
        return query(uri, columns, null) { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val marked = markers.filterIndexedTo(mutableSetOf()) { i, column ->
                        marks(column, cursor.getString(4 + i))
                    }
                    // MMS dates are seconds.
                    val time = cursor.getLong(3) * if (sms) 1 else 1_000
                    val (id, thread) = cursor.getLong(0) to cursor.getLong(1)
                    add(MessageRow(id, thread, table, cursor.getInt(2), time, marked))
                }
            }
        }.orEmpty()
    }

    private fun groups() = query(THREADS, arrayOf("_id", "recipient_ids"), null) { cursor ->
        buildSet {
            while (cursor.moveToNext()) {
                val recipients = cursor.getString(1).orEmpty().split(' ').count(String::isNotBlank)
                if (recipients > 1) add(cursor.getLong(0))
            }
        }
    }.orEmpty()

    // canonical-addresses returns addresses whatever the projection, so its rows aren't counted.
    fun read(now: Long): InventoryResult {
        val providers = listOf(
            ProviderTable.SMS to Telephony.Sms.CONTENT_URI,
            ProviderTable.MMS to Telephony.Mms.CONTENT_URI,
            ProviderTable.MMS_PART to Telephony.Mms.Part.CONTENT_URI,
            ProviderTable.THREADS to THREADS,
            ProviderTable.CONVERSATIONS to Telephony.MmsSms.CONTENT_CONVERSATIONS_URI,
            ProviderTable.COMPLETE_CONVERSATIONS to Uri.parse("$MMS_SMS/complete-conversations"),
            ProviderTable.CANONICAL_ADDRESSES to Uri.parse("$MMS_SMS/canonical-addresses"),
        ).map { (table, uri) -> provider(table, uri, table != ProviderTable.CANONICAL_ADDRESSES) }
        val (sms, mms) = providers
        val rows = rows(ProviderTable.SMS, sms) + rows(ProviderTable.MMS, mms)
        // mms/<id>/addr is per message: its columns, without a table-wide row count.
        val addr = rows.firstOrNull { it.table == ProviderTable.MMS }
            ?.let { provider(ProviderTable.MMS_ADDR, addrUri(it.id), rows = false) }
        val (method, rule) = rcsRule(rows)
        val readable = sms.readable && mms.readable
        val groups = if (readable) groups() else emptySet()
        val messages = messageCounts(rows, rule, groups).takeIf { readable }
        val rcs = if (mms.readable) rcsSection(rows, method, rule) else Rcs(RcsIdMethod.UNKNOWN)
        return InventoryResult(
            Inventory(providers + listOfNotNull(addr), messages, rcs),
            threadMix(rows, rule, groups, now).takeIf { readable },
            testMessages(rows, rule),
        )
    }

    // DYTEST- SMS bodies, and MMS-table text parts with the sender of an inbound message or the
    // only recipient of an outbound one, whose address is the second number.
    private fun testMessages(rows: List<MessageRow>, rule: Set<String>): List<TestMessage> {
        second ?: return emptyList()
        val columns = arrayOf("address", "body", "type", "date")
        val sms = query(Telephony.Sms.CONTENT_URI, columns, dytest("body")) { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val direction = direction(cursor.getInt(2)) ?: continue
                    val body = cursor.getString(1).orEmpty()
                    if (ownSend(body, cursor.getLong(3), sends)) continue
                    val message = TestMessage.of(
                        second, cursor.getString(0).orEmpty(), body, Transport.SMS, direction,
                        ProviderTable.SMS,
                    )
                    message?.let(::add)
                }
            }
        }.orEmpty()
        val byId = rows.filter { it.table == ProviderTable.MMS }.associateBy { it.id }
        val where = "ct = 'text/plain' AND ${dytest("text")}"
        val mms = query(Telephony.Mms.Part.CONTENT_URI, arrayOf("mid", "text"), where) { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val row = byId[cursor.getLong(0)] ?: continue
                    val direction = direction(row.box) ?: continue
                    val address = mmsAddress(row.id, direction) ?: continue
                    val markers = ColumnName.list(row.markers.filter(rule::contains).toTypedArray())
                    val body = cursor.getString(1).orEmpty()
                    val message = TestMessage.of(
                        second, address, body, row.transport(rule), direction, ProviderTable.MMS,
                        markers.ifEmpty { null },
                    )
                    message?.let(::add)
                }
            }
        }.orEmpty()
        return testMessageOrder(sms, mms)
    }

    // PDU address types: 137 from; 151 to, 130 cc, 129 bcc.
    private fun mmsAddress(id: Long, direction: Direction): String? {
        val types = if (direction == Direction.INBOUND) setOf(137) else setOf(151, 130, 129)
        return query(addrUri(id), arrayOf("address", "type"), null) { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    if (cursor.getInt(1) in types) add(cursor.getString(0).orEmpty())
                }
            }
        }?.singleOrNull()
    }

    private companion object {
        const val MMS_SMS = "content://mms-sms"
        val THREADS: Uri = Uri.parse("$MMS_SMS/conversations?simple=true")
        fun addrUri(id: Long): Uri = Telephony.Mms.Addr.getAddrUriForMessage("$id")
    }
}
