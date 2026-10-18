package com.draftyak.smsprobe

// Just enough JSON for the vectors, the stand-in's frames, the stored TLS result and the tests.
class Json private constructor(private val text: String) {
    private var at = 0

    companion object {
        fun parse(text: String): Any? = Json(text).run {
            val value = value()
            space()
            check(at == text.length) { "trailing data at $at" }
            value
        }
    }

    private fun space() {
        while (at < text.length && text[at] in " \t\r\n") at++
    }

    private fun value(): Any? {
        space()
        return when (text[at]) {
            '{' -> obj()
            '[' -> list()
            '"' -> string()
            't' -> word("true", true)
            'f' -> word("false", false)
            'n' -> word("null", null)
            else -> number()
        }
    }

    private fun word(word: String, value: Any?): Any? {
        check(text.startsWith(word, at)) { "bad literal at $at" }
        at += word.length
        return value
    }

    private fun number(): Number {
        val start = at
        while (at < text.length && text[at] in "+-0123456789.eE") at++
        val digits = text.substring(start, at)
        return digits.toLongOrNull() ?: digits.toDouble()
    }

    private fun string(): String {
        val out = StringBuilder()
        at++
        while (true) {
            val c = text[at++]
            when {
                c == '"' -> return out.toString()
                c != '\\' -> out.append(c)
                else -> when (val escape = text[at++]) {
                    '"', '\\', '/' -> out.append(escape)
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000c')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        out.append(text.substring(at, at + 4).toInt(16).toChar())
                        at += 4
                    }
                    else -> error("bad escape at $at")
                }
            }
        }
    }

    private fun list(): List<Any?> {
        val out = mutableListOf<Any?>()
        at++
        space()
        if (text[at] == ']') return out.also { at++ }
        while (true) {
            out += value()
            space()
            when (text[at++]) {
                ',' -> continue
                ']' -> return out
                else -> error("bad array at $at")
            }
        }
    }

    private fun obj(): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>()
        at++
        space()
        if (text[at] == '}') return out.also { at++ }
        while (true) {
            space()
            val key = string()
            space()
            check(text[at++] == ':') { "bad object at $at" }
            out[key] = value()
            space()
            when (text[at++]) {
                ',' -> continue
                '}' -> return out
                else -> error("bad object at $at")
            }
        }
    }
}
