package com.draftyak.smsprobe

import android.content.Context
import android.telephony.SmsManager
import android.telephony.SmsMessage

interface SmsApi {
    fun calculateLength(text: String): IntArray
    fun divideMessage(text: String): List<String>
    fun sendMultipart(destination: String, parts: List<String>, send: Int)
}

class AndroidSms(private val context: Context) : SmsApi {
    private val manager = context.getSystemService(SmsManager::class.java)

    override fun calculateLength(text: String): IntArray = SmsMessage.calculateLength(text, false)
    override fun divideMessage(text: String): List<String> = manager.divideMessage(text)
    override fun sendMultipart(destination: String, parts: List<String>, send: Int) {
        fun intents(action: String) =
            ArrayList(parts.indices.map { SendLog.intent(context, action, send, it) })
        manager.sendMultipartTextMessage(
            destination, null, ArrayList(parts), intents(ACTION_SENT), intents(ACTION_DELIVERED),
        )
    }
}

// One result of vectors/segments.v1.json; parts are [start, end, code units] in UTF-16 offsets
// into text, the body unless Android translates it.
class Expected(
    val match: VectorMatch,
    val length: List<Int>,
    val parts: List<List<Int>>,
    val text: String?,
    val ucs2: Boolean,
    val locking: Int,
    val shift: Int,
)

class SegmentVector(
    val id: VectorId,
    val body: String,
    val send: Boolean,
    val expected: List<Expected>,
)

// The bundled vectors/segments.v1.json: Android's default result, then tr, es, force7bit, 3gpp2.
object SegmentVectors {
    const val ASSET = "segments.v1.json"
    private val ORDER =
        listOf(VectorMatch.TR, VectorMatch.ES, VectorMatch.FORCE7BIT, VectorMatch.THREE_GPP2)

    fun load(context: Context): List<SegmentVector> =
        parse(context.assets.open(ASSET).use { it.readBytes().toString(Charsets.UTF_8) })

    fun parse(text: String): List<SegmentVector> {
        val file = Json.parse(text) as Map<*, *>
        require(file["format"] == VECTORS_FORMAT)
        return (file["vectors"] as List<*>).map { it as Map<*, *> }.map { vector ->
            val alternatives = vector["alternatives"] as Map<*, *>? ?: emptyMap<String, Any>()
            val results = listOf(VectorMatch.EXPECTED to vector["expected"]) +
                ORDER.map { it to alternatives[it.wire] }
            val expected = results.mapNotNull { (match, result) ->
                (result as Map<*, *>?)?.let { expected(match, it) }
            }
            val id = VectorId.entries.single { it.wire == vector["id"] }
            SegmentVector(id, vector["body"] as String, vector["send"] == true, expected)
        }
    }

    private fun ints(value: Any?): List<Int> = (value as List<*>).map { (it as Long).toInt() }

    private fun expected(match: VectorMatch, result: Map<*, *>) = Expected(
        match, ints(result["calculateLength"]), (result["parts"] as List<*>).map(::ints),
        result["text"] as String?, result["encoding"] == "ucs2",
        (result["languageTable"] as Long? ?: 0L).toInt(),
        (result["languageShiftTable"] as Long? ?: 0L).toInt(),
    )
}

// GSM 7-bit tables as spikes/s12-sms/src/segments.ts has them: locking shift 0 (default) and 1
// (Turkish); single shift 0 (default extension), 1 (Turkish) and 2 (Spanish).
private const val GREEK = "\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\uffff"
private const val SIGNS = " !\"#\u00a4%&'()*+,-./0123456789:;<=>?"
private const val UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7"
private const val LOWER = "abcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0"
private const val EXTENSION = "\u000c^{}\\[~]|\u20ac"
private val LOCKING = listOf(
    "@\u00a3\$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5" +
        "${GREEK}\u00c6\u00e6\u00df\u00c9${SIGNS}\u00a1${UPPER}\u00bf$LOWER",
    "@\u00a3\$\u00a5\u20ac\u00e9\u00f9\u0131\u00f2\u00c7\n\u011e\u011f\r\u00c5\u00e5" +
        "${GREEK}\u015e\u015f\u00df\u00c9${SIGNS}\u0130${UPPER}\u00e7$LOWER",
)
private val SINGLE = listOf(
    EXTENSION,
    EXTENSION + "\u011e\u0130\u015e\u00e7\u011f\u0131\u015f",
    EXTENSION + "\u00e7\u00c1\u00cd\u00d3\u00da\u00e1\u00ed\u00f3\u00fa",
)

// findGsmSeptetLimitIndex's count: one septet in the locking table, two through the single shift
// table, one for anything else (sent as a space).
fun septets(text: String, locking: Int = 0, shift: Int = 0): Int =
    text.sumOf { if (it !in LOCKING[locking] && it in SINGLE[shift]) 2 else 1 }

// Each part's code units as this result counts them; 3GPP2 sends one part of 7-bit ASCII.
fun Expected.units(parts: List<String>): List<Int> = parts.map { part ->
    val ascii = match == VectorMatch.THREE_GPP2 && length[0] == 1
    if (ucs2 || ascii) part.length else septets(part, locking, shift)
}

// calculateLength(body, false) and divideMessage(body) on the phone, against each expected result
// in order: the first whose lengths and every part's offsets and code units agree is the match.
fun runVector(vector: SegmentVector, sms: SmsApi): VectorResult {
    val length = sms.calculateLength(vector.body).toList()
    val parts = sms.divideMessage(vector.body)
    val match = vector.expected.firstOrNull { expected ->
        var start = 0
        val got = parts.zip(expected.units(parts)) { part, units ->
            listOf(start, start + part.length, units).also { start += part.length }
        }
        length == expected.length && got == expected.parts &&
            parts.joinToString("") == (expected.text ?: vector.body)
    }
    val ucs2 = length.getOrNull(3) == 3
    val units = match?.units(parts) ?: parts.map { if (ucs2) it.length else septets(it) }
    return VectorResult(
        vector.id, match?.match ?: VectorMatch.NONE, CalculateLength.of(length.toIntArray()), units,
        parts.joinToString("") == vector.body,
    )
}

// 3GPP2 counts "{" as one 7-bit ASCII septet and sends e-acute alone as UCS-2; 3GPP counts "{" as
// an escape pair and e-acute as one septet.
fun smsFormat(sms: SmsApi): SmsFormat {
    val brace = sms.calculateLength("{")
    val acute = sms.calculateLength("\u00e9")
    return when {
        brace[1] == 1 && acute[3] == 3 -> SmsFormat.THREE_GPP2
        brace[1] == 2 && acute[3] == 1 -> SmsFormat.THREE_GPP
        else -> SmsFormat.UNKNOWN
    }
}
