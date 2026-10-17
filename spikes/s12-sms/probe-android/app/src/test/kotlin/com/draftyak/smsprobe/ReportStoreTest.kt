package com.draftyak.smsprobe

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ReportStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun `report json is the serializer's UTF-8 bytes, replaced whole`() {
        val dir = folder.newFolder("files")
        val first = Report(ProbeVersion.CURRENT, Reports.createdAt, Reports.device())
        ReportStore.write(dir, first)
        val second = Reports.full()
        val size = ReportStore.write(dir, second)
        val bytes = File(dir, "report.json").readBytes()
        assertArrayEquals(second.toJson().toByteArray(Charsets.UTF_8), bytes)
        assertEquals(bytes.size, size)
        assertEquals(listOf("report.json"), dir.list()!!.toList())
        assertFalse(bytes[0] == 0xef.toByte())
    }
}

class ProbeLogTest {
    @Test
    fun `log lines are an event name and clamped counts`() {
        assertEquals("report-not-written", ProbeLog.line(ProbeEvent.REPORT_NOT_WRITTEN))
        assertEquals(
            "report-written bytes=2048 test-messages=999999",
            ProbeLog.line(
                ProbeEvent.REPORT_WRITTEN,
                ProbeCount.BYTES to 2048,
                ProbeCount.TEST_MESSAGES to Int.MAX_VALUE,
            ),
        )
        assertEquals("DYProbe", ProbeLog.TAG)
    }
}
