package com.draftyak.smsprobe

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// A phone that answers calculateLength and divideMessage as one expected result of each vector.
class ReferenceSms(private val pick: (SegmentVector) -> Expected) : SmsApi {
    val sends = mutableListOf<Triple<String, List<String>, Int>>()

    private fun of(text: String) = TestFiles.vectors.single { it.body == text }
        .let { it to pick(it) }

    override fun calculateLength(text: String): IntArray = of(text).second.length.toIntArray()

    override fun divideMessage(text: String): List<String> {
        val (vector, expected) = of(text)
        val text = expected.text ?: vector.body
        return expected.parts.map { (start, end) -> text.substring(start, end) }
    }

    override fun sendMultipart(destination: String, parts: List<String>, send: Int) {
        sends += Triple(destination, parts, send)
    }
}

// A phone whose calculateLength and divideMessage give fixed answers.
fun fixedSms(length: (String) -> IntArray, parts: (String) -> List<String>) = object : SmsApi {
    override fun calculateLength(text: String) = length(text)
    override fun divideMessage(text: String) = parts(text)
    override fun sendMultipart(destination: String, parts: List<String>, send: Int) =
        error("no sends")
}

class VectorsTest {
    private val vectors = TestFiles.vectors

    @Test
    fun `the bundled vectors are M0's 34, with 7 send vectors in 15 parts`() {
        assertEquals(VectorId.entries.toSet(), vectors.map { it.id }.toSet())
        assertEquals(34, vectors.size)
        val sends = vectors.filter { it.send }
        val ids = listOf(
            "gsm7-ext-straddle", "gsm7-ext-extra-part", "ucs2-flag-straddle",
            "ucs2-skin-tone-straddle", "ucs2-keycap-straddle", "ucs2-zwj-straddle",
            "ucs2-emoji-run",
        )
        assertEquals(ids, sends.map { it.id.wire })
        assertEquals(15, sends.sumOf { it.expected[0].parts.size })
        for (vector in vectors) assertTrue(vector.body.startsWith(DytestBody.PREFIX))
        // Multipart: over 153 GSM-7 septets or 67 UCS-2 units, by Android's default count.
        for (send in sends.map { it.expected[0] }) {
            assertTrue(send.length[0] > 1 && send.length[1] > if (send.ucs2) 67 else 153)
        }
        val file = Json.parse(TestFiles.path("vectors").readText()) as Map<*, *>
        val raw = file["vectors"] as List<*>
        val keys = raw.flatMap { ((it as Map<*, *>)["alternatives"] as Map<*, *>?)?.keys.orEmpty() }
        assertEquals(setOf("tr", "es", "force7bit", "3gpp2"), keys.toSet())
    }

    @Test
    fun `the APK's assets are exactly the vectors file`() {
        val assets = TestFiles.path("assets").walk().filter(File::isFile).toList()
        assertEquals(listOf(SegmentVectors.ASSET), assets.map { it.name })
        assertArrayEquals(TestFiles.path("vectors").readBytes(), assets.single().readBytes())
    }

    @Test
    fun `a phone that behaves like an expected result matches it, part by part`() {
        var checked = 0
        for (vector in vectors) {
            for (expected in vector.expected) {
                val sms = ReferenceSms { if (it === vector) expected else it.expected[0] }
                val json = Json.parse(runVector(vector, sms).json()) as Map<*, *>
                val text = expected.text ?: vector.body
                val first = vector.expected.first {
                    it.length == expected.length && it.parts == expected.parts &&
                        (it.text ?: vector.body) == text
                }
                val where = "${vector.id.wire} as ${expected.match.wire}"
                assertEquals(where, first.match.wire, json["match"])
                assertEquals(where, expected.parts.map { it[2].toLong() }, json["partUnits"])
                assertEquals(where, expected.length.map(Int::toLong), json["calculateLength"])
                assertEquals(where, text == vector.body, json["joinsBack"])
                checked++
            }
        }
        assertEquals(34 + vectors.sumOf { it.expected.size - 1 }, checked)
    }

    @Test
    fun `a phone that splits one code unit early matches nothing, though length and text agree`() {
        val multipart = vectors.filter { it.expected[0].parts.size > 1 }
        assertTrue(multipart.size > 20)
        for (vector in multipart) {
            val expected = vector.expected[0]
            val text = expected.text ?: vector.body
            val ends = expected.parts.map { it[1] }.toMutableList().apply { this[0] -= 1 }
            val parts = (listOf(0) + ends).zipWithNext { from, to -> text.substring(from, to) }
            val phone = fixedSms({ expected.length.toIntArray() }, { parts })
            val json = Json.parse(runVector(vector, phone).json()) as Map<*, *>
            assertEquals(vector.id.wire, "none", json["match"])
            assertEquals(vector.id.wire, expected.length.map(Int::toLong), json["calculateLength"])
            assertEquals(vector.id.wire, text == vector.body, json["joinsBack"])
        }
    }

    @Test
    fun `a phone that matches no expected result gets none, with its own counts`() {
        val odd = fixedSms({ intArrayOf(2, it.length, 7, 1) }, { listOf(it.take(9), it.drop(9)) })
        val results = vectors.map { runVector(it, odd) }
        for ((vector, result) in vectors.zip(results)) {
            val json = Json.parse(result.json()) as Map<*, *>
            assertEquals("none" to true, json["match"] to json["joinsBack"])
            val parts = listOf(vector.body.take(9), vector.body.drop(9))
            assertEquals(parts.map { septets(it).toLong() }, json["partUnits"])
        }
        val report = Json.parse(reportWith(vectors = Vectors(results)))
        assertEquals(emptyList<String>(), SchemaCheck.problems(report))
    }

    @Test
    fun `GSM septets follow the default, Turkish and Spanish tables`() {
        assertEquals(7, septets("DYTEST-"))
        assertEquals(2, septets("{"))
        assertEquals(1 + 2, septets("A" + Char(0x20ac)))
        // Turkish dotless i: one septet in the Turkish locking table, two through its single shift.
        val dotless = Char(0x131).toString()
        assertEquals(1, septets(dotless, locking = 1))
        assertEquals(2, septets(dotless, shift = 1))
        // A unit in no table counts as the space Android sends.
        assertEquals(1, septets(Char(0x436).toString()))
        assertEquals(2, septets(Char(0xf3).toString(), shift = 2))
    }

    @Test
    fun `the SMS format comes from calculateLength of a brace and an e-acute`() {
        fun phone(brace: IntArray, acute: IntArray) =
            fixedSms({ if (it == "{") brace else acute }, { listOf(it) })
        val gsm = intArrayOf(1, 2, 158, 1)
        val ascii = intArrayOf(1, 1, 159, 1)
        val ucs2 = intArrayOf(1, 1, 69, 3)
        assertEquals(SmsFormat.THREE_GPP, smsFormat(phone(gsm, ascii)))
        assertEquals(SmsFormat.THREE_GPP2, smsFormat(phone(ascii, ucs2)))
        assertEquals(SmsFormat.UNKNOWN, smsFormat(phone(gsm, ucs2)))
        assertEquals(SmsFormat.UNKNOWN, smsFormat(phone(ascii, ascii)))
    }
}
