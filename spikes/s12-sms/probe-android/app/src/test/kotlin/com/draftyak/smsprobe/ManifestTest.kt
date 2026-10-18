package com.draftyak.smsprobe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

private const val ANDROID = "http://schemas.android.com/apk/res/android"

fun parseXml(file: File): Element = DocumentBuilderFactory.newInstance()
    .apply { isNamespaceAware = true }
    .newDocumentBuilder().parse(file).documentElement

fun Element.children(tag: String): List<Element> {
    val nodes = getElementsByTagName(tag)
    return (0 until nodes.length).map { nodes.item(it) as Element }
}

fun Element.android(name: String): String = getAttributeNS(ANDROID, name)

// The merged manifest (what the APK ships) holds only a subset of the SMS host's permissions
// (plan section 7), and nothing guardrail 10 rules out.
class ManifestTest {
    private val manifest = parseXml(TestFiles.path("mergedManifest"))

    private val smsHost = setOf(
        "RECEIVE_SMS", "READ_SMS", "SEND_SMS", "RECEIVE_MMS", "READ_PHONE_STATE",
        "POST_NOTIFICATIONS", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_REMOTE_MESSAGING",
        "RECEIVE_BOOT_COMPLETED", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "INTERNET",
        "ACCESS_NETWORK_STATE", "ACCESS_LOCAL_NETWORK",
    ).map { "android.permission.$it" }.toSet()

    private val permissions = (manifest.children("uses-permission") +
        manifest.children("uses-permission-sdk-23")).map { it.android("name") }

    @Test
    fun `permissions are the SMS host's, with SEND_SMS, remote messaging and INTERNET`() {
        assertEquals(permissions.distinct(), permissions)
        assertTrue(permissions.toString(), smsHost.containsAll(permissions))
        for (needed in listOf("SEND_SMS", "FOREGROUND_SERVICE_REMOTE_MESSAGING", "INTERNET")) {
            assertTrue(needed, "android.permission.$needed" in permissions)
        }
        assertEquals(emptyList<Element>(), manifest.children("permission"))
        assertEquals(emptyList<Element>(), manifest.children("uses-feature"))
    }

    @Test
    fun `nothing guardrail 10 rules out is declared`() {
        val forbidden = Regex(
            "android\\.permission\\.(REQUEST_COMPANION_.*|RECEIVE_SENSITIVE_NOTIFICATIONS|" +
                "BIND_NOTIFICATION_LISTENER_SERVICE|BIND_ACCESSIBILITY_SERVICE|CAMERA|.*CONTACTS|" +
                "GET_ACCOUNTS|ACCESS_.*LOCATION)",
        )
        val guards = listOf("service", "receiver", "activity", "provider")
            .flatMap(manifest::children).map { it.android("permission") }
        assertEquals(emptyList<String>(), (permissions + guards).filter(forbidden::matches))
        // The default-SMS role needs these components; the probe must never qualify for it.
        val roleSms = setOf(
            "android.provider.Telephony.SMS_DELIVER", "android.provider.Telephony.WAP_PUSH_DELIVER",
            "android.intent.action.RESPOND_VIA_MESSAGE", "android.intent.action.SENDTO",
            "android.service.notification.NotificationListenerService",
            "android.accessibilityservice.AccessibilityService",
        )
        val actions = manifest.children("action").map { it.android("name") }
        assertEquals(emptyList<String>(), actions.filter { it in roleSms })
    }

    @Test
    fun `exported components are the launcher or take broadcasts only the system can send`() {
        val systemOnly = setOf(
            "android.permission.BROADCAST_SMS", "android.permission.BROADCAST_WAP_PUSH",
        )
        val exported = listOf("activity", "activity-alias", "service", "receiver", "provider")
            .flatMap(manifest::children).filter { it.android("exported") == "true" }
        for (component in exported) {
            val actions = component.children("action").map { it.android("name") }
            val launcher = component.tagName == "activity" &&
                actions == listOf("android.intent.action.MAIN")
            val guarded = component.android("permission") in systemOnly
            assertTrue(component.android("name"), launcher || guarded)
        }
        assertTrue(exported.any { it.android("name") == "com.draftyak.smsprobe.MainActivity" })
    }

    @Test
    fun `components are the remoteMessaging service, the boot receiver and the SMS receiver`() {
        fun named(tag: String) = manifest.children(tag).associateBy {
            it.android("name").removePrefix("com.draftyak.smsprobe.")
        }
        val service = named("service").values.single()
        assertEquals("ProbeService", service.android("name").substringAfterLast('.'))
        val type = service.android("foregroundServiceType")
        assertEquals("remoteMessaging" to "false", type to service.android("exported"))
        val receivers = named("receiver")
        assertEquals(setOf("ProbeReceiver", "SmsReceiver"), receivers.keys)
        val boot = receivers.getValue("ProbeReceiver")
        assertEquals("false", boot.android("exported"))
        fun actions(component: Element) = component.children("action").map { it.android("name") }
        assertEquals(listOf("android.intent.action.BOOT_COMPLETED"), actions(boot))
        val sms = receivers.getValue("SmsReceiver")
        assertEquals("android.permission.BROADCAST_SMS", sms.android("permission"))
        assertEquals(listOf("android.provider.Telephony.SMS_RECEIVED"), actions(sms))
        val others = manifest.children("provider") + manifest.children("activity-alias")
        assertEquals(emptyList<Element>(), others)
        assertEquals(listOf("MainActivity"), named("activity").keys.toList())
    }

    @Test
    fun `the application uses the network security config, no backup and the pinned SDK levels`() {
        val application = manifest.children("application").single()
        assertEquals("@xml/network_security_config", application.android("networkSecurityConfig"))
        assertEquals("false", application.android("allowBackup"))
        assertFalse(application.hasAttributeNS(ANDROID, "usesCleartextTraffic"))
        val sdk = manifest.children("uses-sdk").single()
        assertEquals("34" to "37", sdk.android("minSdkVersion") to sdk.android("targetSdkVersion"))
        assertEquals("com.draftyak.smsprobe", manifest.getAttribute("package"))
        assertEquals(ProbeVersion.CURRENT.text, manifest.android("versionName"))
    }
}
