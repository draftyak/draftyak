package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@Suppress("UNCHECKED_CAST")
class ReportSerializerTest {
    private fun parse(report: Report) = Json.parse(report.toJson()) as Map<String, Any?>

    @Test
    fun `a minimal report has the required fields and nothing else`() {
        val json = Report(ProbeVersion.CURRENT, Reports.createdAt, Reports.device()).toJson()
        val head = "{\"schema\":\"draftyak.s12.probe-report.v1\",\"encodingCheck\""
        assertTrue(json.startsWith(head))
        val report = Json.parse(json) as Map<String, Any?>
        assertEquals(
            listOf("schema", "encodingCheck", "probeVersion", "createdAt", "device"),
            report.keys.toList(),
        )
        assertEquals(emptyList<String>(), SchemaCheck.problems(report))
    }

    @Test
    fun `encodingCheck is written as UTF-8 e-acute, euro sign, thumbs up`() {
        val bytes = Report(ProbeVersion.CURRENT, Reports.createdAt, Reports.device()).toJson()
            .toByteArray(Charsets.UTF_8)
        val expected = byteArrayOf(
            0xc3.toByte(), 0xa9.toByte(), 0xe2.toByte(), 0x82.toByte(), 0xac.toByte(),
            0xf0.toByte(), 0x9f.toByte(), 0x91.toByte(), 0x8d.toByte(),
        )
        val at = String(bytes, Charsets.ISO_8859_1).indexOf(String(expected, Charsets.ISO_8859_1))
        assertTrue(at > 0)
        assertFalse(bytes.take(3) == listOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()))
    }

    @Test
    fun `a full report covers every field of the schema and passes it`() {
        val json = Reports.full().toJson()
        val report = Json.parse(json)
        assertEquals(emptyList<String>(), SchemaCheck.problems(report))
        assertEquals(SchemaCheck.leaves().keys, reportLeaves(report))
        assertEquals(113, SchemaCheck.leaves().size)
        TestFiles.writeSample("report-full.json", json)
    }

    @Test
    fun `every enum and const matches the schema's values`() {
        val enums: Map<String, List<Wire>> = mapOf(
            "device.manufacturer" to Manufacturer.entries,
            "device.smsFormat" to SmsFormat.entries,
            "inventory.providers[].table" to ProviderTable.entries,
            "inventory.providers[].failure" to ProviderFailure.entries,
            "inventory.rcs.idMethod" to RcsIdMethod.entries,
            "inventory.rcs.outgoingWritten" to Tri.entries,
            "inventory.rcs.e2eeReadable" to Tri.entries,
            "vectors.results[].id" to VectorId.entries,
            "vectors.results[].match" to VectorMatch.entries,
            "sends.results[].id" to VectorId.entries,
            "sends.results[].encoding" to SmsEncoding.entries,
            "sends.results[].deliveryResults[]" to DeliveryResult.entries,
            "background.runs[].scenario" to Scenario.entries,
            "background.runs[].restarted" to Tri.entries,
            "tls.result" to TlsResult.entries,
            "tls.fallbackReason" to TlsFailure.entries,
            "tls.keyClass" to KeyClass.entries,
            "tls.keyDigests[]" to KeyDigest.entries,
            "tls.attempts[].keyClass" to KeyClass.entries,
            "tls.attempts[].keyDigests[]" to KeyDigest.entries,
            "tls.attempts[].result" to AttemptResult.entries,
            "tls.attempts[].failure" to TlsFailure.entries,
            "tls.protocol" to TlsProtocol.entries,
            "tls.cipherSuite" to CipherSuite.entries,
            "network.localNetworkPermission" to LocalNetworkPermission.entries,
            "network.lanStandin" to Reach.entries,
            "network.tailnetStandin" to Reach.entries,
            "otp.samples[].webOtp" to WebOtp.entries,
            "install[].path" to InstallPath.entries,
            "install[].restrictedSettings" to RestrictedSettings.entries,
            "install[].playProtect" to PlayProtect.entries,
            "install[].advancedProtection" to AdvancedProtection.entries,
            "testMessages[].transport" to Transport.entries,
            "testMessages[].direction" to Direction.entries,
            "testMessages[].table" to ProviderTable.entries,
        )
        val consts = mapOf(
            "schema" to REPORT_SCHEMA,
            "encodingCheck" to ENCODING_CHECK,
            "vectors.format" to VECTORS_FORMAT,
        )
        val schemaEnums = SchemaCheck.leaves().filterValues { it["enum"] != null }
        assertEquals(schemaEnums.keys, enums.keys)
        for ((path, rule) in schemaEnums) {
            assertEquals(path, rule["enum"] as List<String>, enums.getValue(path).map { it.wire })
        }
        val schemaConsts = SchemaCheck.leaves().filterValues { it["const"] is String }
        assertEquals(consts, schemaConsts.mapValues { it.value["const"] })
    }

    @Test
    fun `numbers are clamped into the schema's ranges, so no count can carry a phone number`() {
        val big = Int.MAX_VALUE
        val report = Report(
            ProbeVersion.CURRENT, Reports.createdAt, Reports.device(sdkLevel = -5),
            threadMix = ThreadMix(15_555_550, big, big, big, big, big, big, big, big, big, big),
            sends = Sends(
                attempted = 99,
                results = listOf(
                    SendResult(
                        VectorId.NFC_CAFE, big, sentResults = listOf(-99, 123_456),
                        lastSentMs = Long.MAX_VALUE, lastDeliveredMs = -1,
                    ),
                ),
            ),
            otp = Otp(listOf(OtpSample(true, delayMs = 447_700_900_123))),
        )
        val json = report.toJson()
        assertEquals(emptyList<String>(), SchemaCheck.problems(Json.parse(json)))
        assertFalse(Regex("[0-9]{9}").containsMatchIn(json))
        val sends = parse(report)["sends"] as Map<String, Any?>
        assertEquals(20L, sends["attempted"])
        val result = (sends["results"] as List<Map<String, Any?>>).single()
        assertEquals(listOf(-1L, 9999L), result["sentResults"])
        assertEquals(86_400_000L, result["lastSentMs"])
        assertEquals(0L, result["lastDeliveredMs"])
    }

    @Test
    fun `arrays are cut to the schema's maximum and keep their names unique`() {
        val provider = Provider(
            ProviderTable.SMS, true,
            columns = (List(300) { "col_" + ('a' + it % 26) + ('a' + it / 26) } + "_id" + "_id")
                .map { ColumnName.of(it)!! },
        )
        val report = Report(
            ProbeVersion.CURRENT, Reports.createdAt, Reports.device(),
            inventory = Inventory(List(20) { provider }),
            testMessages = List(50) { Reports.testMessage("DYTEST-$it") }.filterNotNull(),
            tls = Tls(TlsResult.OK, keyDigests = KeyDigest.entries + KeyDigest.entries),
        )
        val parsed = parse(report)
        assertEquals(emptyList<String>(), SchemaCheck.problems(parsed))
        val providers = (parsed["inventory"] as Map<String, Any?>)["providers"] as List<Any?>
        assertEquals(16, providers.size)
        assertEquals(256, ((providers[0] as Map<String, Any?>)["columns"] as List<Any?>).size)
        assertEquals(40, (parsed["testMessages"] as List<Any?>).size)
    }

    @Test
    fun `a report at every maximum stays under 1 MiB`() {
        val columns = List(256) {
            ColumnName.of("_" + "z".repeat(45) + ('a' + it % 26) + ('a' + it / 26))!!
        }
        val body = "DYTEST-" + "👍".repeat(113)
        val report = Report(
            ProbeVersion.CURRENT, Reports.createdAt, Reports.device(),
            inventory = Inventory(
                List(16) { Provider(ProviderTable.OTHER, true, columns = columns) },
            ),
            testMessages = List(40) { Reports.testMessage(body)!! },
        )
        val bytes = report.toJson().toByteArray(Charsets.UTF_8).size
        assertTrue("$bytes bytes", bytes < ReportStore.MAX_BYTES)
        assertEquals(emptyList<String>(), SchemaCheck.problems(parse(report)))
    }

    @Test
    fun `JSON strings escape quotes, backslashes and newlines`() {
        val message = Reports.testMessage("DYTEST-say \"hi\" \\ then\na new line")
        val json = Report(
            ProbeVersion.CURRENT, Reports.createdAt, Reports.device(),
            testMessages = listOfNotNull(message),
        ).toJson()
        assertTrue(json.contains("\"DYTEST-say \\\"hi\\\" \\\\ then\\na new line\""))
        val parsed = Json.parse(json) as Map<String, Any?>
        val row = (parsed["testMessages"] as List<Map<String, Any?>>).single()
        assertEquals("DYTEST-say \"hi\" \\ then\na new line", row["body"])
    }

    @Test
    fun `device values outside the schema's shapes are left out`() {
        assertNull(ShortVersion.of("Baklava"))
        assertNull(ShortVersion.of("16.1.2.3"))
        assertNull(ShortVersion.of("١٦"))
        assertNull(DateVersion.of("2026-02-30"))
        assertNull(DateVersion.of("2019-12-01"))
        assertNull(BuildVersion.of("BP3A.250231.004"))
        assertNull(BuildVersion.of("bp3a.251005.004"))
        assertNull(BuildVersion.of("BP3A.251005.004 release-keys"))
        assertNull(MessagesVersion.fromVersionName("messages.android_20261301_00_RC02"))
        assertNull(MessagesVersion.fromVersionName("x messages.android_20261001_00_RC02"))
        assertNull(MessagesVersion.fromVersionName(null))
        assertEquals(
            "messages.android_20261001_00_RC02",
            MessagesVersion
                .fromVersionName("messages.android_20261001_00_RC02.phone_dynamic")?.text,
        )
        assertEquals(Manufacturer.SAMSUNG, Manufacturer.of("Samsung"))
        assertEquals(Manufacturer.HMD_GLOBAL, Manufacturer.of("HMD Global"))
        assertEquals(Manufacturer.OTHER, Manufacturer.of("Maria Garcia"))
        assertNull(UtcTime.of(0))
        assertEquals("2026-10-17T16:00:00.000Z", Reports.createdAt.text)
    }

    @Test
    fun `the Kotlin checks never accept what the schema's patterns refuse`() {
        val leaves = SchemaCheck.leaves()
        val candidates = TestFiles.corpus.values.flatMap { (it as? List<*>).orEmpty() }
            .filterIsInstance<String>() + listOf(
            "0.1.0", "16", "16.1", "16.1.2", "1.2.3.4", "2026-10-05", "2026-02-30",
            "BP3A.251005.004",
            "BP3A.251005.004.F1", "CP1A.260230.004", "_id", "thread_id", "date_sent", "sub_id",
            "a1b2", "a1b2c3", "x_cafebabe", "_", "Address", "rcs_msg_type", "a".repeat(49),
        )
        val checks: List<Pair<String, (String) -> String?>> = listOf(
            "device.androidVersion" to { ShortVersion.of(it)?.text },
            "device.securityPatchVersion" to { DateVersion.of(it)?.text },
            "device.buildVersion" to { BuildVersion.of(it)?.text },
            "device.messagesVersion" to { MessagesVersion.fromVersionName(it)?.text },
            "inventory.providers[].columns[]" to { ColumnName.of(it)?.text },
            "testMessages[].body" to { DytestBody.of(it)?.text },
        )
        for ((path, check) in checks) {
            for (candidate in candidates + candidates.map { DytestBody.PREFIX + it }) {
                val kept = check(candidate) ?: continue
                assertTrue("$path: $kept", SchemaCheck.accepts(leaves.getValue(path), kept))
            }
        }
        assertTrue(SchemaCheck.accepts(leaves.getValue("probeVersion"), ProbeVersion.CURRENT.text))
        for (millis in listOf(1_577_836_800_000, 1_792_252_800_123, 4_102_444_799_999)) {
            val text = UtcTime.of(millis)!!.text
            assertTrue(text, SchemaCheck.accepts(leaves.getValue("createdAt"), text))
        }
    }

    @Test
    fun `column names that could carry numbers, codes or hashes are dropped`() {
        val kept = listOf(
            "_id", "thread_id", "date_sent", "sub_id", "m_type", "ct_t", "tr_id", "a1b2",
        )
        assertEquals(kept, ColumnName.list(kept.toTypedArray()).map { it.text })
        val dropped = TestFiles.corpusStrings("identifiers") +
            TestFiles.corpusStrings("threadIds") +
            listOf("a1b2c3", "x_cafebabe", "Address", "", "1st", "a".repeat(49), "body\n")
        assertEquals(emptyList<ColumnName>(), ColumnName.list(dropped.toTypedArray()))
    }
}
