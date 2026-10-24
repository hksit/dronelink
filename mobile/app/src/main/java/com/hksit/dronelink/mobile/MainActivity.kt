package com.hksit.dronelink.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Bundle
import android.view.SurfaceHolder
import android.view.View
import android.widget.RadioButton
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.hksit.dronelink.mobile.databinding.ActivityMainBinding
import com.hksit.dronelink.mobile.databinding.DialogSettingsBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dji.sdk.keyvalue.value.common.ComponentIndexType
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.SDKManager
import dji.v5.manager.aircraft.simulator.InitializationSettings
import dji.v5.manager.aircraft.simulator.SimulatorManager
import dji.v5.manager.datacenter.MediaDataCenter
import dji.v5.manager.interfaces.ICameraStreamManager
import java.util.Locale

class MainActivity : AppCompatActivity() {

    companion object {
        // one link for the whole app, so turning the screen doesn't restart the search
        private var sharedLink: Link? = null
    }

    private lateinit var ui: ActivityMainBinding
    private lateinit var prefs: SharedPreferences
    private lateinit var link: Link

    private var surfaceHolder: SurfaceHolder? = null
    private var surfaceW = 0
    private var surfaceH = 0
    private var surfaceAttached = false
    private var lastAircraftConnected = false

    private var settingsUi: DialogSettingsBinding? = null
    private var settingsDialog: AlertDialog? = null

    private val listener: () -> Unit = { render() }

    private val askLocation = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    private val scanQr = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        if (link.chooseManual(text)) {
            prefs.edit().putString("manual", text.trim()).apply()
            settingsUi?.manualAddress?.setText(text.trim())
            toast("DroneLink address set: ${link.targetHost}")
            render()
        } else {
            toast("That QR code is not a DroneLink address")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = ActivityMainBinding.inflate(layoutInflater)
        setContentView(ui.root)
        prefs = getSharedPreferences("dronelink", Context.MODE_PRIVATE)
        hideSystemBars()

        link = sharedLink ?: Link(this).also { sharedLink = it }
        prefs.getString("manual", null)?.let { if (link.targetHost == null) link.chooseManual(it) }
        link.start()

        ui.liveView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {}
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                surfaceHolder = holder
                surfaceW = width
                surfaceH = height
                surfaceAttached = false
                attachSurface()
            }

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                if (Drone.initDone) runCatching { MediaDataCenter.getInstance().cameraStreamManager.removeCameraStreamSurface(holder.surface) }
                surfaceHolder = null
                surfaceAttached = false
            }
        })

        ui.btnLive.setOnClickListener { toggleLive() }
        ui.btnSettings.setOnClickListener { openSettings() }
        ui.chipPc.setOnClickListener { openSettings() }

        ui.btnTakeoff.onConfirmed = { Drone.takeOff { err -> result("Taking off", err) } }
        ui.btnLand.onConfirmed = { Drone.land { err -> result("Landing", err) } }
        ui.btnRth.accent = ContextCompat.getColor(this, R.color.warn)
        ui.btnRth.onConfirmed = { Drone.returnHome { err -> result("Returning home", err) } }

        askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        if (!prefs.getBoolean("safetyAccepted", false)) showSafety()
        render()
    }

    override fun onResume() {
        super.onResume()
        Drone.addListener(listener)
        hideSystemBars()
        render()
    }

    override fun onPause() {
        super.onPause()
        Drone.removeListener(listener)
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) {
            Streamer.stop()
            link.stop()
            sharedLink = null
        }
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, ui.root).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ---------------- live view ----------------

    private fun attachSurface() {
        val holder = surfaceHolder ?: return
        if (!Drone.initDone || surfaceAttached || surfaceW <= 0 || surfaceH <= 0) return
        runCatching {
            MediaDataCenter.getInstance().cameraStreamManager.putCameraStreamSurface(
                ComponentIndexType.LEFT_OR_MAIN, holder.surface, surfaceW, surfaceH, ICameraStreamManager.ScaleType.CENTER_INSIDE
            )
            surfaceAttached = true
        }
    }

    // ---------------- screen ----------------

    @SuppressLint("SetTextI18n")
    private fun render() {
        if (isFinishing) return
        val connected = Drone.registered && Drone.aircraftConnected
        if (Drone.aircraftConnected != lastAircraftConnected) {
            lastAircraftConnected = Drone.aircraftConnected
            surfaceAttached = false // the camera stream restarts after a reconnect
        }
        attachSurface()

        // drone status + centre message
        val ok = ContextCompat.getColor(this, R.color.ok)
        val warn = ContextCompat.getColor(this, R.color.warn)
        val textColor = ContextCompat.getColor(this, R.color.text)
        var center: String? = null
        when {
            !BuildConfig.HAS_DJI_KEY -> { ui.chipDrone.text = "No DJI key"; center = getString(R.string.no_key) }
            !Drone.initDone -> { ui.chipDrone.text = "Starting ${Drone.initProgress}%" }
            Drone.registerError != null -> {
                ui.chipDrone.text = "DJI sign-in failed"
                center = "DJI couldn't confirm this app (${Drone.registerError}).\n\nConnect the phone to the internet once (mobile data or Wi-Fi), then reopen the app."
            }
            !Drone.registered -> { ui.chipDrone.text = "Signing in to DJI…"; center = "Signing in to DJI. The first time this needs the internet." }
            !Drone.aircraftConnected -> {
                ui.chipDrone.text = "No drone"
                center = "Plug the controller into this phone with its USB cable, then turn on the controller and the drone.\n\nSupported: DJI Mini 3, Mini 3 Pro, Mini 4 Pro and DJI Enterprise drones."
            }
            else -> ui.chipDrone.text = Drone.model ?: "Drone connected"
        }
        ui.chipDrone.setTextColor(if (connected) ok else warn)
        ui.centerMsg.text = center ?: ""
        ui.centerMsg.visibility = if (center == null) View.GONE else View.VISIBLE

        val sats = Drone.satellites
        ui.chipGps.visibility = if (connected) View.VISIBLE else View.GONE
        ui.chipGps.text = "GPS ${sats ?: "–"}"
        ui.chipGps.setTextColor(if (sats != null && sats >= 8) textColor else warn)
        val bat = Drone.battery
        ui.chipBattery.visibility = if (connected) View.VISIBLE else View.GONE
        ui.chipBattery.text = "BAT ${bat?.let { "$it%" } ?: "–"}"
        ui.chipBattery.setTextColor(
            when {
                bat == null -> textColor
                bat < 15 -> ContextCompat.getColor(this, R.color.live)
                bat < 30 -> warn
                else -> textColor
            }
        )
        ui.chipSim.visibility = if (Drone.simulator) View.VISIBLE else View.GONE

        // DroneLink on the computer
        val host = link.targetHost
        ui.chipPc.text = if (host == null) "Searching for DroneLink…" else "PC: ${link.targetName ?: host}"
        ui.chipPc.setTextColor(if (host == null) warn else textColor)

        // live button + stream info
        ui.btnLive.isEnabled = Streamer.wanted || (connected && link.targetRtmp != null)
        ui.btnLive.isActivated = Streamer.wanted
        ui.btnLive.text = if (Streamer.wanted) "● LIVE · Stop" else getString(R.string.go_live)
        if (Streamer.wanted) {
            val s = Streamer.status
            ui.streamInfo.visibility = View.VISIBLE
            ui.streamInfo.text = when {
                Streamer.streaming && s != null && s.isStreaming ->
                    "Live to ${link.targetName ?: host} · ${s.fps} fps · ${mbps(s.vbps)} Mbps"
                Streamer.lastError != null -> "Reconnecting… (${Streamer.lastError})"
                !connected -> "Waiting for the drone…"
                else -> "Connecting to DroneLink…"
            }
        } else {
            ui.streamInfo.visibility = View.GONE
        }

        // flight data line
        ui.telemetry.visibility = if (connected) View.VISIBLE else View.GONE
        ui.telemetry.text = listOf(
            "H " + (Drone.altitude?.let { fmt(it) + " m" } ?: "–"),
            "D " + (Drone.distance?.let { if (it >= 1000) fmt(it / 1000, 2) + " km" else Math.round(it).toString() + " m" } ?: "–"),
            "H.S " + (Drone.hSpeed?.let { fmt(it) + " m/s" } ?: "–"),
            "V.S " + (Drone.vSpeed?.let { fmt(it) + " m/s" } ?: "–"),
            Drone.heading?.let { Drone.compass(it) + " " + String.format(Locale.US, "%03d°", Math.round(it) % 360) } ?: "–",
        ).joinToString("   ")

        // flight buttons
        ui.btnTakeoff.isEnabled = connected && !Drone.flying && !Drone.motorsOn
        ui.btnLand.isEnabled = connected && Drone.flying
        ui.btnRth.isEnabled = connected && Drone.flying && !Drone.isGoingHome
        ui.btnRth.text = if (Drone.isGoingHome) "Returning…" else getString(R.string.return_home)
        listOf(ui.btnTakeoff, ui.btnLand, ui.btnRth).forEach { it.visibility = if (connected) View.VISIBLE else View.GONE }

        renderSettings()
    }

    // the SDK reports the video bitrate; treat small numbers as kbit/s, large as bit/s
    private fun mbps(v: Int) = fmt(if (v > 100_000) v / 1_000_000.0 else v / 1000.0)

    private fun fmt(v: Double, digits: Int = 1) = String.format(Locale.US, "%.${digits}f", v)

    private fun result(what: String, err: String?) {
        toast(if (err == null) "$what…" else "$what failed: $err")
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    // ---------------- go live ----------------

    private fun toggleLive() {
        if (Streamer.wanted) {
            Streamer.stop()
            render()
            return
        }
        val url = link.targetRtmp
        if (url == null) {
            toast("Choose the computer running DroneLink first")
            openSettings()
            return
        }
        Streamer.start(url, prefs.getBoolean("fullHd", false))
        render()
    }

    // ---------------- settings ----------------

    private fun openSettings() {
        val s = DialogSettingsBinding.inflate(layoutInflater)
        settingsUi = s
        s.manualAddress.setText(prefs.getString("manual", ""))
        s.fullHd.isChecked = prefs.getBoolean("fullHd", false)
        s.fullHd.setOnCheckedChangeListener { _, on ->
            prefs.edit().putBoolean("fullHd", on).apply()
            link.targetRtmp?.let { if (Streamer.wanted) Streamer.start(it, on) }
        }
        s.scanQr.setOnClickListener {
            scanQr.launch(ScanOptions().setPrompt("Scan the QR code shown in DroneLink on the computer").setBeepEnabled(false).setOrientationLocked(false))
        }
        s.simulator.setOnClickListener { setSimulator(s.simulator.isChecked) }
        s.about.text = "DroneLink Mobile ${BuildConfig.VERSION_NAME} · DJI Mobile SDK ${
            if (Drone.initDone) runCatching { SDKManager.getInstance().getSDKVersion() }.getOrDefault("?") else "starting"
        }\nFlight data is sent to DroneLink on UDP port ${Link.PORT}, video over RTMP."

        settingsDialog = AlertDialog.Builder(this, R.style.Dialog_DroneLink)
            .setView(s.root)
            .setPositiveButton("Done") { _, _ ->
                val typed = s.manualAddress.text.toString().trim()
                val before = prefs.getString("manual", "") ?: ""
                if (typed != before) {
                    if (typed.isEmpty()) {
                        prefs.edit().remove("manual").apply()
                    } else if (link.chooseManual(typed)) {
                        prefs.edit().putString("manual", typed).apply()
                    } else {
                        toast("That address doesn't look right. Example: 192.168.1.20")
                    }
                }
                render()
            }
            .setOnDismissListener {
                settingsUi = null
                settingsDialog = null
                hideSystemBars()
            }
            .show()
        renderSettings()
    }

    private fun renderSettings() {
        val s = settingsUi ?: return
        // list of computers found on the network
        val pcs = link.found.values.sortedBy { it.name }
        val shown = (0 until s.pcList.childCount).map { (s.pcList.getChildAt(it).tag as? String) }
        if (shown != pcs.map { it.host }) {
            s.pcList.setOnCheckedChangeListener(null)
            s.pcList.removeAllViews()
            for (pc in pcs) {
                val rb = RadioButton(this).apply {
                    id = View.generateViewId()
                    tag = pc.host
                    text = "${pc.name}  ·  ${pc.host}" + if (pc.version.isNotEmpty()) "  ·  DroneLink ${pc.version}" else ""
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
                    isChecked = pc.host == link.targetHost
                }
                s.pcList.addView(rb)
            }
            s.pcList.setOnCheckedChangeListener { group, checkedId ->
                val host = group.findViewById<View>(checkedId)?.tag as? String ?: return@setOnCheckedChangeListener
                link.found[host]?.let {
                    link.choose(it)
                    if (Streamer.wanted) Streamer.start(it.rtmp, prefs.getBoolean("fullHd", false))
                    render()
                }
            }
        }
        s.pcNone.visibility = if (pcs.isEmpty()) View.VISIBLE else View.GONE

        s.simulator.isChecked = Drone.simulator
        s.simulator.isEnabled = Drone.registered && Drone.aircraftConnected && !Drone.flying && !Drone.motorsOn
    }

    private fun setSimulator(on: Boolean) {
        val cb = object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                runOnUiThread { toast(if (on) "Simulator on: the drone stays on the ground" else "Simulator off"); render() }
            }

            override fun onFailure(error: IDJIError) {
                runOnUiThread { toast("Simulator: ${error.description() ?: error.errorCode()}"); render() }
            }
        }
        if (on) {
            val here = phoneLocation()
            val lat = here?.latitude ?: Drone.homeLat ?: -31.9505
            val lon = here?.longitude ?: Drone.homeLon ?: 115.8605
            SimulatorManager.getInstance().enableSimulator(InitializationSettings.createInstance(LocationCoordinate2D(lat, lon), 15), cb)
        } else {
            SimulatorManager.getInstance().disableSimulator(cb)
        }
    }

    private fun phoneLocation(): Location? {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) return null
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return try {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
                .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
                .maxByOrNull { it.time }
        } catch (_: SecurityException) {
            null
        }
    }

    private fun showSafety() {
        AlertDialog.Builder(this, R.style.Dialog_DroneLink)
            .setTitle(R.string.safety_title)
            .setMessage(R.string.safety_text)
            .setCancelable(false)
            .setPositiveButton(R.string.safety_ok) { _, _ ->
                prefs.edit().putBoolean("safetyAccepted", true).apply()
                hideSystemBars()
            }
            .show()
    }
}
