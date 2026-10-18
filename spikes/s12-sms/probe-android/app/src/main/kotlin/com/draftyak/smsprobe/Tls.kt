package com.draftyak.smsprobe

import android.net.ssl.SSLSockets
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedKeyManager
import javax.security.auth.x500.X500Principal

const val EKM_LABEL = "EXPERIMENTAL-draftyak-pair-v1"
const val EKM_LENGTH = 32
private const val KEYSTORE = "AndroidKeyStore"
private const val GCM = "AES/GCM/NoPadding"

// Tried in order until one completes mTLS: StrongBox, then the TEE, each with SHA-256 only and
// then with NONE too (Conscrypt may sign the handshake digest with NONEwithECDSA), then the
// Keystore-wrapped software key.
class KeyPlan(val keyClass: KeyClass, val digests: List<KeyDigest>)

val KEY_PLANS: List<KeyPlan> = listOf(KeyClass.STRONGBOX, KeyClass.TEE).flatMap { keyClass ->
    listOf(listOf(KeyDigest.SHA_256), listOf(KeyDigest.NONE, KeyDigest.SHA_256))
        .map { KeyPlan(keyClass, it) }
} + KeyPlan(KeyClass.KEYSTORE_WRAPPED_SOFTWARE, emptyList())

// One connection as far as it got; no failure means mTLS completed and the EKM frame was answered.
data class Handshake(
    val failure: TlsFailure? = null,
    val serverPinMatched: Boolean? = null,
    val clientCertAccepted: Boolean? = null,
    val ekmEqual: Boolean? = null,
    val protocol: TlsProtocol? = null,
    val cipherSuite: CipherSuite? = null,
    val handshakeMs: Long? = null,
)

// ok when a StrongBox or TEE key worked, fallback when only the wrapped software key did (with the
// last failure before it), failed otherwise. Never the EKM or any hash.
fun tlsSection(attempts: List<TlsAttempt>, last: Handshake?): Tls {
    val ok = attempts.lastOrNull()?.takeIf { it.result == AttemptResult.OK }
    val result = when (ok?.keyClass) {
        null -> TlsResult.FAILED
        KeyClass.STRONGBOX, KeyClass.TEE -> TlsResult.OK
        else -> TlsResult.FALLBACK
    }
    val reason = attempts.lastOrNull { it.failure != null }?.failure ?: TlsFailure.OTHER
    return Tls(
        result, reason.takeIf { result == TlsResult.FALLBACK }, ok?.keyClass, ok?.keyDigests,
        attempts, last?.protocol, last?.cipherSuite, last?.serverPinMatched,
        last?.clientCertAccepted, last?.ekmEqual, last?.handshakeMs,
    )
}

// hub-standin's line-delimited JSON (its header has the protocol).
object Frames {
    fun pid(line: String?): ByteArray? = runCatching {
        val frame = Json.parse(line!!) as Map<*, *>
        require(frame["t"] == "hello" && frame["v"] == 1L)
        Base64.getUrlDecoder().decode(frame["pid"] as String).takeIf { it.size == 16 }
    }.getOrNull()

    fun ekm(exported: ByteArray): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(exported)
        val hex = hash.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        return "{\"t\":\"ekm\",\"sha256\":\"$hex\"}\n"
    }

    fun equal(line: String?): Boolean? = flag(line, "ekm", "equal")
    fun report(report: Report): String = "{\"t\":\"report\",\"report\":${report.toJson()}}\n"

    fun reportReply(line: String?): Pair<Boolean, Boolean>? =
        flag(line, "report", "valid")?.let { it to (flag(line, "report", "written") == true) }

    private fun flag(line: String?, t: String, key: String): Boolean? = runCatching {
        (Json.parse(line!!) as Map<*, *>).takeIf { it["t"] == t }?.get(key) as Boolean?
    }.getOrNull()
}

// The last TLS section, kept as its JSON.
object TlsStore {
    fun save(store: Store, tls: Tls) = store.set("tls", tls.json())

    fun load(store: Store): Tls? =
        runCatching { decode(Json.parse(store["tls"]!!) as Map<*, *>) }.getOrNull()

    private inline fun <reified E> enum(value: Any?): E? where E : Enum<E>, E : Wire =
        enumValues<E>().firstOrNull { it.wire == value }

    private fun digests(value: Any?) = (value as List<*>?)?.map { enum<KeyDigest>(it)!! }

    private fun attempt(it: Map<*, *>) = TlsAttempt(
        enum<KeyClass>(it["keyClass"])!!, enum<AttemptResult>(it["result"])!!,
        digests(it["keyDigests"]), enum<TlsFailure>(it["failure"]),
    )

    private fun decode(tls: Map<*, *>) = Tls(
        enum<TlsResult>(tls["result"])!!, enum<TlsFailure>(tls["fallbackReason"]),
        enum<KeyClass>(tls["keyClass"]), digests(tls["keyDigests"]),
        (tls["attempts"] as List<*>?)?.map { attempt(it as Map<*, *>) },
        enum<TlsProtocol>(tls["protocol"]), enum<CipherSuite>(tls["cipherSuite"]),
        tls["serverPinMatched"] as Boolean?, tls["clientCertAccepted"] as Boolean?,
        tls["ekmEqual"] as Boolean?, tls["handshakeMs"] as Long?,
    )
}

// A self-signed DER certificate for the software key; Keystore certifies only its own keys.
object SelfSigned {
    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    private fun der(tag: Int, vararg parts: ByteArray): ByteArray {
        val body = parts.fold(ByteArray(0)) { all, part -> all + part }
        val size = body.size
        val length = when {
            size < 0x80 -> bytes(size)
            size < 0x100 -> bytes(0x81, size)
            else -> bytes(0x82, size shr 8, size and 0xff)
        }
        return bytes(tag) + length + body
    }

    private fun text(tag: Int, value: String) = der(tag, value.toByteArray())

    fun certificate(pair: KeyPair): ByteArray {
        val algorithm = der(0x30, der(0x06, bytes(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02)))
        val cn = der(0x30, der(0x06, bytes(0x55, 0x04, 0x03)), text(0x0c, "DraftYak S12 probe"))
        val name = der(0x30, der(0x31, cn))
        val validity = der(0x30, text(0x17, "260101000000Z"), text(0x17, "491231235959Z"))
        val version = der(0xa0, der(0x02, bytes(2)))
        val serial = der(0x02, bytes(1))
        val tbs = der(0x30, version, serial, algorithm, name, validity, name, pair.public.encoded)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(pair.private)
            update(tbs)
            sign()
        }
        return der(0x30, tbs, algorithm, der(0x03, bytes(0) + signature))
    }
}

class ProbeKeyManager(private val key: PrivateKey, private val chain: Array<X509Certificate>) :
    X509ExtendedKeyManager() {
    override fun chooseClientAlias(k: Array<String>?, i: Array<Principal>?, s: Socket?) = "probe"
    override fun chooseEngineClientAlias(k: Array<String>?, i: Array<Principal>?, e: SSLEngine?) =
        "probe"
    override fun getClientAliases(k: String?, i: Array<Principal>?) = arrayOf("probe")
    override fun getServerAliases(k: String?, i: Array<Principal>?): Array<String>? = null
    override fun chooseServerAlias(k: String?, i: Array<Principal>?, s: Socket?): String? = null
    override fun getCertificateChain(alias: String?) = chain
    override fun getPrivateKey(alias: String?) = key
}

// tls is null when the stand-in wasn't reached before any handshake.
class TlsRun(val tls: Tls?, val reportReply: Pair<Boolean, Boolean>?)

class TlsKey(
    val key: PrivateKey,
    val chain: Array<X509Certificate>,
    val keyClass: KeyClass,
    val digests: List<KeyDigest>?,
)

typealias Shake = Pair<Handshake, Pair<Boolean, Boolean>?>

private fun Throwable.causes() = generateSequence(this) { it.cause }

// Keys in KEY_PLANS order until one completes mTLS and the EKM exchange: a missing StrongBox is
// tried once, and a rejected server identity or another failure stops. connect gives null when the
// stand-in isn't reached, which stops too.
fun tryKeys(
    key: (KeyPlan) -> Pair<TlsKey?, TlsFailure?>,
    connect: (TlsKey, (Handshake) -> Report?) -> Shake?,
    report: (Tls) -> Report?,
): TlsRun {
    val attempts = mutableListOf<TlsAttempt>()
    var last: Handshake? = null
    var reply: Pair<Boolean, Boolean>? = null
    for (plan in KEY_PLANS) {
        val missing = attempts.any { it.failure == TlsFailure.STRONGBOX_MISSING }
        if (plan.keyClass == KeyClass.STRONGBOX && missing) continue
        val (tlsKey, keyFailure) = key(plan)
        if (tlsKey == null) {
            val digests = plan.digests.ifEmpty { null }
            attempts += TlsAttempt(plan.keyClass, AttemptResult.FAILED, digests, keyFailure)
            continue
        }
        val ok = TlsAttempt(tlsKey.keyClass, AttemptResult.OK, tlsKey.digests)
        val (handshake, answer) = connect(tlsKey) { report(tlsSection(attempts + ok, it)) }
            ?: return TlsRun(last?.let { tlsSection(attempts, it) }, reply)
        last = handshake
        reply = answer
        val failure = handshake.failure
        val result = if (failure == null) AttemptResult.OK else AttemptResult.FAILED
        attempts += TlsAttempt(tlsKey.keyClass, result, tlsKey.digests, failure)
        if (failure in setOf(null, TlsFailure.SERVER_PIN, TlsFailure.OTHER)) break
    }
    return TlsRun(tlsSection(attempts, last), reply)
}

// After the handshake: hello comes only once the stand-in accepted the client certificate; then
// the EKM's hash and the stand-in's verdict, and the report only after an equal EKM.
fun exchange(
    input: InputStream,
    output: OutputStream,
    export: (ByteArray) -> ByteArray?,
    shook: Handshake,
    make: (Handshake) -> Report?,
): Shake {
    var done = shook
    return runCatching {
        val pid = Frames.pid(readLine(input)) ?: return done.copy(
            failure = TlsFailure.STANDIN_REFUSED, clientCertAccepted = false,
        ) to null
        done = done.copy(clientCertAccepted = true)
        val ekm = export(pid) ?: return done.copy(failure = TlsFailure.OTHER) to null
        output.write(Frames.ekm(ekm).toByteArray(Charsets.UTF_8))
        val equal = Frames.equal(readLine(input))
            ?: return done.copy(failure = TlsFailure.STANDIN_REFUSED) to null
        done = done.copy(ekmEqual = equal)
        // mTLS worked; the report is extra. The stand-in closes after an unequal EKM.
        val frame = (if (equal) runCatching { make(done) }.getOrNull() else null)
            ?: return done to null
        done to runCatching {
            output.write(Frames.report(frame).toByteArray(Charsets.UTF_8))
            Frames.reportReply(readLine(input))
        }.getOrNull()
    }.getOrElse {
        val accepted = done.clientCertAccepted ?: false
        val failure = if (accepted) TlsFailure.OTHER else TlsFailure.STANDIN_REFUSED
        done.copy(failure = failure, clientCertAccepted = accepted) to null
    }
}

// A dial's outcome for network.lanStandin or tailnetStandin; a timeout is InterruptedIOException.
fun reachOf(error: Throwable?): Reach {
    val message = error?.message.orEmpty()
    return when {
        error == null -> Reach.OK
        error is InterruptedIOException -> Reach.TIMEOUT
        "EPERM" in message || "EACCES" in message -> Reach.BLOCKED
        else -> Reach.REFUSED
    }
}

private fun readLine(input: InputStream): String? {
    val line = ByteArrayOutputStream()
    while (line.size() <= 65_536) {
        val next = input.read()
        if (next < 0) return null
        if (next == '\n'.code) return line.toString("UTF-8")
        line.write(next)
    }
    return null
}

// The Conscrypt TLS 1.3 mTLS client for hub-standin: it dials only through Standin.connect(),
// trusts what network_security_config.xml trusts for the host (the default trust manager) and
// checks the host name. Keys keep fixed aliases, so a later stand-in can pin the same client key.
// `reached` gets the first dial's outcome.
class TlsProbe(private val files: File, private val reached: (Reach) -> Unit) {
    private val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    private var dialed = false

    // `report` builds the report sent, with this run's TLS section, over the first connection that
    // completes mTLS and the EKM exchange.
    fun run(host: String, port: Int, report: (Tls) -> Report?): TlsRun = tryKeys(
        { plan -> runCatching { key(plan) to null }.getOrElse { null to keyFailure(it) } },
        { key, make -> connect(host, port, key, make) },
        report,
    )

    private fun connect(
        host: String, port: Int, key: TlsKey, make: (Handshake) -> Report?,
    ): Shake? {
        val plain = Socket()
        val error = runCatching { Standin.connect(plain, host, port, 10_000) }.exceptionOrNull()
        if (!dialed) reached(reachOf(error))
        dialed = true
        if (error != null) return null.also { plain.close() }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        trust.init(null as KeyStore?)
        val context = SSLContext.getInstance("TLSv1.3")
        context.init(arrayOf(ProbeKeyManager(key.key, key.chain)), trust.trustManagers, null)
        (context.socketFactory.createSocket(plain, host, port, true) as SSLSocket).use { socket ->
            socket.enabledProtocols = arrayOf("TLSv1.3")
            socket.sslParameters =
                socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            socket.soTimeout = 15_000
            val started = SystemClock.elapsedRealtime()
            runCatching { socket.startHandshake() }.exceptionOrNull()?.let {
                val failure = failure(it, key)
                return Handshake(failure, false.takeIf { failure == TlsFailure.SERVER_PIN }) to null
            }
            val session = socket.session
            val done = Handshake(
                serverPinMatched = true,
                protocol = TlsProtocol.entries.firstOrNull { it.wire == session.protocol }
                    ?: TlsProtocol.OTHER,
                cipherSuite = CipherSuite.entries.firstOrNull { it.wire == session.cipherSuite }
                    ?: CipherSuite.OTHER,
                handshakeMs = SystemClock.elapsedRealtime() - started,
            )
            val export = { pid: ByteArray ->
                SSLSockets.exportKeyingMaterial(socket, EKM_LABEL, pid, EKM_LENGTH)
            }
            return exchange(socket.inputStream.buffered(), socket.outputStream, export, done, make)
        }
    }

    private fun keyFailure(error: Throwable) =
        if (error.causes().any { it is StrongBoxUnavailableException }) TlsFailure.STRONGBOX_MISSING
        else TlsFailure.KEYSTORE_SIGNING

    // A rejected server identity (pin, anchor or host name) is a CertificateException; a Keystore
    // key without NONE that fails the handshake is taken as Conscrypt needing NONEwithECDSA.
    private fun failure(error: Throwable, key: TlsKey): TlsFailure {
        val identity = error.causes().any { it is CertificateException }
        return when {
            identity -> TlsFailure.SERVER_PIN
            key.digests != null && KeyDigest.NONE !in key.digests -> TlsFailure.KEYSTORE_DIGEST
            else -> TlsFailure.HANDSHAKE
        }
    }

    private fun key(plan: KeyPlan): TlsKey {
        if (plan.keyClass == KeyClass.KEYSTORE_WRAPPED_SOFTWARE) return softwareKey()
        val digests = plan.digests.joinToString("-") { it.wire.lowercase() }
        val alias = "tls-${plan.keyClass.wire}-$digests"
        if (!keyStore.containsAlias(alias)) {
            val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(*plan.digests.map { it.wire }.toTypedArray())
                .setIsStrongBoxBacked(plan.keyClass == KeyClass.STRONGBOX)
                .setCertificateSubject(X500Principal("CN=DraftYak S12 probe"))
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
                initialize(spec)
                generateKeyPair()
            }
        }
        val key = keyStore.getKey(alias, null) as PrivateKey
        val info = KeyFactory.getInstance(key.algorithm, KEYSTORE)
            .getKeySpec(key, KeyInfo::class.java)
        val keyClass = when (info.securityLevel) {
            KeyProperties.SECURITY_LEVEL_STRONGBOX -> KeyClass.STRONGBOX
            KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> KeyClass.TEE
            KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> KeyClass.TEE
            else -> KeyClass.SOFTWARE
        }
        val chain = arrayOf(keyStore.getCertificate(alias) as X509Certificate)
        return TlsKey(key, chain, keyClass, plan.digests)
    }

    // A software P-256 key whose PKCS#8 bytes are stored only encrypted under an AndroidKeyStore
    // AES-GCM key, beside its self-signed certificate, in the probe's private files.
    private fun softwareKey(): TlsKey {
        val wrapped = File(files, "tls-software.key")
        val certificate = File(files, "tls-software.der")
        val wrapKey = keyStore.getKey("tls-wrap", null) as SecretKey?
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
                val purposes = KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                init(
                    KeyGenParameterSpec.Builder("tls-wrap", purposes).setKeySize(256)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build(),
                )
                generateKey()
            }
        if (!wrapped.exists() || !certificate.exists()) {
            val pair = KeyPairGenerator.getInstance("EC").run {
                initialize(ECGenParameterSpec("secp256r1"))
                generateKeyPair()
            }
            val cipher = Cipher.getInstance(GCM).apply { init(Cipher.ENCRYPT_MODE, wrapKey) }
            wrapped.writeBytes(cipher.iv + cipher.doFinal(pair.private.encoded))
            certificate.writeBytes(SelfSigned.certificate(pair))
        }
        val bytes = wrapped.readBytes()
        val cipher = Cipher.getInstance(GCM)
        cipher.init(Cipher.DECRYPT_MODE, wrapKey, GCMParameterSpec(128, bytes, 0, 12))
        val pkcs8 = PKCS8EncodedKeySpec(cipher.doFinal(bytes, 12, bytes.size - 12))
        val cert = certificate.inputStream().use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        val key = KeyFactory.getInstance("EC").generatePrivate(pkcs8)
        return TlsKey(key, arrayOf(cert), KeyClass.KEYSTORE_WRAPPED_SOFTWARE, null)
    }
}
