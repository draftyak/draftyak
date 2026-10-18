package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.util.zip.ZipFile

// The UTF-8 entries of a class file's constant pool: every class, member, descriptor and string
// constant the class names.
fun constantStrings(bytes: ByteArray): List<String> = DataInputStream(bytes.inputStream()).run {
    check(readInt() == 0xCAFEBABE.toInt()) { "not a class file" }
    skipBytes(4)
    val strings = mutableListOf<String>()
    val count = readUnsignedShort()
    var index = 1
    while (index < count) {
        when (val tag = readUnsignedByte()) {
            1 -> strings += readUTF()
            7, 8, 16, 19, 20 -> skipBytes(2)
            15 -> skipBytes(3)
            3, 4, 9, 10, 11, 12, 17, 18 -> skipBytes(4)
            5, 6 -> skipBytes(8).also { index++ }
            else -> error("constant pool tag $tag")
        }
        index++
    }
    strings
}

// Every class the APK gets: the probe's Kotlin and Java classes, R and the libraries, from the
// variant's ScopedArtifacts ALL classes (ProbeClasses in app/build.gradle.kts). The scan sees
// direct references; reflection and JNI aren't covered.
class ClassScanTest {
    private val classes: Map<String, List<String>> = ZipFile(TestFiles.path("classes")).use { zip ->
        zip.entries().asSequence().filterNot { it.isDirectory }
            .associate { it.name to constantStrings(zip.getInputStream(it).readBytes()) }
    }
    private val probe = classes.filterKeys { it.startsWith("com/draftyak/smsprobe/") }

    // An allowed entry ending in / allows its whole package.
    private fun allows(entries: List<String>, match: String) =
        entries.any { it == match || it.endsWith('/') && match.startsWith(it) }

    // What each class names that matches the pattern, less what the allowlist lets it name.
    private fun found(
        scanned: Map<String, List<String>>,
        pattern: Regex,
        allowed: Map<String, List<String>> = emptyMap(),
    ): Map<String, List<String>> = scanned.mapValues { (name, strings) ->
        strings.flatMap { pattern.findAll(it).map(MatchResult::value) }.distinct()
            .filterNot { allows(allowed[name].orEmpty(), it) }
    }.filterValues(List<String>::isNotEmpty)

    @Test
    fun `the APK gets only the probe's classes and Kotlin's standard library`() {
        val kotlin = listOf(
            "kotlin/", "org/jetbrains/annotations/", "org/intellij/lang/annotations/",
        )
        val others = classes.keys.filterNot { it in probe || kotlin.any(it::startsWith) }
        assertEquals(emptyList<String>(), others)
        for (name in listOf("MainActivity", "ProbeLog", "Standin", "Report", "R")) {
            assertTrue(name, "com/draftyak/smsprobe/$name.class" in probe)
        }
        assertTrue(classes.size.toString(), "kotlin/Unit.class" in classes)
    }

    @Test
    fun `no class references CompanionDeviceManager or anything else guardrail 10 rules out`() {
        val banned = Regex(
            "android/companion/[\\w$/]*|android/app/role/[\\w$/]*|android\\.app\\.role\\.SMS|" +
                "android/service/notification/[\\w$/]*|android/accessibilityservice/[\\w$/]*",
        )
        assertEquals(emptyMap<String, List<String>>(), found(classes, banned))
    }

    @Test
    fun `only ProbeLog writes to logcat, and only through android util Log`() {
        // Logcat also gets System.out, System.err, stack traces, java.util.logging and EventLog.
        val logcat = Regex(
            "android/util/[\\w$]*Log[\\w$]*|java/util/logging/[\\w$/]*|" +
                "java/lang/System\\\$Logger|kotlin/io/ConsoleKt|java/io/PrintStream|" +
                "printStackTrace|dumpStack",
        )
        val allowed = mapOf("com/draftyak/smsprobe/ProbeLog.class" to listOf("android/util/Log"))
        assertEquals(emptyMap<String, List<String>>(), found(probe, logcat, allowed))
        assertEquals(listOf("android/util/Log"), found(probe, logcat).values.flatten().distinct())
    }

    @Test
    fun `only Standin reaches the network`() {
        // Sockets, addresses, name lookups, URLs, HTTP, web views, downloads, and processes (a
        // shell's nc). Each allowed class lists the types it names; M0.37b's TLS client gets its
        // own entry and dials only Standin.address().
        val network = Regex(
            "(?:java/net/|javax/net/|java/nio/channels/|java/lang/ProcessBuilder|" +
                "java/lang/(?:Process|Runtime)\\b|android/net/(?:http/|Local|DnsResolver|nsd/)|" +
                "android/webkit/|android/app/DownloadManager|android/system/Os|okhttp3/|" +
                "org/apache/http/|com/android/okhttp/)[\\w$/]*",
        )
        val allowed = mapOf(
            "com/draftyak/smsprobe/Standin.class" to listOf("java/net/InetSocketAddress"),
        )
        assertEquals(emptyMap<String, List<String>>(), found(probe, network, allowed))
        assertEquals(setOf("com/draftyak/smsprobe/Standin.class"), found(probe, network).keys)
    }
}
