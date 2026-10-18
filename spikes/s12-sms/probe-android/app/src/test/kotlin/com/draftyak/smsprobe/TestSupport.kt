package com.draftyak.smsprobe

import java.io.File
import java.util.regex.Pattern

// Paths set by app/build.gradle.kts (ProbeTestFiles), so Gradle tracks them as test inputs.
object TestFiles {
    private fun property(name: String): String =
        requireNotNull(System.getProperty("dyprobe.$name")) { "dyprobe.$name isn't set" }

    fun path(name: String): File = File(property(name))

    fun paths(name: String): List<File> =
        property(name).split(File.pathSeparator).filter(String::isNotEmpty).map(::File)

    @Suppress("UNCHECKED_CAST")
    val schema: Map<String, Any?> by lazy {
        Json.parse(path("schema").readText()) as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    val corpus: Map<String, Any?> by lazy {
        Json.parse(path("corpus").readText()) as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    fun corpusStrings(key: String): List<String> = corpus.getValue(key) as List<String>

    fun writeSample(name: String, text: String) {
        val dir = path("samples").apply { mkdirs() }
        File(dir, name).writeBytes(text.toByteArray(Charsets.UTF_8))
    }

    // M0.36's vectors/segments.v1.json, as the probe parses its bundled copy.
    val vectors: List<SegmentVector> by lazy { SegmentVectors.parse(path("vectors").readText()) }
}

// The probe's Store as a map.
class MapStore : Store {
    val values = sortedMapOf<String, String>()

    override fun get(key: String): String? = values[key]

    override fun set(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

// A report with the required fields and the given sections, for schema checks.
fun reportWith(
    inventory: Inventory? = null,
    threadMix: ThreadMix? = null,
    vectors: Vectors? = null,
    sends: Sends? = null,
    background: Background? = null,
    tls: Tls? = null,
    network: Network? = null,
    otp: Otp? = null,
): String = Report(
    ProbeVersion.CURRENT, Reports.createdAt, Reports.device(), inventory, threadMix, vectors, sends,
    background, tls, network, otp,
).toJson()

// A JSON string with everything outside printable ASCII escaped, lone surrogates included.
fun jsonAscii(text: String): String = text.map { c ->
    when {
        c == '"' || c == '\\' -> "\\$c"
        c in ' '..'~' -> "$c"
        else -> "\\u" + Integer.toHexString(c.code).padStart(4, '0')
    }
}.joinToString("", "\"", "\"")

// The schema's subset, applied the way receive-report applies it: unknown fields, missing required
// fields, item counts, duplicates, enums, consts, patterns, lengths and integer ranges.
@Suppress("UNCHECKED_CAST")
object SchemaCheck {
    private val defs get() = TestFiles.schema["\$defs"] as Map<String, Map<String, Any?>>

    fun resolve(node: Map<String, Any?>): Map<String, Any?> =
        (node["\$ref"] as String?)?.let { resolve(defs.getValue(it.removePrefix("#/\$defs/"))) }
            ?: node

    // Leaf paths in the form of receive-report --fields: a.b, a[].b, a[].
    fun leaves(
        node: Map<String, Any?> = TestFiles.schema,
        at: String = "",
    ): Map<String, Map<String, Any?>> {
        val resolved = resolve(node)
        return when (resolved["type"]) {
            "object" -> (resolved["properties"] as Map<String, Map<String, Any?>>)
                .flatMap { (key, sub) ->
                    leaves(sub, if (at.isEmpty()) key else "$at.$key").toList()
                }
                .toMap()
            "array" -> leaves(resolved["items"] as Map<String, Any?>, "$at[]")
            else -> mapOf(at to resolved)
        }
    }

    fun accepts(rule: Map<String, Any?>, text: String): Boolean {
        val values = (rule["enum"] as List<String>?) ?: (rule["const"] as String?)?.let(::listOf)
        if (values != null) return text in values
        val max = (rule["maxLength"] as Long).toInt()
        val pattern = Pattern.compile(rule["pattern"] as String)
        return text.codePointCount(0, text.length) <= max && pattern.matcher(text).matches()
    }

    fun problems(
        value: Any?,
        node: Map<String, Any?> = TestFiles.schema,
        at: String = "$",
    ): List<String> {
        val rule = resolve(node)
        return when (rule["type"]) {
            "object" -> {
                val fields = value as? Map<String, Any?> ?: return listOf("$at: not an object")
                val props = rule["properties"] as Map<String, Map<String, Any?>>
                val required = (rule["required"] as List<String>?).orEmpty()
                fields.flatMap { (key, sub) ->
                    props[key]?.let { problems(sub, it, "$at.$key") } ?: listOf("$at.$key: unknown")
                } + required.filterNot(fields::containsKey).map { "$at.$it: missing" }
            }
            "array" -> {
                val items = value as? List<Any?> ?: return listOf("$at: not an array")
                val min = (rule["minItems"] as Long?) ?: 0L
                val count = if (items.size < min || items.size > rule["maxItems"] as Long) {
                    listOf("$at: ${items.size} items")
                } else {
                    emptyList()
                }
                val unique = if (rule["uniqueItems"] == true && items.toSet().size < items.size) {
                    listOf("$at: duplicates")
                } else {
                    emptyList()
                }
                count + unique + items.flatMapIndexed { i, item ->
                    problems(item, rule["items"] as Map<String, Any?>, "$at[$i]")
                }
            }
            "string" -> if (value is String && accepts(rule, value)) emptyList() else listOf(at)
            "integer" -> {
                val number = value as? Long ?: return listOf("$at: not an integer")
                if (number in rule["minimum"] as Long..rule["maximum"] as Long) {
                    emptyList()
                } else {
                    listOf("$at: out of range")
                }
            }
            "boolean" -> if (value is Boolean && (rule["const"] ?: value) == value) {
                emptyList()
            } else {
                listOf(at)
            }
            else -> listOf("$at: unsupported schema type")
        }
    }
}

// Leaf paths of a parsed report, in the same form as SchemaCheck.leaves.
fun reportLeaves(value: Any?, at: String = ""): Set<String> = when (value) {
    is Map<*, *> -> value.flatMap { (key, sub) ->
        reportLeaves(sub, if (at.isEmpty()) "$key" else "$at.$key")
    }.toSet()
    is List<*> -> value.flatMap { reportLeaves(it, "$at[]") }.toSet()
    else -> setOf(at)
}
