package com.draftyak.smsprobe

import java.net.InetSocketAddress

// The probe's only network peer: hub-standin, reached through adb reverse on the phone's loopback.
// network_security_config.xml trusts only the bundled stand-in certificate, pinned, and only for
// these hosts (a JVM test keeps the two lists equal). ClassScanTest allows network types only in
// the classes it lists, and those dial only address().
object Standin {
    val hosts = listOf("127.0.0.1")
    private val reservedPorts = setOf(9229, 47613, 47614, 47615)

    fun address(host: String, port: Int): InetSocketAddress {
        require(host in hosts) { "not a stand-in host" }
        require(port in 1..65_535 && port !in reservedPorts) { "not a stand-in port" }
        return InetSocketAddress(host, port)
    }
}
