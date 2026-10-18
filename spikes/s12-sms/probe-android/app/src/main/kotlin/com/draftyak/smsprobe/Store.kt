package com.draftyak.smsprobe

import android.content.Context

// Kept between runs: app-private SharedPreferences on the phone, a map in the JVM tests.
interface Store {
    operator fun get(key: String): String?
    operator fun set(key: String, value: String?)
}

fun Store.int(key: String): Int = get(key)?.toIntOrNull() ?: 0

fun Store.list(key: String): List<String> =
    get(key)?.split(';')?.filter(String::isNotEmpty).orEmpty()

// A ';'-separated list that keeps its first `max` items.
fun Store.append(key: String, item: String, max: Int) =
    list(key).takeIf { it.size < max }?.let { set(key, (it + item).joinToString(";")) }

fun probeStore(context: Context): Store = object : Store {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun set(key: String, value: String?) { prefs.edit().putString(key, value).commit() }
}
