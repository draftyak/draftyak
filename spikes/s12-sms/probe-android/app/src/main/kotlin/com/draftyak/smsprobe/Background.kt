package com.draftyak.smsprobe

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.ApplicationExitInfo
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock

const val ACTION_TIMER = "com.draftyak.smsprobe.TIMER"
const val TIMER_MS = 60_000L

enum class StartCause { UI, BOOT, STICKY }

// Exits that aren't kills: an update (adb install -r), a permission change or a package change.
private val NOT_KILLED = setOf(
    ApplicationExitInfo.REASON_PACKAGE_UPDATED, ApplicationExitInfo.REASON_PERMISSION_CHANGE,
    ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE,
)

// With the battery exemption at the time: how late timers that overlapped deep Doze fired (labelled
// forced, by adb, or natural), and the service starts that followed the end of a run.
class BackgroundLog(private val store: Store) {
    fun sample(exempt: Boolean, lateMs: Long) {
        val natural = store["doze"] == "natural"
        val scenario = if (natural) Scenario.DOZE_NATURAL else Scenario.DOZE_FORCED
        store.append("bg.samples", "${scenario.name},$exempt,${lateMs.coerceAtLeast(0)}", 5_000)
    }

    private fun event(scenario: Scenario, exempt: Boolean, restarted: Boolean, delayMs: Long?) =
        store.append("bg.events", "${scenario.name},$exempt,$restarted,${delayMs ?: ""}", 100)

    // boot: delay since boot; sticky: Android restarted the service after its process died (delay
    // since that exit); ui: the owner opened the probe or started the test again. restarted: in
    // the foreground.
    fun started(
        cause: StartCause,
        foreground: Boolean,
        exempt: Boolean,
        exit: Pair<Int, Long>?,
        sinceBoot: Long,
        now: Long,
    ) {
        val newExit = exit?.takeIf { it.second > (store["bg.exit"]?.toLongOrNull() ?: 0) }
        if (newExit != null) store["bg.exit"] = "${newExit.second}"
        val wasOn = store["bg.fgs"] == "1"
        store["bg.fgs"] = if (foreground) "1" else null
        val sinceExit = newExit?.let { now - it.second }
        when {
            cause == StartCause.BOOT ->
                event(Scenario.AFTER_BOOT, exempt, foreground, sinceBoot.takeIf { foreground })
            newExit?.first in NOT_KILLED -> {}
            cause == StartCause.STICKY ->
                event(Scenario.AFTER_KILL, exempt, foreground, sinceExit.takeIf { foreground })
            wasOn && newExit != null -> {
                val reason = newExit.first
                val stopped = reason == ApplicationExitInfo.REASON_USER_REQUESTED ||
                    reason == ApplicationExitInfo.REASON_USER_STOPPED
                val scenario = if (stopped) Scenario.AFTER_FORCE_STOP else Scenario.AFTER_KILL
                event(scenario, exempt, false, null)
            }
        }
    }

    fun report(): Background? {
        fun read(key: String) = store.list(key).map { it.split(',') }.groupBy { it[0] to it[1] }
        val samples = read("bg.samples").map { (key, list) ->
            run(key, list.size, list.map { it[2].toLong() }, null)
        }
        val events = read("bg.events").map { (key, list) ->
            val restarted = list.map { it[2] == "true" }.distinct()
            val tri = if (restarted.size > 1) Tri.UNKNOWN else if (restarted[0]) Tri.YES else Tri.NO
            run(key, list.size, list.mapNotNull { it[3].toLongOrNull() }, tri)
        }
        return (samples + events).takeIf { it.isNotEmpty() }?.let(::Background)
    }

    private fun run(key: Pair<String, String>, count: Int, values: List<Long>, restarted: Tri?) =
        BackgroundRun(
            Scenario.valueOf(key.first), count, key.second == "true", percentile(values, 50),
            percentile(values, 95), values.maxOrNull(), restarted,
        )
}

// Nearest rank.
fun percentile(values: List<Long>, pct: Int): Long? =
    values.sorted().getOrNull((values.size * pct + 99) / 100 - 1)

// The remoteMessaging foreground service for the timers; a start that can't go foreground stops.
class ProbeService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val store = probeStore(this)
        val channel = NotificationChannel("probe", "Background", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        val notification = Notification.Builder(this, channel.id).setContentTitle("SMS probe")
            .setSmallIcon(android.R.drawable.stat_notify_sync).build()
        val foreground = runCatching {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        }.isSuccess
        val exit = runCatching {
            getSystemService(ActivityManager::class.java)
                .getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull()
        }.getOrNull()
        val cause = intent?.getStringExtra("cause")?.let(StartCause::valueOf) ?: StartCause.STICKY
        val exitAt = exit?.let { it.reason to it.timestamp }
        val sinceBoot = SystemClock.elapsedRealtime()
        val now = System.currentTimeMillis()
        BackgroundLog(store).started(cause, foreground, Timers.exempt(this), exitAt, sinceBoot, now)
        ProbeLog.log(if (foreground) ProbeEvent.SERVICE_STARTED else ProbeEvent.SERVICE_REFUSED)
        if (!foreground) {
            stopSelf()
            return START_NOT_STICKY
        }
        Timers.schedule(this, store)
        return START_STICKY
    }

    override fun onDestroy() {
        val store = probeStore(this)
        store["bg.fgs"] = null
        Timers.cancel(this, store)
    }

    companion object {
        fun start(context: Context, cause: StartCause) {
            val intent = Intent(context, ProbeService::class.java).putExtra("cause", cause.name)
            context.startForegroundService(intent)
        }
    }
}

// Allow-while-idle alarms (exact ones need a permission outside the SMS host's set); a sample
// counts if the device was in deep Doze when its timer was set or fired.
object Timers {
    private fun pending(context: Context): PendingIntent {
        val intent = Intent(context, ProbeReceiver::class.java).setAction(ACTION_TIMER)
        return PendingIntent.getBroadcast(context, 1_000_000, intent, PendingIntent.FLAG_IMMUTABLE)
    }

    private fun power(context: Context) = context.getSystemService(PowerManager::class.java)

    fun exempt(context: Context): Boolean =
        power(context).isIgnoringBatteryOptimizations(context.packageName)

    fun schedule(context: Context, store: Store) {
        val at = SystemClock.elapsedRealtime() + TIMER_MS
        store["timer"] = "$at,${power(context).isDeviceIdleMode}"
        context.getSystemService(AlarmManager::class.java)
            .setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending(context))
    }

    fun fired(context: Context, store: Store) {
        val (at, idleWhenSet) = store["timer"]?.split(',') ?: return
        if (store["bg.fgs"] != "1") return
        val late = SystemClock.elapsedRealtime() - at.toLong()
        if (idleWhenSet == "true" || power(context).isDeviceIdleMode) {
            BackgroundLog(store).sample(exempt(context), late)
            ProbeLog.log(ProbeEvent.TIMER_SAMPLE, ProbeCount.SECONDS to (late / 1_000).toInt())
        }
        schedule(context, store)
    }

    fun cancel(context: Context, store: Store) {
        context.getSystemService(AlarmManager::class.java).cancel(pending(context))
        store["timer"] = null
    }
}
