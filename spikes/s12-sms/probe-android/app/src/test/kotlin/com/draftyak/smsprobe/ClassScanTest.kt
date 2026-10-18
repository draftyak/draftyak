package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.util.zip.ZipFile

// A class file's constant pool: its UTF-8 entries (every class, member, descriptor and string
// constant the class names) and its field and method references as owner.name(descriptor).
class ConstantPool(val strings: List<String>, val refs: List<String>)

fun constantPool(bytes: ByteArray): ConstantPool = DataInputStream(bytes.inputStream()).run {
    check(readInt() == 0xCAFEBABE.toInt()) { "not a class file" }
    skipBytes(4)
    val count = readUnsignedShort()
    val utf = arrayOfNulls<String>(count)
    // Class: [name]; Fieldref, Methodref, InterfaceMethodref: [tag, class, nameAndType];
    // NameAndType: [12, name, descriptor].
    val entries = arrayOfNulls<IntArray>(count)
    var index = 1
    while (index < count) {
        when (val tag = readUnsignedByte()) {
            1 -> utf[index] = readUTF()
            7 -> entries[index] = intArrayOf(readUnsignedShort())
            9, 10, 11, 12 ->
                entries[index] = intArrayOf(tag, readUnsignedShort(), readUnsignedShort())
            8, 16, 19, 20 -> skipBytes(2)
            15 -> skipBytes(3)
            3, 4, 17, 18 -> skipBytes(4)
            5, 6 -> skipBytes(8).also { index++ }
            else -> error("constant pool tag $tag")
        }
        index++
    }
    val refs = entries.filterNotNull().filter { it.size == 3 && it[0] != 12 }.map { ref ->
        val (_, name, descriptor) = entries[ref[2]]!!
        "${utf[entries[ref[1]]!![0]]}.${utf[name]}${utf[descriptor]}"
    }
    ConstantPool(utf.filterNotNull(), refs)
}

fun constantStrings(bytes: ByteArray): List<String> = constantPool(bytes).strings

// Every class the APK gets: the probe's Kotlin and Java classes, R and the libraries, from the
// variant's ScopedArtifacts ALL classes (ProbeClasses in app/build.gradle.kts). The scan sees
// direct references; reflection and JNI aren't covered.
class ClassScanTest {
    private val pools: Map<String, ConstantPool> = ZipFile(TestFiles.path("classes")).use { zip ->
        zip.entries().asSequence().filterNot { it.isDirectory }
            .associate { it.name to constantPool(zip.getInputStream(it).readBytes()) }
    }
    private val classes = pools.mapValues { it.value.strings }
    private val probe = classes.filterKeys { it.startsWith("com/draftyak/smsprobe/") }
    // By top-level class: a lambda's or companion's references count as its outer class's.
    private val refs: Map<String, List<String>> = pools.filterKeys { it in probe }.entries
        .groupBy({ it.key.removePrefix("com/draftyak/smsprobe/").substringBefore('$') }) {
            it.value.refs
        }
        .mapKeys { it.key.removeSuffix(".class") }.mapValues { it.value.flatten() }

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

    // The probe classes with a reference the predicate picks, and those references.
    private fun referencing(pick: (String) -> Boolean): Map<String, List<String>> =
        refs.mapValues { (_, list) -> list.filter(pick) }.filterValues(List<String>::isNotEmpty)

    @Test
    fun `the APK gets only the probe's classes and Kotlin's standard library`() {
        val kotlin = listOf(
            "kotlin/", "org/jetbrains/annotations/", "org/intellij/lang/annotations/",
        )
        val others = classes.keys.filterNot { it in probe || kotlin.any(it::startsWith) }
        assertEquals(emptyList<String>(), others)
        val names = listOf(
            "MainActivity", "ProbeLog", "Standin", "Report", "R", "ProbeService", "ProbeReceiver",
            "SmsReceiver", "TlsProbe", "ProbeKeyManager", "SendProbe", "InventoryReader",
        )
        for (name in names) {
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
    fun `network types appear only in Standin and the TLS client`() {
        // Sockets, addresses, name lookups, URLs, HTTP, web views, downloads, and processes (a
        // shell's nc). Each allowed class lists exactly the types it names.
        val network = Regex(
            "(?:java/net/|javax/net/|java/nio/channels/|java/lang/ProcessBuilder|" +
                "java/lang/(?:Process|Runtime)\\b|android/net/(?:http/|Local|DnsResolver|nsd/)|" +
                "android/webkit/|android/app/DownloadManager|android/system/Os|okhttp3/|" +
                "org/apache/http/|com/android/okhttp/)[\\w$/]*",
        )
        val ssl = listOf(
            "KeyManager", "SSLContext", "SSLParameters", "SSLSession", "SSLSocket",
            "SSLSocketFactory", "TrustManager", "TrustManagerFactory",
        ).map { "javax/net/ssl/$it" }
        val allowed = mapOf(
            "Standin" to
                listOf("java/net/InetSocketAddress", "java/net/Socket", "java/net/SocketAddress"),
            "TlsProbe" to listOf("java/net/Socket") + ssl,
            "ProbeKeyManager" to listOf(
                "java/net/Socket", "javax/net/ssl/SSLEngine",
                "javax/net/ssl/X509ExtendedKeyManager",
            ),
        ).mapKeys { "com/draftyak/smsprobe/${it.key}.class" }
        assertEquals(emptyMap<String, List<String>>(), found(probe, network, allowed))
        assertEquals(allowed.keys, found(probe, network).keys)
        // Only Standin builds a socket address, so only Standin.address() picks the peer.
        val addresses = found(probe, Regex("java/net/InetSocketAddress"))
        assertEquals(setOf("com/draftyak/smsprobe/Standin.class"), addresses.keys)
    }

    @Test
    fun `only Standin connects a socket, the TLS client makes an unconnected one and layers TLS`() {
        // A Socket constructor with a peer, a createSocket with a host and any connect dial; the
        // allowed ones take no peer or wrap a socket that's already connected.
        val layered = "(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;"
        val dials = referencing { ref ->
            val member = ref.substringBefore('(')
            val descriptor = ref.removePrefix(member)
            when (member.substringAfterLast('.')) {
                "<init>" -> member == "java/net/Socket.<init>" && descriptor != "()V"
                "createSocket" -> descriptor != layered && descriptor != "()Ljava/net/Socket;"
                "connect" -> member.startsWith("java/") || member.startsWith("javax/")
                else -> false
            }
        }
        val connect = "java/net/Socket.connect(Ljava/net/SocketAddress;I)V"
        assertEquals(mapOf("Standin" to listOf(connect)), dials)
        val tls = refs.getValue("TlsProbe")
        assertTrue("java/net/Socket.<init>()V" in tls)
        assertTrue("javax/net/ssl/SSLSocketFactory.createSocket$layered" in tls)
        val address = "java/net/InetSocketAddress.<init>(Ljava/lang/String;I)V"
        assertTrue(address in refs.getValue("Standin"))
        val standinCalls = referencing { it.startsWith("com/draftyak/smsprobe/Standin.connect(") }
        assertEquals(setOf("TlsProbe"), standinCalls.keys)
    }

    @Test
    fun `only the send probe sends, through AndroidSms, and only the screen starts it`() {
        val smsManager = Regex("android/telephony/(?:gsm/)?SmsManager\\.send.*")
        assertEquals(setOf("AndroidSms"), referencing(smsManager::matches).keys)
        val sendMultipart = referencing { it.substringBefore('(').endsWith(".sendMultipart") }
        assertEquals(setOf("SendProbe"), sendMultipart.keys)
        val probe = referencing { it.startsWith("com/draftyak/smsprobe/SendProbe.") }
        assertEquals(setOf("MainActivity", "SendProbe"), probe.keys)
        val init = "com/draftyak/smsprobe/SendProbe.<init>(Lcom/draftyak/smsprobe/Store;" +
            "Lcom/draftyak/smsprobe/SmsApi;)V"
        assertTrue(init in probe.getValue("MainActivity"))
    }
}
