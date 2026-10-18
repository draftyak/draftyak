package com.draftyak.smsprobe

import android.util.Log

enum class ProbeEvent : Kebab {
    SECOND_NUMBER_SAVED, SECOND_NUMBER_REFUSED, REPORT_WRITTEN, REPORT_NOT_WRITTEN, SENDS_DONE,
    PART_SENT, PART_DELIVERED, SERVICE_STARTED, SERVICE_REFUSED, TIMER_SAMPLE, OTP_SAMPLE,
    TLS_DONE
}

enum class ProbeCount : Kebab {
    BYTES, TEST_MESSAGES, SENT, REFUSED, SECONDS, ATTEMPTS, VECTORS, MATCHED
}

// The probe's only logcat output (adb logcat -s DYProbe): an event name and clamped counts, never
// text, numbers or names read on the phone.
object ProbeLog {
    const val TAG = "DYProbe"

    fun line(event: ProbeEvent, vararg counts: Pair<ProbeCount, Int>): String =
        counts.joinToString("") { (name, value) -> " ${name.wire}=${value.coerceIn(0, 999_999)}" }
            .let { event.wire + it }

    fun log(event: ProbeEvent, vararg counts: Pair<ProbeCount, Int>) {
        Log.i(TAG, line(event, *counts))
    }
}
