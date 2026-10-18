package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Synthetic provider rows; thread ids are NANP fiction-range numbers, so a leak would show.
class InventoryTest {
    private val now = 1_792_252_800_000L
    private val alone = 15_555_550_123L
    private val group = 15_555_550_142L
    private val old = 15_555_550_187L
    private val rcsOnly = 15_555_550_199L
    private val sms = ProviderTable.SMS
    private val mms = ProviderTable.MMS

    private fun row(thread: Long, table: ProviderTable, box: Int, days: Long, vararg rcs: String) =
        MessageRow(thread * 10 + box, thread, table, box, now - days * 86_400_000, rcs.toSet())

    private val rows = listOf(
        row(alone, sms, 1, 1), row(alone, sms, 2, 2), row(alone, mms, 1, 3), row(alone, sms, 3, 4),
        row(group, mms, 1, 5), row(group, mms, 2, 6, "tr_id"),
        row(old, sms, 1, 91), row(old, mms, 1, 200),
        row(rcsOnly, mms, 1, 10, "tr_id", "ct_t"),
    )

    private fun directions(inbound: Long, outbound: Long, other: Long) =
        mapOf("inbound" to inbound, "outbound" to outbound, "other" to other)

    @Test
    fun `RCS rows are marked by tr_id, then ct_t, then columns named rcs`() {
        assertEquals(true, marks("tr_id", "proto:CkIKImNvbS5nb29nbGU"))
        assertEquals(false, marks("tr_id", "T18c2e4f1a3b"))
        assertEquals(false, marks("tr_id", null))
        assertEquals(true, marks("ct_t", "application/vnd.gsma.rcs-ft-http+xml"))
        assertEquals(false, marks("ct_t", "application/vnd.wap.multipart.related"))
        assertEquals(false, marks("ct_t", ""))
        assertEquals(true, marks("rcs_message_type", "1"))
        assertEquals(false, marks("rcs_message_type", "0"))
        assertEquals(RcsIdMethod.MMS_TRANSACTION_ID to setOf("tr_id"), rcsRule(rows))
        val byType = listOf(row(group, mms, 1, 1, "ct_t", "is_rcs"))
        assertEquals(RcsIdMethod.MMS_CONTENT_TYPE to setOf("ct_t"), rcsRule(byType))
        val byColumn = listOf(row(group, sms, 1, 1, "is_rcs"), row(group, mms, 1, 1, "rcs_id"))
        assertEquals(RcsIdMethod.COLUMN to setOf("is_rcs", "rcs_id"), rcsRule(byColumn))
        val unmarked = rows.filter { it.markers.isEmpty() }
        assertEquals(RcsIdMethod.NONE to emptySet<String>(), rcsRule(unmarked))
    }

    @Test
    fun `messages count by transport, direction and group thread`() {
        val (_, rule) = rcsRule(rows)
        val messages = messageCounts(rows, rule, setOf(group, rcsOnly))
        val json = Json.parse(reportWith(inventory = Inventory(emptyList(), messages))) as Map<*, *>
        assertEquals(
            mapOf(
                "sms" to directions(2, 1, 1),
                "mms" to directions(2, 0, 0),
                "mmsGroup" to directions(1, 0, 0),
                "rcs" to directions(0, 0, 0),
                "rcsGroup" to directions(1, 1, 0),
            ),
            (json["inventory"] as Map<*, *>)["messages"],
        )
        assertEquals(Direction.OUTBOUND, direction(6))
        assertEquals(null, direction(3))
    }

    @Test
    fun `the thread mix counts threads of the last 90 days by the transports in them`() {
        val (_, rule) = rcsRule(rows)
        val json = Json.parse(reportWith(threadMix = threadMix(rows, rule, setOf(group), now)))
        val counts = listOf(90L, 3L, 1L, 0L, 0L, 1L, 1L, 0L, 1L, 0L)
        val names = listOf(
            "windowDays", "threads", "groups", "smsOnly", "mmsOnly", "rcsOnly", "smsAndMms",
            "smsAndRcs", "mmsAndRcs", "allThree",
        )
        assertEquals(names.zip(counts).toMap(), (json as Map<*, *>)["threadMix"])
    }

    @Test
    fun `outgoing RCS is yes when an outbound RCS row exists, no with only inbound ones`() {
        val (method, rule) = rcsRule(rows)
        assertEquals(Tri.YES, rcsSection(rows, method, rule).outgoingWritten)
        assertEquals(Tri.NO, rcsSection(rows.filter { it.box == 1 }, method, rule).outgoingWritten)
        val none = rcsSection(rows.filter { it.markers.isEmpty() }, RcsIdMethod.NONE, emptySet())
        assertEquals(Tri.UNKNOWN, none.outgoingWritten)
    }

    @Test
    fun `DYTEST- rows are picked case-sensitively, and the probe's own send texts aren't kept`() {
        assertEquals("body GLOB 'DYTEST-*'", dytest("body"))
        val bodies = TestFiles.vectors.map { it.body }
        val phone = ReferenceSms { it.expected[0] }
        for (vector in TestFiles.vectors.filter { it.send }) {
            assertTrue(ownSend(vector.body, bodies))
            assertTrue(ownSend(phone.divideMessage(vector.body)[0], bodies))
        }
        // The UCS-2 send texts pass DytestBody, so only ownSend keeps them out of testMessages.
        val passing = TestFiles.vectors.filter { it.send && DytestBody.of(it.body) != null }
        assertEquals(5, passing.size)
        for (text in listOf("DYTEST-hello from the second number", "DYTEST-RCS test 2")) {
            assertFalse(ownSend(text, bodies))
        }
    }

    @Test
    fun `MMS and RCS test messages come first and keep at least half of the 40`() {
        fun message(transport: Transport, n: Int) = TestMessage.of(
            Reports.secondNumber, "+15555550100", "DYTEST-${transport.wire} $n", transport,
            Direction.INBOUND,
        )!!
        val sms = List(30) { message(Transport.SMS, it) }
        val rcs = List(30) { message(Transport.RCS, it) }
        fun counts(list: List<TestMessage>): List<Pair<String, Int>> {
            val names = list.map { (Json.parse(it.json()) as Map<*, *>)["transport"] as String }
            assertEquals(names.sortedBy { it == "sms" }, names)
            return names.distinct().map { name -> name to names.count { it == name } }
        }
        assertEquals(listOf("rcs" to 20, "sms" to 20), counts(testMessageOrder(sms, rcs)))
        assertEquals(listOf("rcs" to 5, "sms" to 30), counts(testMessageOrder(sms, rcs.take(5))))
        assertEquals(listOf("rcs" to 30, "sms" to 10), counts(testMessageOrder(sms.take(10), rcs)))
        assertEquals(listOf("rcs" to 40), counts(testMessageOrder(emptyList(), rcs + rcs)))
        assertEquals(listOf("sms" to 30), counts(testMessageOrder(sms, emptyList())))
    }

    @Test
    fun `an inventory from synthetic rows passes the schema and carries no thread id`() {
        val (method, rule) = rcsRule(rows)
        val groups = setOf(group)
        val inventory = Inventory(
            listOf(
                Provider(sms, true, rows = 4, columns = Reports.columns("_id", "thread_id")),
                Provider(ProviderTable.MMS_ADDR, true, columns = Reports.columns("msg_id", "type")),
                Provider(ProviderTable.CANONICAL_ADDRESSES, false, ProviderFailure.SECURITY),
            ),
            messageCounts(rows, rule, groups),
            rcsSection(rows, method, rule),
        )
        val json = reportWith(inventory = inventory, threadMix = threadMix(rows, rule, groups, now))
        assertEquals(emptyList<String>(), SchemaCheck.problems(Json.parse(json)))
        for (thread in listOf(alone, group, old, rcsOnly)) {
            assertFalse(json.contains("$thread"))
            assertFalse(json.contains("${thread * 10 + 1}"))
        }
        assertFalse(json.contains("proto:"))
    }
}
