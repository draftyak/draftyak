package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// What the owner picks on the probe's screen: enum values only.
class ObservationsTest {
    @Test
    fun `recorded installs become install entries with this phone's Android version`() {
        val android = ShortVersion.of("16")
        val items = listOf("ADB,YES,NOT_NEEDED,NO_PROMPT,OFF", "BROWSER,NO,NEEDED,BLOCKED,ON")
        val installs = items.map { installOf(it, android)!! }
        val report =
            Report(ProbeVersion.CURRENT, Reports.createdAt, Reports.device(), install = installs)
        val json = Json.parse(report.toJson()) as Map<*, *>
        assertEquals(emptyList<String>(), SchemaCheck.problems(json))
        val expected = listOf(
            mapOf(
                "path" to "adb", "androidVersion" to "16", "installed" to true,
                "restrictedSettings" to "not-needed", "playProtect" to "no-prompt",
                "advancedProtection" to "off",
            ),
            mapOf(
                "path" to "browser", "androidVersion" to "16", "installed" to false,
                "restrictedSettings" to "needed", "playProtect" to "blocked",
                "advancedProtection" to "on",
            ),
        )
        assertEquals(expected, json["install"])
        for (item in listOf("TELEPATHY,YES,NEEDED,BLOCKED,ON", "ADB,YES", "")) {
            assertNull(item, installOf(item, android))
        }
    }
}
