package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.util.Base64

class NetworkSecurityConfigTest {
    private val res = TestFiles.path("resources")
    private val config = parseXml(File(res, "xml/network_security_config.xml"))
    private val cert = File(res, "raw/standin_cert.pem").inputStream().use {
        CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
    }

    // A debug or qualified copy, or a values alias, would ship instead of the files checked here.
    // The heavy test checks the copies in the APK.
    @Test
    fun `no other resource folder of the variant provides the config or the certificate`() {
        val dirs = TestFiles.paths("resourceDirs").map(File::getCanonicalFile).distinct()
        assertTrue(dirs.toString(), res.canonicalFile in dirs)
        val names = listOf("network_security_config", "standin_cert")
        val found = dirs.flatMap { dir ->
            dir.walk().filter { file ->
                file.isFile && (file.nameWithoutExtension in names ||
                    names.any { it in file.readBytes().toString(Charsets.ISO_8859_1) })
            }.map(File::getCanonicalFile).toList()
        }
        val expected = listOf("raw/standin_cert.pem", "xml/network_security_config.xml")
        assertEquals(expected.map { File(res, it).canonicalFile }.toSet(), found.toSet())
        assertEquals(expected.size, found.size)
    }

    @Test
    fun `no cleartext and no system or user trust anchors in the base config`() {
        val base = config.children("base-config").single()
        assertEquals("false", base.getAttribute("cleartextTrafficPermitted"))
        assertEquals(1, base.children("trust-anchors").size)
        assertEquals(0, base.children("certificates").size)
        assertEquals(0, config.children("debug-overrides").size)
    }

    @Test
    fun `only the stand-in's hosts trust only its bundled certificate, pinned to its key`() {
        val domain = config.children("domain-config").single()
        assertEquals("false", domain.getAttribute("cleartextTrafficPermitted"))
        val hosts = domain.children("domain").map { it.textContent.trim() }
        assertEquals(Standin.hosts, hosts)
        val subdomains = domain.children("domain").map { it.getAttribute("includeSubdomains") }
        assertEquals(hosts.map { "false" }, subdomains)
        val anchors = domain.children("certificates").map { it.getAttribute("src") }
        assertEquals(listOf("@raw/standin_cert"), anchors)
        val pins = domain.children("pin").map { it.getAttribute("digest") to it.textContent.trim() }
        val spki = MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
        assertEquals(listOf("SHA-256" to Base64.getEncoder().encodeToString(spki)), pins)
    }

    @Test
    fun `the bundled certificate is hub-standin's public P-256 certificate for loopback`() {
        assertEquals("CN=DraftYak S12 hub stand-in", cert.subjectX500Principal.name)
        val curve = (cert.publicKey as ECPublicKey).params.toString().substringBefore(' ')
        assertEquals("secp256r1", curve)
        val sans = cert.subjectAlternativeNames.map { it[1].toString() }
        assertTrue(sans.toString(), "127.0.0.1" in sans)
        val pem = File(res, "raw/standin_cert.pem").readText()
        val blocks = Regex("-----BEGIN ([A-Z ]+)-----").findAll(pem).map { it.groupValues[1] }
        assertEquals(listOf("CERTIFICATE"), blocks.toList())
    }

    @Test
    fun `sockets go only to the stand-in host and never to a reserved port`() {
        assertEquals(4242, Standin.address("127.0.0.1", 4242).port)
        for (host in listOf("10.0.2.2", "localhost", "::1", "example.org", "")) {
            assertThrows(IllegalArgumentException::class.java) { Standin.address(host, 4242) }
        }
        for (port in listOf(0, 9229, 47613, 47614, 47615, 65_536)) {
            assertThrows(IllegalArgumentException::class.java) {
                Standin.address("127.0.0.1", port)
            }
        }
    }
}
