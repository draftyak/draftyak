package com.draftyak.smsprobe

import java.net.InetSocketAddress
import java.net.Socket

enum class HostKind { LOOPBACK, LAN, TAILNET }

// The probe's only network peer: hub-standin, reached through adb reverse on the phone's loopback.
// network_security_config.xml trusts only the bundled stand-in certificate, pinned, and only for
// these hosts (a JVM test keeps the two lists equal). ClassScanTest allows network types only in
// the classes it lists, and those dial only through connect().
object Standin {
    val hosts = listOf("127.0.0.1")
    private val reservedPorts = setOf(9229, 47613, 47614, 47615)

    fun address(host: String, port: Int): InetSocketAddress {
        require(host in hosts) { "not a stand-in host" }
        require(port in 1..65_535 && port !in reservedPorts) { "not a stand-in port" }
        return InetSocketAddress(host, port)
    }

    fun connect(socket: Socket, host: String, port: Int, timeoutMs: Int) =
        socket.connect(address(host, port), timeoutMs)

    // Hosts are IP literals; tailnet addresses are in 100.64.0.0/10 or fd7a:115c:a1e0::/48.
    fun kind(host: String): HostKind {
        val octets = host.split('.').map(String::toIntOrNull)
        return when {
            host == "127.0.0.1" || host == "::1" -> HostKind.LOOPBACK
            octets.size == 4 && octets[0] == 100 && octets[1] in 64..127 -> HostKind.TAILNET
            host.lowercase().startsWith("fd7a:115c:a1e0:") -> HostKind.TAILNET
            else -> HostKind.LAN
        }
    }
}
