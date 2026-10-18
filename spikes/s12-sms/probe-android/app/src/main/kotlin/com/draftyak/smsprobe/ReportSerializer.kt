package com.draftyak.smsprobe

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

// spikes/s12-sms/schema/probe-report.v1.json (M0.36) as Kotlin types, and the only way the probe
// writes a report. Every field is an enum, a checked value class, a clamped number or a boolean;
// there is no generic map or string field. Text read on the phone reaches a report only as the
// DytestBody of a TestMessage, which exists only for rows from the owner-entered second number.

const val REPORT_SCHEMA = "draftyak.s12.probe-report.v1"
const val ENCODING_CHECK = "\u00e9\u20ac\ud83d\udc4d"
const val VECTORS_FORMAT = "draftyak.s12.sms-segments.v1"

interface Wire {
    val wire: String
}

// Most schema enums are their entry names in lower case with dashes.
interface Kebab : Wire {
    val name: String
    override val wire get() = name.lowercase(Locale.ROOT).replace('_', '-')
}

enum class Manufacturer(override val wire: String) : Wire {
    GOOGLE("Google"), SAMSUNG("samsung"), ONEPLUS("OnePlus"), XIAOMI("Xiaomi"),
    MOTOROLA("motorola"), NOTHING("Nothing"), FAIRPHONE("Fairphone"), SONY("Sony"), OPPO("OPPO"),
    VIVO("vivo"), HMD_GLOBAL("HMD Global"), ASUS("asus"), REALME("realme"), HONOR("HONOR"),
    OTHER("other");

    companion object {
        // Build.MANUFACTURER, compared without case; an unlisted maker is "other".
        fun of(manufacturer: String): Manufacturer =
            entries.firstOrNull { it.wire.equals(manufacturer.trim(), ignoreCase = true) } ?: OTHER
    }
}

enum class SmsFormat(override val wire: String) : Wire {
    THREE_GPP("3gpp"), THREE_GPP2("3gpp2"), UNKNOWN("unknown")
}

enum class ProviderTable : Kebab {
    SMS, MMS, MMS_PART, MMS_ADDR, THREADS, CONVERSATIONS, COMPLETE_CONVERSATIONS,
    CANONICAL_ADDRESSES, OTHER
}

enum class ProviderFailure : Kebab {
    SECURITY, NOT_FOUND, OTHER
}

enum class RcsIdMethod : Kebab {
    MMS_TRANSACTION_ID, MMS_CONTENT_TYPE, COLUMN, NONE, UNKNOWN
}

enum class Tri : Kebab {
    YES, NO, UNKNOWN
}

enum class VectorId : Kebab {
    GSM7_SINGLE_160, GSM7_MULTI_161, GSM7_MULTI_306, GSM7_NEWLINE, GSM7_EXT_SINGLE_160,
    GSM7_EXT_OVERFLOW_161, GSM7_EXT_STRADDLE, GSM7_EXT_FILLS_PART, GSM7_EXT_EXTRA_PART,
    GSM7_EXT_ONLY_SINGLE, GSM7_EXT_ONLY_MULTI, GSM7_TEN_PARTS, GSM7_ELEVEN_PARTS, UCS2_SINGLE_70,
    UCS2_MULTI_71, UCS2_SURROGATE_STRADDLE, UCS2_FLAG_STRADDLE, UCS2_FLAG_RUN,
    UCS2_SKIN_TONE_STRADDLE, UCS2_KEYCAP_STRADDLE, UCS2_ZWJ_STRADDLE, UCS2_NFD_MARK_STRADDLE,
    UCS2_LONG_CLUSTER, UCS2_LONG_ZWJ_SURROGATE, UCS2_EMOJI_RUN, NFC_CAFE, NFD_CAFE, NATIONAL_TR,
    NATIONAL_ES, NATIONAL_TR_MULTI, FORCE7BIT_QUOTES, FORCE7BIT_EMOJI, FORCE7BIT_ACCENTS,
    ASCII_BACKTICK
}

enum class VectorMatch(override val wire: String) : Wire {
    EXPECTED("expected"), TR("tr"), ES("es"), FORCE7BIT("force7bit"), THREE_GPP2("3gpp2"),
    NONE("none")
}

enum class SmsEncoding : Kebab {
    GSM7, UCS2
}

enum class DeliveryResult : Kebab {
    DELIVERED, FAILED, PENDING, NONE
}

enum class Scenario : Kebab {
    DOZE_FORCED, DOZE_NATURAL, APP_STANDBY, AFTER_BOOT, AFTER_KILL, AFTER_FORCE_STOP
}

enum class TlsResult : Kebab {
    OK, FALLBACK, FAILED
}

enum class AttemptResult : Kebab {
    OK, FAILED
}

enum class TlsFailure : Kebab {
    KEYSTORE_SIGNING, KEYSTORE_DIGEST, STRONGBOX_MISSING, HANDSHAKE, SERVER_PIN, STANDIN_REFUSED,
    OTHER
}

enum class KeyClass : Kebab {
    STRONGBOX, TEE, KEYSTORE_WRAPPED_SOFTWARE, SOFTWARE
}

enum class KeyDigest : Wire {
    NONE, MD5, SHA_1, SHA_224, SHA_256, SHA_384, SHA_512;

    override val wire get() = name.replace('_', '-')
}

enum class TlsProtocol(override val wire: String) : Wire {
    TLS_1_3("TLSv1.3"), TLS_1_2("TLSv1.2"), OTHER("other")
}

enum class CipherSuite(override val wire: String) : Wire {
    TLS_AES_128_GCM_SHA256("TLS_AES_128_GCM_SHA256"),
    TLS_AES_256_GCM_SHA384("TLS_AES_256_GCM_SHA384"),
    TLS_CHACHA20_POLY1305_SHA256("TLS_CHACHA20_POLY1305_SHA256"),
    OTHER("other"),
}

enum class LocalNetworkPermission : Kebab {
    GRANTED, DENIED, NOT_REQUESTED
}

enum class Reach : Kebab {
    OK, REFUSED, TIMEOUT, BLOCKED, NOT_TESTED
}

enum class WebOtp : Kebab {
    OFFERED, NOT_OFFERED, NOT_TESTED
}

enum class InstallPath : Kebab {
    ADB, BROWSER, FILE_MANAGER, F_DROID
}

enum class RestrictedSettings : Kebab {
    NOT_NEEDED, NEEDED, BLOCKED, NOT_TESTABLE
}

enum class PlayProtect : Kebab {
    NO_PROMPT, WARNED, BLOCKED, NOT_TESTABLE
}

enum class AdvancedProtection : Kebab {
    ON, OFF, NOT_AVAILABLE
}

enum class Transport : Kebab {
    SMS, MMS, RCS, UNKNOWN
}

enum class Direction : Kebab {
    INBOUND, OUTBOUND
}

private fun isRealDate(year: String, month: String, day: String) =
    runCatching { LocalDate.parse("$year-$month-$day") }.isSuccess

@JvmInline
value class ProbeVersion private constructor(val text: String) {
    companion object {
        val CURRENT = ProbeVersion("0.2.0")
    }
}

@JvmInline
value class UtcTime private constructor(val text: String) {
    companion object {
        private val FORMAT = DateTimeFormatter
            .ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
            .withZone(ZoneOffset.UTC)

        fun of(epochMillis: Long): UtcTime? {
            val instant = Instant.ofEpochMilli(epochMillis)
            val year = instant.atOffset(ZoneOffset.UTC).year
            return if (year in 2020..2099) UtcTime(FORMAT.format(instant)) else null
        }
    }
}

// Build.VERSION.RELEASE and the like: up to three numbers of one or two digits.
@JvmInline
value class ShortVersion private constructor(val text: String) {
    companion object {
        private val SHAPE = Regex("[0-9]{1,2}(?:\\.[0-9]{1,2}){0,2}")

        fun of(raw: String?): ShortVersion? = raw?.takeIf(SHAPE::matches)?.let(::ShortVersion)
    }
}

// Build.VERSION.SECURITY_PATCH: a real 20[2-9]x date.
@JvmInline
value class DateVersion private constructor(val text: String) {
    companion object {
        private val SHAPE = Regex("(20[2-9][0-9])-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])")

        fun of(raw: String?): DateVersion? {
            val (year, month, day) = SHAPE.matchEntire(raw ?: return null)?.destructured
                ?: return null
            return if (isRealDate(year, month, day)) DateVersion(raw) else null
        }
    }
}

// Build.ID: a codename, a real YYMMDD build date, a build number and an optional variant.
@JvmInline
value class BuildVersion private constructor(val text: String) {
    companion object {
        private val SHAPE = Regex(
            "[A-Z]{2}[A-Z0-9]{2}\\.(2[0-9])(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])" +
                "\\.[0-9]{3}(?:\\.[A-Z][0-9])?",
        )

        fun of(raw: String?): BuildVersion? {
            val (year, month, day) = SHAPE.matchEntire(raw ?: return null)?.destructured
                ?: return null
            return if (isRealDate("20$year", month, day)) BuildVersion(raw) else null
        }
    }
}

// Google Messages' versionName cut to messages.android_YYYYMMDD_NN_RCNN, with a real date.
@JvmInline
value class MessagesVersion private constructor(val text: String) {
    companion object {
        private val SHAPE = Regex(
            "messages\\.android_(20[2-9][0-9])(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])" +
                "_[0-9]{2}_RC[0-9]{2}",
        )

        fun fromVersionName(versionName: String?): MessagesVersion? {
            val match = SHAPE.find(versionName ?: return null)?.takeIf { it.range.first == 0 }
                ?: return null
            val (year, month, day) = match.destructured
            return if (isRealDate(year, month, day)) MessagesVersion(match.value) else null
        }
    }
}

// A provider column name from Cursor.getColumnNames(). A name that could carry a number, a code or
// a hash (3 or more digits, or 8 hex characters in a row) is dropped, never sent.
@JvmInline
value class ColumnName private constructor(val text: String) {
    companion object {
        private val SHAPE = Regex("_?[a-z][a-z0-9_]{0,46}")
        private val HEX_RUN = Regex("[0-9a-f]{8}")

        fun of(name: String): ColumnName? = name.takeIf {
            SHAPE.matches(it) && it.count { c -> c in '0'..'9' } <= 2 &&
                !HEX_RUN.containsMatchIn(it)
        }?.let(::ColumnName)

        fun list(names: Array<String>): List<ColumnName> = names.mapNotNull(::of).distinct()
    }
}

// The owner's own test text: DYTEST-, at most 120 code points and 3 numerals of any script, no @
// or its look-alikes, no URL markers, and no control or format characters except LF and ZWJ.
// receive-report also applies the kit's content rules, so a kept body holding the dev box's host
// name, /<user name>, or an IP-, UUID- or token-shaped run still refuses the whole report.
@JvmInline
value class DytestBody private constructor(val text: String) {
    companion object {
        const val PREFIX = "DYTEST-"
        private val WWW = Regex("[wW]{3}\\.")
        private val NUMERALS = setOf(
            Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER,
        ).map(Byte::toInt)
        private val REFUSED = setOf(
            Character.CONTROL, Character.FORMAT, Character.SURROGATE, Character.PRIVATE_USE,
            Character.UNASSIGNED, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR,
        ).map(Byte::toInt)

        fun of(body: String): DytestBody? {
            if (!body.startsWith(PREFIX) || body.codePointCount(0, body.length) > 120) return null
            if ("://" in body || WWW.containsMatchIn(body)) return null
            var numerals = 0
            for (cp in body.codePoints()) {
                if (cp == '@'.code || cp == 0xFE6B || cp == 0xFF20) return null
                val type = Character.getType(cp)
                if (type in NUMERALS && ++numerals > 3) return null
                if (type in REFUSED && cp != '\n'.code && cp != 0x200D) return null
            }
            return DytestBody(body)
        }
    }
}

// The owner-entered second number, kept on the phone: it never enters a report or a log. Only
// spaces, dashes, dots, parentheses and slashes are dropped before comparing, so "+1 (555)
// 555-0123" matches "+15555550123" but a national form never matches an international one.
// `number` is that normalized form, the send probe's only destination.
class SecondNumber private constructor(val number: String) {
    fun matches(address: String): Boolean = normalize(address) == number

    override fun toString() = "SecondNumber"

    companion object {
        private val SHAPE = Regex("\\+?[0-9]{7,15}")

        private fun normalize(raw: String): String? =
            raw.filterNot { it in " -.()/\u00a0" }.takeIf(SHAPE::matches)

        fun of(entered: String): SecondNumber? = normalize(entered)?.let(::SecondNumber)
    }
}

private fun quote(text: String) = buildString {
    append('"')
    for (c in text) {
        when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c == '\n' -> append("\\n")
            c < ' ' -> append("\\u").append(Integer.toHexString(c.code).padStart(4, '0'))
            else -> append(c)
        }
    }
    append('"')
}

private fun obj(vararg fields: Pair<String, String?>) = fields.filter { it.second != null }
    .joinToString(",", "{", "}") { (name, value) -> "\"$name\":$value" }

private fun <T> arr(items: List<T>?, max: Int, item: (T) -> String) =
    items?.take(max)?.joinToString(",", "[", "]", transform = item)

private fun count(value: Int?) = value?.coerceIn(0, 999_999)?.toString()
private fun ms(value: Long?) = value?.coerceIn(0, 86_400_000)?.toString()
private fun wire(value: Wire?) = value?.let { quote(it.wire) }
private fun names(list: List<ColumnName>?, max: Int) = arr(list?.distinct(), max) { quote(it.text) }
private fun digests(list: List<KeyDigest>?) = arr(list?.distinct(), 8) { quote(it.wire) }

class Report(
    val probeVersion: ProbeVersion,
    val createdAt: UtcTime,
    val device: Device,
    val inventory: Inventory? = null,
    val threadMix: ThreadMix? = null,
    val vectors: Vectors? = null,
    val sends: Sends? = null,
    val background: Background? = null,
    val tls: Tls? = null,
    val network: Network? = null,
    val otp: Otp? = null,
    val install: List<Install>? = null,
    val testMessages: List<TestMessage>? = null,
) {
    fun toJson(): String = obj(
        "schema" to quote(REPORT_SCHEMA),
        "encodingCheck" to quote(ENCODING_CHECK),
        "probeVersion" to quote(probeVersion.text),
        "createdAt" to quote(createdAt.text),
        "device" to device.json(),
        "inventory" to inventory?.json(),
        "threadMix" to threadMix?.json(),
        "vectors" to vectors?.json(),
        "sends" to sends?.json(),
        "background" to background?.json(),
        "tls" to tls?.json(),
        "network" to network?.json(),
        "otp" to otp?.json(),
        "install" to arr(install, 16) { it.json() },
        "testMessages" to arr(testMessages, 40) { it.json() },
    )
}

class Device(
    val manufacturer: Manufacturer,
    val androidVersion: ShortVersion,
    val sdkLevel: Int,
    val oemVersion: ShortVersion? = null,
    val securityPatchVersion: DateVersion? = null,
    val buildVersion: BuildVersion? = null,
    val messagesVersion: MessagesVersion? = null,
    val messagesIsDefault: Boolean? = null,
    val smsFormat: SmsFormat? = null,
    val simSlots: Int? = null,
    val activeSubscriptions: Int? = null,
) {
    internal fun json() = obj(
        "manufacturer" to wire(manufacturer),
        "androidVersion" to quote(androidVersion.text),
        "oemVersion" to oemVersion?.let { quote(it.text) },
        "sdkLevel" to count(sdkLevel),
        "securityPatchVersion" to securityPatchVersion?.let { quote(it.text) },
        "buildVersion" to buildVersion?.let { quote(it.text) },
        "messagesVersion" to messagesVersion?.let { quote(it.text) },
        "messagesIsDefault" to messagesIsDefault?.toString(),
        "smsFormat" to wire(smsFormat),
        "simSlots" to count(simSlots),
        "activeSubscriptions" to count(activeSubscriptions),
    )
}

class Inventory(
    val providers: List<Provider>,
    val messages: Messages? = null,
    val rcs: Rcs? = null,
) {
    internal fun json() = obj(
        "providers" to arr(providers, 16) { it.json() },
        "messages" to messages?.json(),
        "rcs" to rcs?.json(),
    )
}

class Provider(
    val table: ProviderTable,
    val readable: Boolean,
    val failure: ProviderFailure? = null,
    val rows: Int? = null,
    val columns: List<ColumnName>? = null,
) {
    internal fun json() = obj(
        "table" to wire(table),
        "readable" to readable.toString(),
        "failure" to wire(failure),
        "rows" to count(rows),
        "columns" to names(columns, 256),
    )
}

class Messages(
    val sms: Directions? = null,
    val mms: Directions? = null,
    val mmsGroup: Directions? = null,
    val rcs: Directions? = null,
    val rcsGroup: Directions? = null,
    val unknown: Directions? = null,
) {
    internal fun json() = obj(
        "sms" to sms?.json(),
        "mms" to mms?.json(),
        "mmsGroup" to mmsGroup?.json(),
        "rcs" to rcs?.json(),
        "rcsGroup" to rcsGroup?.json(),
        "unknown" to unknown?.json(),
    )
}

class Directions(val inbound: Int? = null, val outbound: Int? = null, val other: Int? = null) {
    internal fun json() =
        obj("inbound" to count(inbound), "outbound" to count(outbound), "other" to count(other))
}

class Rcs(
    val idMethod: RcsIdMethod? = null,
    val idColumns: List<ColumnName>? = null,
    val outgoingWritten: Tri? = null,
    val e2eeReadable: Tri? = null,
    val e2eeRows: Int? = null,
    val nonE2eeRows: Int? = null,
) {
    internal fun json() = obj(
        "idMethod" to wire(idMethod),
        "idColumns" to names(idColumns, 8),
        "outgoingWritten" to wire(outgoingWritten),
        "e2eeReadable" to wire(e2eeReadable),
        "e2eeRows" to count(e2eeRows),
        "nonE2eeRows" to count(nonE2eeRows),
    )
}

class ThreadMix(
    val windowDays: Int,
    val threads: Int,
    val groups: Int? = null,
    val smsOnly: Int? = null,
    val mmsOnly: Int? = null,
    val rcsOnly: Int? = null,
    val smsAndMms: Int? = null,
    val smsAndRcs: Int? = null,
    val mmsAndRcs: Int? = null,
    val allThree: Int? = null,
    val unknown: Int? = null,
) {
    internal fun json() = obj(
        "windowDays" to count(windowDays),
        "threads" to count(threads),
        "groups" to count(groups),
        "smsOnly" to count(smsOnly),
        "mmsOnly" to count(mmsOnly),
        "rcsOnly" to count(rcsOnly),
        "smsAndMms" to count(smsAndMms),
        "smsAndRcs" to count(smsAndRcs),
        "mmsAndRcs" to count(mmsAndRcs),
        "allThree" to count(allThree),
        "unknown" to count(unknown),
    )
}

class Vectors(val results: List<VectorResult>) {
    internal fun json() =
        obj("format" to quote(VECTORS_FORMAT), "results" to arr(results, 64) { it.json() })
}

// SmsMessage.calculateLength's four numbers: parts, code units used, code units left in the last
// part, and the code unit size.
class CalculateLength(val parts: Int, val used: Int, val remaining: Int, val unitSize: Int) {
    internal fun json() = arr(listOf(parts, used, remaining, unitSize), 4) { count(it)!! }

    companion object {
        fun of(result: IntArray): CalculateLength? = result.takeIf { it.size == 4 }
            ?.let { CalculateLength(it[0], it[1], it[2], it[3]) }
    }
}

class VectorResult(
    val id: VectorId,
    val match: VectorMatch,
    val calculateLength: CalculateLength? = null,
    val partUnits: List<Int>? = null,
    val joinsBack: Boolean? = null,
) {
    internal fun json() = obj(
        "id" to wire(id),
        "match" to wire(match),
        "calculateLength" to calculateLength?.json(),
        "partUnits" to arr(partUnits, 16) { count(it)!! },
        "joinsBack" to joinsBack?.toString(),
    )
}

class Sends(
    val attempted: Int,
    val results: List<SendResult>,
    val refusedDestination: Int? = null,
) {
    internal fun json() = obj(
        "attempted" to attempted.coerceIn(0, 20).toString(),
        "refusedDestination" to count(refusedDestination),
        "results" to arr(results, 20) { it.json() },
    )
}

class SendResult(
    val id: VectorId,
    val partsSent: Int,
    val encoding: SmsEncoding? = null,
    val partsDelivered: Int? = null,
    val sentResults: List<Int>? = null,
    val deliveryResults: List<DeliveryResult>? = null,
    val sentRows: Int? = null,
    val sentRowBodyEqual: Boolean? = null,
    val lastSentMs: Long? = null,
    val lastDeliveredMs: Long? = null,
) {
    internal fun json() = obj(
        "id" to wire(id),
        "encoding" to wire(encoding),
        "partsSent" to count(partsSent),
        "partsDelivered" to count(partsDelivered),
        "sentResults" to arr(sentResults, 16) { it.coerceIn(-1, 9999).toString() },
        "deliveryResults" to arr(deliveryResults, 16) { quote(it.wire) },
        "sentRows" to count(sentRows),
        "sentRowBodyEqual" to sentRowBodyEqual?.toString(),
        "lastSentMs" to ms(lastSentMs),
        "lastDeliveredMs" to ms(lastDeliveredMs),
    )
}

class Background(val runs: List<BackgroundRun>) {
    internal fun json() = obj("runs" to arr(runs, 32) { it.json() })
}

class BackgroundRun(
    val scenario: Scenario,
    val samples: Int,
    val batteryExempt: Boolean? = null,
    val p50Ms: Long? = null,
    val p95Ms: Long? = null,
    val maxMs: Long? = null,
    val restarted: Tri? = null,
) {
    internal fun json() = obj(
        "scenario" to wire(scenario),
        "batteryExempt" to batteryExempt?.toString(),
        "samples" to count(samples),
        "p50Ms" to ms(p50Ms),
        "p95Ms" to ms(p95Ms),
        "maxMs" to ms(maxMs),
        "restarted" to wire(restarted),
    )
}

class Tls(
    val result: TlsResult,
    val fallbackReason: TlsFailure? = null,
    val keyClass: KeyClass? = null,
    val keyDigests: List<KeyDigest>? = null,
    val attempts: List<TlsAttempt>? = null,
    val protocol: TlsProtocol? = null,
    val cipherSuite: CipherSuite? = null,
    val serverPinMatched: Boolean? = null,
    val clientCertAccepted: Boolean? = null,
    val ekmEqual: Boolean? = null,
    val handshakeMs: Long? = null,
) {
    internal fun json() = obj(
        "result" to wire(result),
        "fallbackReason" to wire(fallbackReason),
        "keyClass" to wire(keyClass),
        "keyDigests" to digests(keyDigests),
        "attempts" to arr(attempts, 8) { it.json() },
        "protocol" to wire(protocol),
        "cipherSuite" to wire(cipherSuite),
        "serverPinMatched" to serverPinMatched?.toString(),
        "clientCertAccepted" to clientCertAccepted?.toString(),
        "ekmEqual" to ekmEqual?.toString(),
        "handshakeMs" to ms(handshakeMs),
    )
}

class TlsAttempt(
    val keyClass: KeyClass,
    val result: AttemptResult,
    val keyDigests: List<KeyDigest>? = null,
    val failure: TlsFailure? = null,
) {
    internal fun json() = obj(
        "keyClass" to wire(keyClass),
        "keyDigests" to digests(keyDigests),
        "result" to wire(result),
        "failure" to wire(failure),
    )
}

class Network(
    val localNetworkPermission: LocalNetworkPermission? = null,
    val lanStandin: Reach? = null,
    val tailnetStandin: Reach? = null,
) {
    internal fun json() = obj(
        "localNetworkPermission" to wire(localNetworkPermission),
        "lanStandin" to wire(lanStandin),
        "tailnetStandin" to wire(tailnetStandin),
    )
}

class Otp(val samples: List<OtpSample>) {
    internal fun json() = obj("samples" to arr(samples, 16) { it.json() })
}

// Delays only: an OTP-shaped text's body never enters a report.
class OtpSample(
    val delivered: Boolean,
    val delayMs: Long? = null,
    val delayed: Boolean? = null,
    val webOtp: WebOtp? = null,
) {
    internal fun json() = obj(
        "delivered" to delivered.toString(),
        "delayMs" to ms(delayMs),
        "delayed" to delayed?.toString(),
        "webOtp" to wire(webOtp),
    )
}

class Install(
    val path: InstallPath,
    val installed: Boolean,
    val androidVersion: ShortVersion? = null,
    val restrictedSettings: RestrictedSettings? = null,
    val playProtect: PlayProtect? = null,
    val advancedProtection: AdvancedProtection? = null,
) {
    internal fun json() = obj(
        "path" to wire(path),
        "androidVersion" to androidVersion?.let { quote(it.text) },
        "installed" to installed.toString(),
        "restrictedSettings" to wire(restrictedSettings),
        "playProtect" to wire(playProtect),
        "advancedProtection" to wire(advancedProtection),
    )
}

class TestMessage private constructor(
    private val transport: Transport,
    private val direction: Direction,
    private val table: ProviderTable?,
    private val body: DytestBody,
    private val rcsMarkerColumns: List<ColumnName>?,
) {
    internal fun json() = obj(
        "transport" to wire(transport),
        "direction" to wire(direction),
        "table" to wire(table),
        "addressIsSecondNumber" to "true",
        "body" to quote(body.text),
        "rcsMarkerColumns" to names(rcsMarkerColumns, 8),
    )

    companion object {
        // Checked on the phone: a provider row becomes a TestMessage only when its address is the
        // owner-entered second number and its body passes DytestBody. Every other row, other
        // people's included, is dropped here.
        fun of(
            secondNumber: SecondNumber?,
            address: String,
            body: String,
            transport: Transport,
            direction: Direction,
            table: ProviderTable? = null,
            rcsMarkerColumns: List<ColumnName>? = null,
        ): TestMessage? {
            if (secondNumber == null || !secondNumber.matches(address)) return null
            val checked = DytestBody.of(body) ?: return null
            return TestMessage(transport, direction, table, checked, rcsMarkerColumns)
        }
    }
}
