package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

private const val SECOND = "+15555550100"

class OtpTest {
    private val second = Reports.secondNumber
    private val body = "DYTEST-Your code is 482913"
    private val code = Regex("(?<![0-9])[0-9]{4,8}(?![0-9])")
    private val at = 1_792_252_800_000L
    private val minute = 60_000L

    private fun unread(): String = error("another sender's text was read")

    @Suppress("UNCHECKED_CAST")
    private fun samples(store: Store, rows: List<Long>, now: Long): List<Map<String, Any?>> {
        val json = reportWith(otp = OtpProbe.report(store, rows, now))
        assertEquals(emptyList<String>(), SchemaCheck.problems(Json.parse(json)))
        for (trace in listOf("482913", "DYTEST", "555")) assertFalse(json.contains(trace))
        val otp = (Json.parse(json) as Map<*, *>)["otp"] as Map<*, *>
        return otp["samples"] as List<Map<String, Any?>>
    }

    @Test
    fun `only the second number's texts are read, and only OTP-shaped DYTEST ones are kept`() {
        assertEquals(body, OtpProbe.body(second, "+1 555 555 0100") { body })
        val others = TestFiles.corpusStrings("numbers") + TestFiles.corpusStrings("senders") +
            "15555550100"
        for (address in others) assertNull(address, OtpProbe.body(second, address, ::unread))
        assertNull(OtpProbe.body(null, SECOND, ::unread))
        assertNull(OtpProbe.body(second, null, ::unread))
        val plain = listOf("DYTEST-hi", "DYTEST-code 123", "DYTEST-code 123456789", "dytest-4829")
        for (text in TestFiles.corpusStrings("otp") + plain) {
            assertNull(text, OtpProbe.body(second, SECOND) { text })
        }
        for (text in TestFiles.corpusStrings("otp")) {
            val shaped = OtpProbe.shaped(DytestBody.PREFIX + text)
            assertEquals(text, code.containsMatchIn(text), shaped)
        }
    }

    @Test
    fun `the arrival is this text's stored row, never an earlier text with the same body`() {
        // The row Android 17 held back: stored 3 s after the SMSC's time.
        val held = listOf(at - 15 * minute, at + 3_000)
        assertEquals(at + 3_000, OtpProbe.arrival(held, at, emptyList()))
        // This text's row isn't stored yet, and the same code came 15 minutes earlier.
        assertEquals(at, OtpProbe.arrival(listOf(at - 15 * minute), at, emptyList()))
        // A phone clock a minute behind the SMSC's.
        assertEquals(at - minute, OtpProbe.arrival(listOf(at - minute), at, emptyList()))
        // Two held texts with the same code, 5 minutes apart: each gets its own row.
        val rows = listOf(at, at + 5 * minute)
        assertEquals(at, OtpProbe.arrival(rows, at - 2_000, emptyList()))
        assertEquals(at + 5 * minute, OtpProbe.arrival(rows, at + 5 * minute - 2_000, listOf(at)))
        assertEquals(at + 9_000, OtpProbe.arrival(listOf(at), at + 9_000, listOf(at)))
    }

    @Test
    fun `the OTP section holds delays and the texts whose broadcast hasn't come, no text`() {
        val store = MapStore()
        for (delay in listOf(2_000L, 10_800_000L, 10_799_000L)) {
            OtpProbe.record(store, at, at + delay)
        }
        OtpProbe.record(store, at + 5_000, at + 1_000)
        assertEquals(List(3) { at } + (at + 5_000), OtpProbe.arrivals(store))
        val delivered = { delay: Long, delayed: Boolean ->
            val webOtp = "webOtp" to "not-tested"
            mapOf("delivered" to true, "delayMs" to delay, "delayed" to delayed, webOtp)
        }
        val now = at + 4 * 60 * minute
        val expected = listOf(
            delivered(2_000, false), delivered(10_800_000, true), delivered(10_799_000, true),
            delivered(0, false),
        )
        assertEquals(expected, samples(store, listOf(at + 1_000), now))
        // Two more texts stored on the phone whose broadcasts haven't come: 20 and 5 minutes ago.
        val waiting = listOf(now - 20 * minute, now - 5 * minute)
        val undelivered = samples(store, listOf(at + 1_000) + waiting, now).drop(4)
        val held = listOf(true, false).map { mapOf("delivered" to false, "delayed" to it) }
        assertEquals(held, undelivered)
        store["webotp"] = WebOtp.OFFERED.name
        assertEquals("offered", samples(store, emptyList(), now)[0]["webOtp"])
        repeat(20) { OtpProbe.record(store, at, at + 1) }
        assertEquals(16, OtpProbe.report(store, emptyList(), now)!!.samples.size)
        assertEquals(16, samples(store, waiting, now).size)
        assertNull(OtpProbe.report(MapStore(), emptyList(), now))
    }
}
