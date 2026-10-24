package com.hksit.dronelink.mobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.DJIKey
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.key.ProductKey
import dji.sdk.keyvalue.value.common.EmptyMsg
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.common.register.DJISDKInitEvent
import dji.v5.manager.KeyManager
import dji.v5.manager.SDKManager
import dji.v5.manager.aircraft.simulator.SimulatorManager
import dji.v5.manager.interfaces.SDKManagerCallback
import dji.v5.network.DJINetworkManager
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * DJI Mobile SDK: start-up, registration, connection and live flight data.
 * Everything the screen and DroneLink on the computer show comes from here.
 */
object Drone {
    private const val TAG = "DroneLink"

    // --- SDK state ---
    @Volatile var initDone = false
    @Volatile var initProgress = 0
    @Volatile var registered = false
    @Volatile var registerError: String? = null
    @Volatile var productConnected = false

    // --- flight data (null = not known yet) ---
    @Volatile var aircraftConnected = false
    @Volatile var altitude: Double? = null      // m above take-off
    @Volatile var heading: Double? = null       // 0..360, 0 = north
    @Volatile var hSpeed: Double? = null        // m/s
    @Volatile var vSpeed: Double? = null        // m/s, up positive
    @Volatile var lat: Double? = null
    @Volatile var lon: Double? = null
    @Volatile var homeLat: Double? = null
    @Volatile var homeLon: Double? = null
    @Volatile var satellites: Int? = null
    @Volatile var battery: Int? = null
    @Volatile var flying = false
    @Volatile var motorsOn = false
    @Volatile var goHomeState: String? = null
    @Volatile var model: String? = null

    val distance: Double?
        get() {
            val a = lat; val b = lon; val c = homeLat; val d = homeLon
            if (a == null || b == null || c == null || d == null) return null
            return haversine(a, b, c, d)
        }

    val simulator: Boolean
        get() = initDone && runCatching { SimulatorManager.getInstance().isSimulatorEnabled }.getOrDefault(false)

    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private var notifyQueued = false

    fun addListener(l: () -> Unit) = listeners.add(l)
    fun removeListener(l: () -> Unit) = listeners.remove(l)

    /** Tell the screen something changed (at most ~10 times a second). */
    fun changed() {
        synchronized(this) {
            if (notifyQueued) return
            notifyQueued = true
        }
        main.postDelayed({
            synchronized(this) { notifyQueued = false }
            listeners.forEach { runCatching(it) }
        }, 100)
    }

    fun init(context: Context) {
        SDKManager.getInstance().init(context, object : SDKManagerCallback {
            override fun onRegisterSuccess() {
                Log.i(TAG, "registered")
                registered = true
                registerError = null
                changed()
            }

            override fun onRegisterFailure(error: IDJIError) {
                Log.w(TAG, "register failed: $error")
                registered = false
                registerError = error.description() ?: error.errorCode()
                changed()
            }

            override fun onProductDisconnect(productId: Int) {
                productConnected = false
                changed()
            }

            override fun onProductConnect(productId: Int) {
                productConnected = true
                changed()
            }

            override fun onProductChanged(productId: Int) {
                changed()
            }

            override fun onInitProcess(event: DJISDKInitEvent, totalProcess: Int) {
                initProgress = totalProcess
                if (event == DJISDKInitEvent.INITIALIZE_COMPLETE) {
                    initDone = true
                    listenFlightData()
                    SDKManager.getInstance().registerApp()
                }
                changed()
            }

            override fun onDatabaseDownloadProgress(current: Long, total: Long) {}
        })

        // registration needs the internet once; retry when it comes back
        DJINetworkManager.getInstance().addNetworkStatusListener { available ->
            if (initDone && available && !SDKManager.getInstance().isRegistered) SDKManager.getInstance().registerApp()
        }
    }

    private fun <T> listen(key: DJIKey<T>, onValue: (T?) -> Unit) {
        KeyManager.getInstance().listen(key, this) { _, value ->
            onValue(value)
            changed()
        }
    }

    private fun listenFlightData() {
        listen(KeyTools.createKey(FlightControllerKey.KeyConnection)) { aircraftConnected = it == true }
        listen(KeyTools.createKey(FlightControllerKey.KeyAltitude)) { altitude = it }
        listen(KeyTools.createKey(FlightControllerKey.KeyCompassHeading)) { h -> heading = h?.let { ((it % 360) + 360) % 360 } }
        listen(KeyTools.createKey(FlightControllerKey.KeyAircraftVelocity)) { v ->
            // x = north, y = east, z = down (m/s)
            hSpeed = v?.let { hypot(it.x, it.y) }
            vSpeed = v?.let { -it.z }
        }
        listen(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation3D)) { p ->
            if (p != null && validLatLon(p.latitude, p.longitude)) {
                lat = p.latitude; lon = p.longitude
            } else {
                lat = null; lon = null
            }
        }
        listen(KeyTools.createKey(FlightControllerKey.KeyHomeLocation)) { p ->
            if (p != null && validLatLon(p.latitude, p.longitude)) {
                homeLat = p.latitude; homeLon = p.longitude
            } else {
                homeLat = null; homeLon = null
            }
        }
        listen(KeyTools.createKey(FlightControllerKey.KeyGPSSatelliteCount)) { satellites = it }
        listen(KeyTools.createKey(FlightControllerKey.KeyIsFlying)) { flying = it == true }
        listen(KeyTools.createKey(FlightControllerKey.KeyAreMotorsOn)) { motorsOn = it == true }
        listen(KeyTools.createKey(FlightControllerKey.KeyGoHomeStatus)) { goHomeState = it?.toString() }
        listen(KeyTools.createKey(BatteryKey.KeyChargeRemainingInPercent)) { battery = it }
        listen(KeyTools.createKey(ProductKey.KeyProductType)) { model = it?.let { t -> prettyModel(t.toString()) } }
    }

    // --- flight actions (each needs a hold-to-confirm in the UI) ---

    fun takeOff(done: (String?) -> Unit) = action(KeyTools.createKey(FlightControllerKey.KeyStartTakeoff), done)
    fun land(done: (String?) -> Unit) = action(KeyTools.createKey(FlightControllerKey.KeyStartAutoLanding), done)
    fun returnHome(done: (String?) -> Unit) = action(KeyTools.createKey(FlightControllerKey.KeyStartGoHome), done)

    private fun action(key: DJIKey.ActionKey<EmptyMsg, EmptyMsg>, done: (String?) -> Unit) {
        KeyManager.getInstance().performAction(key, object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
            override fun onSuccess(t: EmptyMsg?) {
                main.post { done(null) }
            }

            override fun onFailure(error: IDJIError) {
                main.post { done(error.description() ?: error.errorCode() ?: "failed") }
            }
        })
    }

    val isGoingHome: Boolean
        get() {
            val s = goHomeState ?: return false
            return !(s.contains("IDLE", true) || s.contains("COMPLETE", true) || s.contains("UNKNOWN", true))
        }

    // --- helpers ---

    private fun validLatLon(a: Double, b: Double) =
        !a.isNaN() && !b.isNaN() && a in -90.0..90.0 && b in -180.0..180.0 && !(kotlin.math.abs(a) < 1e-6 && kotlin.math.abs(b) < 1e-6)

    fun haversine(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6371000.0
        val p1 = Math.toRadians(lat1); val p2 = Math.toRadians(lat2)
        val dp = p2 - p1; val dl = Math.toRadians(lon2 - lon1)
        val a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * r * atan2(sqrt(a), sqrt(1 - a))
    }

    /** DJI_MINI_4_PRO -> "Mini 4 Pro" */
    fun prettyModel(raw: String): String =
        raw.removePrefix("DJI_").split('_').joinToString(" ") { w ->
            if (w.length <= 3 && w.any { it.isDigit() } || w == "RTK") w else w.lowercase().replaceFirstChar { it.uppercase() }
        }

    fun compass(deg: Double): String = arrayOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")[(((deg % 360) + 360) % 360 / 45.0).let { Math.round(it).toInt() % 8 }]
}
