package com.hksit.dronelink.mobile

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap

/**
 * Talks to DroneLink on the computer (docs/PROTOCOL.md in the DroneLink repo):
 *  - finds it on the Wi-Fi or this phone's hotspot (UDP broadcast, port 41234)
 *  - sends the flight data 5 times a second
 * The video itself goes separately over RTMP (see Streamer).
 */
class Link(context: Context) {
    data class Pc(val name: String, val host: String, val rtmp: String, val version: String, val seenAt: Long)

    companion object {
        const val PORT = 41234
        private const val TAG = "DroneLink"
    }

    private val appContext = context.applicationContext
    val found = ConcurrentHashMap<String, Pc>()

    /** Where the flight data and video go: a found computer, or a typed/scanned address. */
    @Volatile var targetHost: String? = null
    @Volatile var targetRtmp: String? = null
    @Volatile var targetName: String? = null
    @Volatile var lastSendOk = false

    @Volatile private var running = false
    private var thread: Thread? = null
    private var lock: WifiManager.MulticastLock? = null

    fun start() {
        if (running) return
        running = true
        lock = runCatching {
            (appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createMulticastLock("dronelink").apply {
                setReferenceCounted(false)
                acquire()
            }
        }.getOrNull()
        thread = Thread({ loop() }, "dronelink-link").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        runCatching { lock?.release() }
    }

    fun choose(pc: Pc) {
        targetHost = pc.host
        targetRtmp = pc.rtmp
        targetName = pc.name
    }

    /** Accepts "192.168.1.20", "192.168.1.20:1935" or "rtmp://192.168.1.20/live/drone". */
    fun chooseManual(text: String): Boolean {
        val t = text.trim()
        if (t.isEmpty()) return false
        val rtmp = if (t.startsWith("rtmp://", true)) t else "rtmp://${t.trimEnd('/')}/live/drone"
        val host = Regex("^rtmp://([^/:]+)", RegexOption.IGNORE_CASE).find(rtmp)?.groupValues?.get(1) ?: return false
        if (!Regex("^[A-Za-z0-9.-]+$").matches(host)) return false
        targetHost = host
        targetRtmp = rtmp
        targetName = host
        return true
    }

    private fun loop() {
        var socket: DatagramSocket? = null
        var lastDiscover = 0L
        val buf = ByteArray(2048)
        while (running) {
            try {
                if (socket == null || socket.isClosed) {
                    socket = DatagramSocket().apply { broadcast = true; soTimeout = 200 }
                }
                val now = System.currentTimeMillis()
                // search every 2 s until a computer is chosen, then every 10 s to keep the list fresh
                val every = if (targetHost == null) 2000 else 10000
                if (now - lastDiscover > every) {
                    lastDiscover = now
                    discover(socket)
                }
                // replies
                try {
                    val p = DatagramPacket(buf, buf.size)
                    socket.receive(p)
                    handleReply(String(p.data, 0, p.length, Charsets.UTF_8))
                } catch (_: SocketTimeoutException) {
                }
                sendFlightData(socket)
            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.w(TAG, "link: $e")
                lastSendOk = false
                runCatching { socket?.close() }
                socket = null
                try { Thread.sleep(1000) } catch (_: InterruptedException) { break }
            }
        }
        runCatching { socket?.close() }
    }

    private fun discover(socket: DatagramSocket) {
        val msg = JSONObject().put("dl", "discover").put("v", 1).put("app", "DroneLink Mobile").toString().toByteArray()
        for (addr in broadcastAddresses()) {
            runCatching { socket.send(DatagramPacket(msg, msg.size, addr, PORT)) }
        }
        // forget computers that stopped answering
        val cutoff = System.currentTimeMillis() - 30000
        found.entries.removeIf { it.value.seenAt < cutoff }
    }

    private fun handleReply(text: String) {
        val j = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (j.optString("dl") != "here" || j.optInt("v") != 1) return
        val host = j.optString("host")
        val rtmp = j.optString("rtmp")
        if (host.isEmpty() || !rtmp.startsWith("rtmp://")) return
        val pc = Pc(j.optString("name", host).take(40), host, rtmp, j.optString("version"), System.currentTimeMillis())
        found[host] = pc
        // first computer found: use it
        if (targetHost == null) choose(pc)
        Drone.changed()
    }

    private var lastSent = 0L
    private fun sendFlightData(socket: DatagramSocket) {
        val host = targetHost ?: return
        val now = System.currentTimeMillis()
        if (now - lastSent < 200) return
        lastSent = now
        if (!Drone.aircraftConnected) return
        val j = JSONObject().put("dl", "tel").put("v", 1)
        Drone.altitude?.let { j.put("alt", round1(it)) }
        Drone.heading?.let { j.put("hdg", round1(it)) }
        Drone.hSpeed?.let { j.put("hs", round1(it)) }
        Drone.vSpeed?.let { j.put("vs", round1(it)) }
        Drone.distance?.let { j.put("dist", round1(it)) }
        Drone.lat?.let { j.put("lat", it) }
        Drone.lon?.let { j.put("lon", it) }
        Drone.battery?.let { j.put("bat", it) }
        Drone.satellites?.let { j.put("sats", it) }
        j.put("flying", Drone.flying)
        Drone.model?.let { j.put("model", it) }
        j.put("sim", Drone.simulator)
        val bytes = j.toString().toByteArray()
        lastSendOk = runCatching { socket.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName(host), PORT)) }.isSuccess
    }

    private fun round1(v: Double) = Math.round(v * 10) / 10.0

    /** The broadcast address of every network this phone is on (Wi-Fi, its own hotspot, USB tethering). */
    private fun broadcastAddresses(): List<InetAddress> {
        val out = mutableListOf<InetAddress>()
        runCatching {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) {
                    if (ia.address is Inet4Address) ia.broadcast?.let { out.add(it) }
                }
            }
        }
        runCatching { out.add(InetAddress.getByName("255.255.255.255")) }
        return out.distinct()
    }
}
