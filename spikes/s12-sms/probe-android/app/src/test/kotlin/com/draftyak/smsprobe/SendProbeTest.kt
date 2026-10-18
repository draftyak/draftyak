package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap

// The probe's Store as a map several threads can share.
private class ConcurrentStore : Store {
    private val values = ConcurrentHashMap<String, String>()

    override fun get(key: String): String? = values[key]

    override fun set(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

class SendProbeTest {
    private val store = MapStore()
    private val sms = ReferenceSms { it.expected[0] }
    private val probe = SendProbe(store, sms)
    private val sendVectors = TestFiles.vectors.filter { it.send }
    private val clock = generateSequence(1_792_252_800_000L) { it + 5_000 }.iterator()
    private val start = 1_792_252_800_000L
    private val second = Reports.secondNumber

    private fun sendAll(to: String, number: SecondNumber? = second, only: Int = sendVectors.size) =
        probe.sendAll(number, to, sendVectors.take(only), clock::next)

    @Suppress("UNCHECKED_CAST")
    private fun results(rows: List<SentRow>): List<Map<String, Any?>> {
        val json = reportWith(sends = sendsOf(store, TestFiles.vectors, sms, rows))
        assertEquals(emptyList<String>(), SchemaCheck.problems(Json.parse(json)))
        val sends = (Json.parse(json) as Map<*, *>)["sends"] as Map<*, *>
        return sends["results"] as List<Map<String, Any?>>
    }

    @Test
    fun `the send probe refuses every destination but the second number and sends nothing`() {
        val corpus = listOf("numbers", "senders", "emails", "names")
            .flatMap(TestFiles::corpusStrings)
        val near = listOf("+15555550101", "5555550100", "15555550100", "+1555555010")
            .plus("+155555501000")
        val others = corpus + near + listOf("", "*#06#")
        for (to in others) assertEquals(to, listOf(SendOutcome.REFUSED), sendAll(to))
        assertEquals(listOf(SendOutcome.REFUSED), sendAll("+15555550100", number = null))
        assertEquals(emptyList<Any>(), sms.sends)
        assertNull(store["send.count"])
        assertEquals(others.size + 1, store.int("send.refused"))
        val sends = sendsOf(store, TestFiles.vectors, sms, emptyList())!!
        assertEquals(0 to emptyList<SendResult>(), sends.attempted to sends.results)
    }

    @Test
    fun `each send vector goes once, whole, to the second number's normalized form`() {
        assertEquals(List(7) { SendOutcome.SENT }, sendAll("+1 (555) 555-0100"))
        assertEquals(List(7) { "+15555550100" }, sms.sends.map { it.first })
        assertEquals(sendVectors.map { sms.divideMessage(it.body) }, sms.sends.map { it.second })
        assertEquals((0 until 7).toList(), sms.sends.map { it.third })
        assertEquals(15, sms.sends.sumOf { it.second.size })
        assertEquals("GSM7_EXT_STRADDLE,$start,2,GSM7", store["send.0"])
        assertEquals("UCS2_EMOJI_RUN,${start + 30_000},2,UCS2", store["send.6"])
    }

    @Test
    fun `the send probe stops at 20 sends per install`() {
        val runs = List(3) { sendAll("+15555550100") }
        assertEquals(List(6) { SendOutcome.SENT } + SendOutcome.LIMIT, runs[2])
        assertEquals(MAX_SENDS, sms.sends.size)
        assertEquals(MAX_SENDS, store.int("send.count"))
        val again = SendProbe(store, sms).send(second, "+15555550100", sendVectors[0], clock.next())
        assertEquals(SendOutcome.LIMIT, again)
        assertEquals(MAX_SENDS, sms.sends.size)
        assertEquals(MAX_SENDS, sendsOf(store, TestFiles.vectors, sms, emptyList())!!.attempted)
    }

    @Test
    fun `concurrent runs share the 20 sends and never reuse a send's slot`() {
        val shared = ConcurrentStore()
        // A pause between reading the count and storing the next one, where a race would show.
        val slow = object : SmsApi by sms {
            override fun divideMessage(text: String) =
                sms.divideMessage(text).also { Thread.sleep(2) }
        }
        val threads = List(4) {
            Thread {
                repeat(3) {
                    val now = System::currentTimeMillis
                    SendProbe(shared, slow).sendAll(second, "+15555550100", sendVectors, now)
                }
            }
        }
        threads.forEach(Thread::start)
        threads.forEach(Thread::join)
        assertEquals((0 until MAX_SENDS).toList(), sms.sends.map { it.third }.sorted())
        assertEquals(MAX_SENDS, shared.int("send.count"))
    }

    @Test
    fun `only vectors marked send can be sent`() {
        val single = TestFiles.vectors.first { !it.send }
        assertThrows(IllegalArgumentException::class.java) {
            probe.send(second, "+15555550100", single, clock.next())
        }
        assertEquals(emptyList<Any>(), sms.sends)
    }

    @Test
    fun `a run settles after each send but the last`() {
        val settled = mutableListOf<Int>()
        probe.sendAll(second, "+15555550100", sendVectors, clock::next) { settled += it }
        assertEquals((0..5).toList(), settled)
        store["send.count"] = "${MAX_SENDS - 1}"
        settled.clear()
        val last = probe.sendAll(second, "+15555550100", sendVectors, clock::next) { settled += it }
        assertEquals(listOf(SendOutcome.SENT, SendOutcome.LIMIT), last)
        assertEquals(listOf(MAX_SENDS - 1), settled)
    }

    @Test
    fun `settling waits for every part's sent result, at most 60 s, then 3 s more`() {
        sendAll("+15555550100", only = 2)
        var now = 0L
        val sleeps = mutableListOf<Long>()
        val sleep = { ms: Long ->
            sleeps += ms
            now += ms
            // Send 0's parts are sent after 1 s; send 1's never are.
            if (now == 1_000L) {
                for (part in 0..1) SendLog.record(store, ACTION_SENT, 0, part, -1, start + now)
            }
        }
        probe.settle(0, sleep) { now }
        assertEquals(List(4) { 250L } + 3_000L, sleeps)
        sleeps.clear()
        SendLog.record(store, ACTION_SENT, 1, 0, -1, start + 6_000)
        probe.settle(1, sleep) { now }
        assertEquals(List(240) { 250L } + 3_000L, sleeps)
        assertTrue(SendLog.sent(store, 0))
        assertFalse(SendLog.sent(store, 1))
    }

    @Test
    fun `sent and delivered intents and the sent-row check make each send's result`() {
        sendAll("+15555550100", only = 3)
        // Send 0: both parts sent and delivered, one row with the whole body.
        for (part in 0..1) {
            assertTrue(SendLog.record(store, ACTION_SENT, 0, part, -1, start + 1_000 + part))
            SendLog.record(store, ACTION_DELIVERED, 0, part, -1, start + 4_000 + part)
        }
        // Send 1: part 3 failed (RESULT_ERROR_GENERIC_FAILURE), no reports, and a row per part.
        for ((part, code) in listOf(-1, -1, 1).withIndex()) {
            SendLog.record(store, ACTION_SENT, 1, part, code, start + 6_000 + part * 100L)
        }
        // Out of range sends or parts and unknown actions are ignored.
        assertFalse(SendLog.record(store, ACTION_SENT, 9, 0, -1, start))
        assertFalse(SendLog.record(store, ACTION_SENT, 0, 16, -1, start))
        assertFalse(SendLog.record(store, "other", 0, 0, -1, start))
        val body0 = sendVectors[0].body
        val rows = listOf(SentRow(start + 50, body0, 0), SentRow(start - 60_000, body0, 0)) +
            sms.divideMessage(sendVectors[1].body).map { SentRow(start + 5_050, it, 32) } +
            SentRow(start + 10_050, "DYTEST-other", 0)
        val results = results(rows)
        val sent = mapOf(
            "id" to "gsm7-ext-straddle", "encoding" to "gsm7", "partsSent" to 2L,
            "partsDelivered" to 2L, "sentResults" to listOf(-1L, -1L),
            "deliveryResults" to listOf("delivered", "delivered"), "sentRows" to 1L,
            "sentRowBodyEqual" to true, "lastSentMs" to 1_001L, "lastDeliveredMs" to 4_001L,
        )
        assertEquals(sent, results[0])
        val perPart = mapOf(
            "id" to "gsm7-ext-extra-part", "encoding" to "gsm7", "partsSent" to 2L,
            "partsDelivered" to 0L, "sentResults" to listOf(-1L, -1L, 1L),
            "deliveryResults" to List(3) { "none" }, "sentRows" to 3L, "sentRowBodyEqual" to false,
            "lastSentMs" to 1_200L,
        )
        assertEquals(perPart, results[1])
        assertEquals(0L to false, results[2]["sentRows"] to results[2]["sentRowBodyEqual"])
        val json = reportWith(sends = sendsOf(store, TestFiles.vectors, sms, rows))
        for (trace in listOf("DYTEST", "555", "AAAA")) assertFalse(trace, json.contains(trace))
    }

    @Test
    fun `a row stamped after the next send started is still its send's, and only its send's`() {
        repeat(2) { sendAll("+15555550100") }
        for (part in 0..1) SendLog.record(store, ACTION_DELIVERED, 0, part, -1, start + 9_000)
        val body0 = sendVectors[0].body
        val firstPart = sms.divideMessage(sendVectors[1].body)[0]
        // Android stamps a send's row when its last part is sent: here after the next send began,
        // for the first run's send 0 and the second run's send 7 of the same vector. Send 1's
        // first part, which send 0 shares, belongs to send 1.
        val rows = listOf(
            SentRow(start + 5_500, body0, 0), SentRow(start + 40_500, body0, 32),
            SentRow(start + 5_200, firstPart, 32),
        )
        val results = results(rows)
        fun facts(n: Int) = with(results[n]) {
            listOf(get("sentRows"), get("sentRowBodyEqual"), get("partsDelivered"))
        }
        assertEquals(listOf(1L, true, 2L), facts(0))
        assertEquals(listOf(1L, true, 0L), facts(7))
        assertEquals(listOf(1L, false, 0L), facts(1))
        for (n in (2..6) + (8..13)) assertEquals("$n", 0L, results[n]["sentRows"])
    }
}
