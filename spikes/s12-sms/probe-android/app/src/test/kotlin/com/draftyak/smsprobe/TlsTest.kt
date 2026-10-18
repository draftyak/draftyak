package com.draftyak.smsprobe

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.Base64

// The key loop against scripted keys and connections: keyFailures by KEY_PLANS index, and each
// connection's handshake in turn (null: the stand-in wasn't reached). A connection without a
// failure sends the report, as exchange does after an equal EKM.
private class Loop(keyFailures: Map<Int, TlsFailure>, shakes: List<Handshake?>) {
    val connected = mutableListOf<String>()
    val reported = mutableListOf<Tls>()
    private val script = shakes.iterator()
    private val key = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair().private
    }

    val outcome: TlsRun = tryKeys(
        { plan ->
            val failure = keyFailures[KEY_PLANS.indexOf(plan)]
            val digests = plan.digests.ifEmpty { null }
            (if (failure == null) TlsKey(key, emptyArray(), plan.keyClass, digests) else null) to
                failure
        },
        { key, make ->
            connected += "${key.keyClass.wire} ${key.digests.orEmpty().map(KeyDigest::wire)}"
            script.next()?.let { shake ->
                shake to (if (shake.failure == null) make(shake)?.let { true to true } else null)
            }
        },
        { tls -> Reports.full().also { reported += tls } },
    )

    val attempts get() = outcome.tls?.attempts.orEmpty().map {
        "${it.keyClass.wire} ${it.keyDigests.orEmpty().map(KeyDigest::wire)} ${it.failure?.wire}"
    }
}

class TlsTest {
    private val sha256 = listOf(KeyDigest.SHA_256)
    private val noneSha256 = listOf(KeyDigest.NONE, KeyDigest.SHA_256)
    private val failed = AttemptResult.FAILED
    private val missing =
        TlsAttempt(KeyClass.STRONGBOX, failed, sha256, TlsFailure.STRONGBOX_MISSING)
    private val digest = TlsAttempt(KeyClass.TEE, failed, sha256, TlsFailure.KEYSTORE_DIGEST)
    private val tee = TlsAttempt(KeyClass.TEE, AttemptResult.OK, noneSha256)
    private val connected = Handshake(
        serverPinMatched = true, clientCertAccepted = true, ekmEqual = true,
        protocol = TlsProtocol.TLS_1_3, cipherSuite = CipherSuite.TLS_AES_128_GCM_SHA256,
        handshakeMs = 180,
    )

    private fun section(attempts: List<TlsAttempt>, last: Handshake?): Map<*, *> {
        val json = Json.parse(reportWith(tls = tlsSection(attempts, last))) as Map<*, *>
        assertEquals(emptyList<String>(), SchemaCheck.problems(json))
        return json["tls"] as Map<*, *>
    }

    private fun Map<*, *>.fields(vararg names: String) = names.map { this[it] }

    private fun frame(vararg fields: String) = fields.joinToString(",", "{", "}")

    @Test
    fun `keys go StrongBox then TEE, SHA-256 then with NONE, then the wrapped software key`() {
        val plans = KEY_PLANS.map { "${it.keyClass.wire} ${it.digests.map(KeyDigest::wire)}" }
        val expected = listOf(
            "strongbox [SHA-256]", "strongbox [NONE, SHA-256]", "tee [SHA-256]",
            "tee [NONE, SHA-256]", "keystore-wrapped-software []",
        )
        assertEquals(expected, plans)
    }

    @Test
    fun `a missing StrongBox is tried once, a digest failure moves on, and the first ok stops`() {
        val keystoreDigest = Handshake(TlsFailure.KEYSTORE_DIGEST)
        val loop = Loop(mapOf(0 to TlsFailure.STRONGBOX_MISSING), listOf(keystoreDigest, connected))
        assertEquals(listOf("tee [SHA-256]", "tee [NONE, SHA-256]"), loop.connected)
        val attempts = listOf(
            "strongbox [SHA-256] strongbox-missing", "tee [SHA-256] keystore-digest",
            "tee [NONE, SHA-256] null",
        )
        assertEquals(attempts, loop.attempts)
        assertEquals(TlsResult.OK to KeyClass.TEE, loop.outcome.tls?.result to loop.outcome.tls?.keyClass)
        assertEquals(true to true, loop.outcome.reportReply)
        // The report sent over the connection carries this run's attempts, the ok one included.
        assertEquals(loop.outcome.tls?.json(), loop.reported.single().json())
    }

    @Test
    fun `a refused client key or a handshake failure moves on, the wrapped key is the fallback`() {
        val refused = Handshake(TlsFailure.STANDIN_REFUSED, true, false)
        val handshake = Handshake(TlsFailure.HANDSHAKE)
        val shakes = listOf(refused, handshake, handshake, handshake, connected)
        val loop = Loop(emptyMap(), shakes)
        assertEquals(5, loop.connected.size)
        assertEquals("keystore-wrapped-software [] null", loop.attempts.last())
        val tls = loop.outcome.tls!!
        assertEquals(TlsResult.FALLBACK to TlsFailure.HANDSHAKE, tls.result to tls.fallbackReason)
        val keys = Loop((0..3).associateWith { TlsFailure.KEYSTORE_SIGNING }, listOf(connected))
        assertEquals(listOf("keystore-wrapped-software []"), keys.connected)
        assertEquals(TlsFailure.KEYSTORE_SIGNING, keys.outcome.tls?.fallbackReason)
    }

    @Test
    fun `a rejected server identity, another failure or an unreached stand-in stops the keys`() {
        for (failure in listOf(TlsFailure.SERVER_PIN, TlsFailure.OTHER)) {
            val loop = Loop(emptyMap(), listOf(Handshake(failure), connected))
            assertEquals(listOf("strongbox [SHA-256] ${failure.wire}"), loop.attempts)
            assertEquals(TlsResult.FAILED, loop.outcome.tls?.result)
            assertEquals(emptyList<Tls>(), loop.reported)
        }
        // Not reached at all: no TLS section, so the last one is kept.
        val unreached = Loop(mapOf(0 to TlsFailure.STRONGBOX_MISSING), listOf(null, connected))
        assertEquals(1, unreached.connected.size)
        assertNull(unreached.outcome.tls)
        assertNull(unreached.outcome.reportReply)
        // Not reached after a handshake: that attempt stays.
        val later = Loop(emptyMap(), listOf(Handshake(TlsFailure.KEYSTORE_DIGEST), null, connected))
        assertEquals(listOf("strongbox [SHA-256] keystore-digest"), later.attempts)
        assertEquals(TlsResult.FAILED, later.outcome.tls?.result)
    }

    @Test
    fun `the exchange sends the EKM hash after hello, and the report only after an equal EKM`() {
        val pid = ByteArray(16) { (it * 3).toByte() }
        val hello = frame(
            "\"t\":\"hello\"", "\"v\":1",
            "\"pid\":\"${Base64.getUrlEncoder().withoutPadding().encodeToString(pid)}\"",
        )
        val equal = frame("\"t\":\"ekm\"", "\"equal\":true")
        val unequal = frame("\"t\":\"ekm\"", "\"equal\":false")
        val error = frame("\"t\":\"error\"")
        val reply = frame("\"t\":\"report\"", "\"valid\":true", "\"written\":true")
        val ekm = ByteArray(32) { 7 }
        val shook = Handshake(serverPinMatched = true, protocol = TlsProtocol.TLS_1_3)
        class Run(vararg lines: String, export: ByteArray? = ekm, input: InputStream? = null) {
            val made = mutableListOf<Handshake>()
            val exported = mutableListOf<ByteArray>()
            val output = ByteArrayOutputStream()
            val shake = exchange(
                input ?: lines.joinToString("") { "$it\n" }.byteInputStream(), output,
                { exported += it; export }, shook, { made += it; Reports.full() },
            )
            val written get() = output.toString(Charsets.UTF_8).lines().filter(String::isNotEmpty)
        }
        val reportFrame = Frames.report(Reports.full()).trimEnd()

        val ok = Run(hello, equal, reply)
        assertEquals(listOf(Frames.ekm(ekm).trimEnd(), reportFrame), ok.written)
        assertArrayEquals(pid, ok.exported.single())
        val accepted = shook.copy(clientCertAccepted = true, ekmEqual = true)
        assertEquals(listOf(accepted), ok.made)
        assertEquals(accepted to (true to true), ok.shake)

        // A differing EKM: mTLS worked, nothing more is sent.
        val differs = Run(hello, unequal)
        assertEquals(listOf(Frames.ekm(ekm).trimEnd()), differs.written)
        assertEquals(shook.copy(clientCertAccepted = true, ekmEqual = false) to null, differs.shake)

        // The stand-in refused the client key: no hello, so nothing is sent.
        val refused = Run(error)
        assertEquals(emptyList<String>(), refused.written)
        val standinRefused = shook.copy(failure = TlsFailure.STANDIN_REFUSED)
        assertEquals(standinRefused.copy(clientCertAccepted = false) to null, refused.shake)
        for (late in listOf(Run(hello, error), Run(hello))) {
            assertEquals(listOf(Frames.ekm(ekm).trimEnd()), late.written)
            assertEquals(standinRefused.copy(clientCertAccepted = true) to null, late.shake)
        }
        val noEkm = Run(hello, equal, export = null)
        assertEquals(emptyList<String>(), noEkm.written)
        assertEquals(TlsFailure.OTHER, noEkm.shake.first.failure)
        // A connection that breaks after hello.
        val broken = object : InputStream() {
            private val bytes = "$hello\n".byteInputStream()
            override fun read() = bytes.read().takeIf { it >= 0 } ?: throw IOException("reset")
        }
        val reset = Run(input = broken)
        val (resetShake) = reset.shake
        assertEquals(TlsFailure.OTHER to true, resetShake.failure to resetShake.clientCertAccepted)
        for (run in listOf(differs, refused, noEkm, reset)) {
            assertEquals(emptyList<Handshake>(), run.made)
        }
    }

    @Test
    fun `a dial's error gives the stand-in's reach`() {
        assertEquals(Reach.OK, reachOf(null))
        assertEquals(Reach.TIMEOUT, reachOf(SocketTimeoutException("connect timed out")))
        val blocked = ConnectException("connect failed: EPERM (Operation not permitted)")
        assertEquals(Reach.BLOCKED, reachOf(blocked))
        assertEquals(Reach.BLOCKED, reachOf(IOException("EACCES (Permission denied)")))
        assertEquals(Reach.REFUSED, reachOf(ConnectException("ECONNREFUSED (Connection refused)")))
    }

    @Test
    fun `the result is ok for StrongBox or TEE keys, fallback for the wrapped key, else failed`() {
        val ok = section(listOf(missing, digest, tee), connected)
        val key = ok.fields("result", "keyClass", "keyDigests")
        assertEquals(listOf("ok", "tee", listOf("NONE", "SHA-256")), key)
        val failures = (ok["attempts"] as List<*>).map { (it as Map<*, *>)["failure"] }
        assertEquals(listOf("strongbox-missing", "keystore-digest", null), failures)
        val facts = ok.fields("serverPinMatched", "clientCertAccepted", "ekmEqual", "protocol")
        assertEquals(listOf(true, true, true, "TLSv1.3", 180L), facts + ok["handshakeMs"])
        assertFalse(ok.containsKey("fallbackReason"))

        val software = TlsAttempt(KeyClass.KEYSTORE_WRAPPED_SOFTWARE, AttemptResult.OK)
        val handshake = TlsAttempt(KeyClass.TEE, failed, noneSha256, TlsFailure.HANDSHAKE)
        val fallback = section(listOf(missing, digest, handshake, software), connected)
        assertEquals(
            listOf("fallback", "handshake", "keystore-wrapped-software", null),
            fallback.fields("result", "fallbackReason", "keyClass", "keyDigests"),
        )

        val pinAttempt = TlsAttempt(KeyClass.TEE, failed, sha256, TlsFailure.SERVER_PIN)
        val pin = section(listOf(pinAttempt), Handshake(TlsFailure.SERVER_PIN, false))
        val pinFields = pin.fields("result", "keyClass", "serverPinMatched")
        assertEquals(listOf("failed", null, false), pinFields)
        assertEquals("failed", section(emptyList(), null)["result"])
        // An EKM that differs still means mTLS worked; the report says so.
        val unequal = section(listOf(tee), connected.copy(ekmEqual = false))
        assertEquals("ok" to false, unequal["result"] to unequal["ekmEqual"])
    }

    @Test
    fun `frames - hello gives 16 pid bytes and the EKM frame carries only the SHA-256 hex`() {
        val pid = ByteArray(16) { (it * 17).toByte() }
        val url = Base64.getUrlEncoder().withoutPadding()
        val hello = { v: Int, bytes: ByteArray ->
            frame("\"t\":\"hello\"", "\"v\":$v", "\"pid\":\"${url.encodeToString(bytes)}\"")
        }
        assertArrayEquals(pid, Frames.pid(hello(1, pid)))
        val error = frame("\"t\":\"error\"")
        for (line in listOf(hello(2, pid), hello(1, pid.copyOf(15)), error, "hello", "", null)) {
            assertNull(line, Frames.pid(line))
        }
        val exported = ByteArray(32) { (it * 7).toByte() }
        val hash = MessageDigest.getInstance("SHA-256").digest(exported)
        val hex = hash.joinToString("") { "%02x".format(it) }
        assertEquals(frame("\"t\":\"ekm\"", "\"sha256\":\"$hex\"") + "\n", Frames.ekm(exported))
        assertEquals(true, Frames.equal(frame("\"t\":\"ekm\"", "\"equal\":true")))
        assertEquals(false, Frames.equal(frame("\"t\":\"ekm\"", "\"equal\":false")))
        assertNull(Frames.equal(error))
        assertNull(Frames.equal(null))
        val reply = frame("\"t\":\"report\"", "\"valid\":true", "\"written\":false")
        assertEquals(true to false, Frames.reportReply(reply))
        assertNull(Frames.reportReply(error))
        val report = Frames.report(Reports.full())
        assertTrue(report.startsWith("{\"t\":\"report\",\"report\":{\"schema\":"))
        assertEquals(listOf(report.length - 1), report.indices.filter { report[it] == '\n' })
        val sent = (Json.parse(report) as Map<*, *>)["report"]
        assertEquals(Json.parse(Reports.full().toJson()), sent)
    }

    @Test
    fun `the stored TLS result reads back the same`() {
        val store = MapStore()
        assertNull(TlsStore.load(store))
        val ours = tlsSection(listOf(missing, digest, tee), connected)
        val sections = listOf(Reports.full().tls!!, ours)
        for (tls in sections) {
            TlsStore.save(store, tls)
            assertEquals(tls.json(), TlsStore.load(store)!!.json())
        }
        store["tls"] = frame("\"result\":\"maybe\"")
        assertNull(TlsStore.load(store))
    }

    @Test
    fun `the wrapped software key's self-signed certificate parses and verifies`() {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val der = SelfSigned.certificate(pair)
        val factory = CertificateFactory.getInstance("X.509")
        val cert = factory.generateCertificate(der.inputStream()) as X509Certificate
        cert.verify(pair.public)
        assertArrayEquals(der, cert.encoded)
        assertEquals("CN=DraftYak S12 probe", cert.subjectX500Principal.name)
        assertEquals(cert.subjectX500Principal, cert.issuerX500Principal)
        assertEquals("SHA256withECDSA" to 3, cert.sigAlgName to cert.version)
        assertEquals(pair.public, cert.publicKey)
        assertEquals(Instant.parse("2026-01-01T00:00:00Z"), cert.notBefore.toInstant())
        assertEquals(Instant.parse("2049-12-31T23:59:59Z"), cert.notAfter.toInstant())
    }

    @Test
    fun `stand-in hosts are loopback, LAN or tailnet, and connect dials only the listed ones`() {
        assertEquals(HostKind.LOOPBACK, Standin.kind("127.0.0.1"))
        val lan = listOf("192.168.1.20", "10.0.0.5", "172.16.4.2", "100.63.1.1", "fe80::1", "fd::5")
        for (host in lan) assertEquals(host, HostKind.LAN, Standin.kind(host))
        val tailnet = listOf("100.64.0.1", "100.127.0.9", "fd7a:115c:a1e0::5", "FD7A:115C:A1E0::1")
        for (host in tailnet) assertEquals(host, HostKind.TAILNET, Standin.kind(host))
        for (host in listOf("10.0.2.2", "localhost", "example.org")) {
            Socket().use { socket ->
                assertThrows(IllegalArgumentException::class.java) {
                    Standin.connect(socket, host, 4242, 1_000)
                }
                assertFalse(socket.isConnected)
            }
        }
    }
}
