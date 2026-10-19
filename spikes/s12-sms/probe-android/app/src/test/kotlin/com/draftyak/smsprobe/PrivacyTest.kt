package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Other people's texts, numbers and names never leave the phone. The rows below are synthetic,
// from M0.36's corpus (spikes/s12-sms/test/fixtures/other-person-corpus.json).
class PrivacyTest {
    private val corpus = TestFiles.corpus
    private fun strings(key: String) = TestFiles.corpusStrings(key)
    private val otherAddresses = strings("numbers") + strings("senders") + strings("emails") +
        strings("names") + listOf("", "+1555555010", "+155555501000", "15555550100", "5555550101")
    private val texts = strings("messages") + strings("otp") + strings("names") +
        strings("addresses") + strings("emails") + strings("threadIds")
    private val refused = listOf(
        "dytest-lower", "DYTEST", " DYTEST-lead", "DYTEST-code 4829", "DYTEST-٤٨٢٩",
        "DYTEST-mail a@b", "DYTEST-at\uFE6B", "DYTEST-at\uFF20", "DYTEST-see https://x",
        "DYTEST-WwW.example", "DYTEST-tab\t", "DYTEST-cr\r", "DYTEST-bidi\u202E",
        "DYTEST-soft\u00AD", "DYTEST-line\u2028", "DYTEST-para\u2029", "DYTEST-lone\uD83D",
        "DYTEST-private\uE000", "DYTEST-" + "x".repeat(114),
    ) + strings("otp").map { DytestBody.PREFIX + it }

    private fun row(address: String, body: String, second: SecondNumber? = Reports.secondNumber) =
        TestMessage.of(second, address, body, Transport.SMS, Direction.INBOUND, ProviderTable.SMS)

    @Test
    fun `rows from any other address yield nothing, marker texts included`() {
        for (address in otherAddresses) {
            for (text in texts + texts.map { DytestBody.PREFIX + it } + "DYTEST-ok") {
                assertNull("$address / $text", row(address, text))
            }
        }
    }

    @Test
    fun `without an owner-entered second number nothing is kept`() {
        assertNull(row("+15555550100", "DYTEST-ok", second = null))
        assertNull(SecondNumber.of(""))
        assertNull(SecondNumber.of("555"))
        assertNull(SecondNumber.of("VERIFY"))
        assertNull(SecondNumber.of("+1 555 555 0100 ext 2"))
    }

    @Test
    fun `the second number matches itself and its national form, with visual separators ignored`() {
        val second = Reports.secondNumber
        val forms = listOf("+15555550100", "+1 555 555 0100", "+1 (555) 555-0100")
        val national = listOf("5555550100", "555 555 0100", "(555) 555-0100", "555/555-0100")
        for (same in forms + "+1.555.555.0100" + national) {
            assertTrue(same, second.matches(same))
        }
        val near = listOf(
            "15555550100", "1 (555) 555-0100", "+15555550101", "5555550101", "555550100",
            "55555501000", "555-0100", "+5555550100",
        )
        for (other in otherAddresses + near) {
            assertFalse(other, second.matches(other))
        }
        assertEquals("SecondNumber", second.toString())
    }

    @Test
    fun `a national form matches only when worked out exactly from a number saved with +1`() {
        // Saved without the +1, the number matches only those digits.
        val national = SecondNumber.of("(555) 555-0100")!!
        assertTrue(national.matches("5555550100"))
        for (other in listOf("+15555550100", "15555550100", "+5555550100")) {
            assertFalse(other, national.matches(other))
        }
        val otherCountry = SecondNumber.of("+44 7700 900100")!!
        assertTrue(otherCountry.matches("+447700900100"))
        for (other in listOf("07700900100", "7700900100", "447700900100")) {
            assertFalse(other, otherCountry.matches(other))
        }
        for (notTen in listOf("+1555555010", "+155555501000")) {
            assertFalse(notTen, SecondNumber.of(notTen)!!.matches(notTen.drop(2)))
        }
        assertNotNull(row("(555) 555-0100", "DYTEST-sms reply from second"))
    }

    @Test
    fun `DYTEST rows from the second number are kept only when the body passes the schema`() {
        assertNotNull(row("+15555550100", "DYTEST-ok"))
        assertNotNull(row("+1 555 555 0100", "DYTEST-multi\nline \u200D joined 👍🏽"))
        for (body in refused) assertNull(body, row("+15555550100", body))
        assertNotNull(row("+15555550100", "DYTEST-" + "x".repeat(113)))
    }

    @Test
    fun `DytestBody agrees with the schema's dytestBody pattern`() {
        val rule = SchemaCheck.resolve(mapOf("\$ref" to "#/\$defs/dytestBody"))
        val samples = texts.flatMap { listOf(it, DytestBody.PREFIX + it) } + refused + listOf(
            "DYTEST-", "DYTEST-ok", "DYTEST-123", "DYTEST-1234", "DYTEST-①②③",
            "DYTEST-①②③④", "DYTEST-Ⅻ Ⅻ", "DYTEST-a\nb", "DYTEST-a\u200Db", "DYTEST-a\u200Cb",
            "DYTEST-a\u0000b", "DYTEST-a\u0085b", "DYTEST-ww.w", "DYTEST-wWw.", "DYTEST-a:/b",
            "DYTEST-👨‍👩‍👧", "DYTEST-" + "👍".repeat(113), "DYTEST-" + "👍".repeat(114),
            "DYTEST-a@", "DYTEST-a＠",
        )
        val verdicts = samples.map { sample ->
            val kept = DytestBody.of(sample) != null
            assertEquals(sample, SchemaCheck.accepts(rule, sample), kept)
            "[${jsonAscii(sample)},$kept]"
        }
        // The heavy test holds receive-report's validator to the same verdicts.
        TestFiles.writeSample("dytest-verdicts.json", verdicts.joinToString(",", "[", "]"))
    }

    @Test
    fun `a report built from other people's rows carries none of their content`() {
        val numbers = strings("numbers")
        val columns = ColumnName.list(
            (strings("identifiers") + strings("threadIds") + strings("names") + numbers)
                .toTypedArray(),
        )
        @Suppress("UNCHECKED_CAST")
        val counts = (corpus.getValue("numbersAsIntegers") as List<Long>)
            .map { it.coerceAtMost(Int.MAX_VALUE.toLong()).toInt() }
        val report = Report(
            ProbeVersion.CURRENT, Reports.createdAt, Reports.device(),
            inventory = Inventory(
                providers = listOf(
                    Provider(ProviderTable.SMS, true, rows = counts[0], columns = columns),
                ),
                messages = Messages(sms = Directions(counts[1], counts[2], counts[3])),
            ),
            testMessages = otherAddresses.flatMap { address ->
                texts.mapNotNull { row(address, DytestBody.PREFIX + it) }
            },
        )
        val json = report.toJson()
        assertEquals(emptyList<String>(), SchemaCheck.problems(Json.parse(json)))
        assertEquals(emptyList<ColumnName>(), columns)
        assertEquals(emptyList<Any>(), (Json.parse(json) as Map<*, *>)["testMessages"])
        val traces = corpus.values.flatMap { (it as? List<*>).orEmpty() }.map(Any?::toString)
        for (trace in traces + numbers.map { it.filter(Char::isDigit) }) {
            assertFalse(trace, json.contains(trace))
        }
        TestFiles.writeSample("report-other-person.json", json)
    }

    @Test
    fun `the corpus checks above saw every kind of other-person content`() {
        assertEquals(
            setOf(
                "about", "names", "numbers", "senders", "messages", "threadIds", "otp",
                "identifiers", "emails", "addresses", "numbersAsIntegers",
            ),
            corpus.keys,
        )
    }
}
