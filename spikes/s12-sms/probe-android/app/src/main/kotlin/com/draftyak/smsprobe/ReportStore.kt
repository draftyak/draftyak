package com.draftyak.smsprobe

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

// files/report.json in the app's private storage: UTF-8 without a BOM, at most 1 MiB. It leaves the
// phone only through receive-report --from-adb (adb exec-out run-as ... cat files/report.json).
object ReportStore {
    const val FILE_NAME = "report.json"
    const val MAX_BYTES = 1_048_576

    fun write(filesDir: File, report: Report): Int {
        val bytes = report.toJson().toByteArray(Charsets.UTF_8)
        check(bytes.size <= MAX_BYTES) { "the report is over $MAX_BYTES bytes" }
        val partial = File(filesDir, "$FILE_NAME.partial").apply { writeBytes(bytes) }
        val target = File(filesDir, FILE_NAME).toPath()
        Files.move(partial.toPath(), target, StandardCopyOption.ATOMIC_MOVE)
        return bytes.size
    }
}
