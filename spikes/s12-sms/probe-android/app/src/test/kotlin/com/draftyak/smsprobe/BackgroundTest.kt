package com.draftyak.smsprobe

import android.app.ApplicationExitInfo.REASON_CRASH
import android.app.ApplicationExitInfo.REASON_LOW_MEMORY
import android.app.ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE
import android.app.ApplicationExitInfo.REASON_PACKAGE_UPDATED
import android.app.ApplicationExitInfo.REASON_PERMISSION_CHANGE
import android.app.ApplicationExitInfo.REASON_SIGNALED
import android.app.ApplicationExitInfo.REASON_USER_REQUESTED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BackgroundTest {
    private val store = MapStore()
    private val log = BackgroundLog(store)

    @Suppress("UNCHECKED_CAST")
    private fun runs(): List<Map<String, Any?>> {
        val json = Json.parse(reportWith(background = log.report())) as Map<*, *>
        assertEquals(emptyList<String>(), SchemaCheck.problems(json))
        return (json["background"] as Map<*, *>)["runs"] as List<Map<String, Any?>>
    }

    private fun run(name: String, exempt: Boolean, samples: Long, vararg more: Pair<String, Any>) =
        mapOf("scenario" to name, "batteryExempt" to exempt, "samples" to samples) + more

    private fun ms(p50: Long, p95: Long, max: Long) =
        arrayOf("p50Ms" to p50, "p95Ms" to p95, "maxMs" to max)

    @Test
    fun `Doze timer samples group by label and exemption, with nearest-rank percentiles`() {
        for (late in 1L..20L) log.sample(exempt = false, lateMs = late * 1_000)
        log.sample(exempt = true, lateMs = 1_500)
        log.sample(exempt = true, lateMs = -40)
        store["doze"] = "natural"
        log.sample(exempt = false, lateMs = 540_000)
        val expected = listOf(
            run("doze-forced", false, 20, *ms(10_000, 19_000, 20_000)),
            run("doze-forced", true, 2, *ms(0, 1_500, 1_500)),
            run("doze-natural", false, 1, *ms(540_000, 540_000, 540_000)),
        )
        assertEquals(expected, runs())
    }

    @Test
    fun `restarts after boot, after a kill and after a stop, with whether the service came back`() {
        val ui = StartCause.UI
        val sticky = StartCause.STICKY
        log.started(ui, foreground = true, exempt = false, exit = null, sinceBoot = 9_000, now = 0)
        // The system restarts the sticky service 4 s after its process died.
        log.started(sticky, true, false, REASON_LOW_MEMORY to 96_000L, 9_000, 100_000)
        // The owner opens the probe after a force stop, then after a crash that never restarted.
        log.started(ui, true, false, REASON_USER_REQUESTED to 200_000L, 9_000, 300_000)
        log.started(ui, true, false, REASON_CRASH to 400_000L, 9_000, 500_000)
        // The same exit again records nothing.
        log.started(ui, true, false, REASON_CRASH to 400_000L, 9_000, 600_000)
        // A sticky restart that can't become a foreground service: no delay.
        log.started(sticky, false, false, REASON_SIGNALED to 650_000L, 9_000, 660_000)
        // With no service running before, an exit is no restart case.
        log.started(ui, true, false, REASON_CRASH to 700_000L, 9_000, 800_000)
        log.started(StartCause.BOOT, true, true, null, 41_000, 900_000)
        log.started(StartCause.BOOT, true, true, null, 47_000, 990_000)
        val expected = listOf(
            run("after-kill", false, 3, *ms(4_000, 4_000, 4_000), "restarted" to "unknown"),
            run("after-force-stop", false, 1, "restarted" to "no"),
            run("after-boot", true, 2, *ms(41_000, 47_000, 47_000), "restarted" to "yes"),
        )
        assertEquals(expected, runs())
    }

    @Test
    fun `an update, a permission change or a package change isn't a kill`() {
        log.started(StartCause.UI, true, false, null, 9_000, 0)
        val reasons =
            listOf(REASON_PACKAGE_UPDATED, REASON_PERMISSION_CHANGE, REASON_PACKAGE_STATE_CHANGE)
        for ((n, reason) in reasons.withIndex()) {
            val exit = 100_000L * (n + 1)
            // The owner opens the probe after adb install -r, or Android restarts the service.
            log.started(StartCause.UI, true, false, reason to exit, 9_000, exit + 50_000)
            val restart = reason to exit + 60_000
            log.started(StartCause.STICKY, true, false, restart, 9_000, exit + 61_000)
        }
        assertNull(log.report())
        log.started(StartCause.STICKY, true, false, REASON_SIGNALED to 900_000L, 9_000, 905_000)
        val kill = run("after-kill", false, 1, *ms(5_000, 5_000, 5_000), "restarted" to "yes")
        assertEquals(listOf(kill), runs())
    }

    @Test
    fun `percentiles are nearest rank`() {
        assertEquals(null, percentile(emptyList(), 50))
        assertEquals(7L, percentile(listOf(7L), 95))
        assertEquals(2L, percentile(listOf(4L, 1, 3, 2), 50))
        assertEquals(4L, percentile(listOf(4L, 1, 3, 2), 95))
    }

    @Test
    fun `the logs keep their first items only`() {
        store["bg.samples"] = List(4_998) { "DOZE_FORCED,false,1" }.joinToString(";")
        repeat(5) { log.sample(false, 1) }
        assertEquals(5_000, store.list("bg.samples").size)
        store.append("x", "a", 2)
        store.append("x", "b", 2)
        store.append("x", "c", 2)
        assertEquals(listOf("a", "b"), store.list("x"))
    }
}
