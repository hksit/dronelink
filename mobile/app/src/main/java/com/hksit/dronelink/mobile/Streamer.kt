package com.hksit.dronelink.mobile

import android.os.Handler
import android.os.Looper
import android.util.Log
import dji.sdk.keyvalue.value.common.ComponentIndexType
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.datacenter.MediaDataCenter
import dji.v5.manager.datacenter.livestream.LiveStreamSettings
import dji.v5.manager.datacenter.livestream.LiveStreamStatus
import dji.v5.manager.datacenter.livestream.LiveStreamStatusListener
import dji.v5.manager.datacenter.livestream.LiveStreamType
import dji.v5.manager.datacenter.livestream.LiveVideoBitrateMode
import dji.v5.manager.datacenter.livestream.StreamQuality
import dji.v5.manager.datacenter.livestream.settings.RtmpSettings
import dji.v5.manager.interfaces.ILiveStreamManager

/**
 * Sends the drone's live picture to DroneLink over RTMP, using the SDK's own
 * streamer, and restarts it by itself if the Wi-Fi or the drone link drops.
 */
object Streamer {
    private const val TAG = "DroneLink"
    private const val RETRY_MS = 5000L

    @Volatile var wanted = false
        private set
    @Volatile var url: String? = null
        private set
    @Volatile var status: LiveStreamStatus? = null
    @Volatile var lastError: String? = null
    @Volatile var starting = false

    private val main = Handler(Looper.getMainLooper())
    private var listening = false

    private val manager: ILiveStreamManager
        get() = MediaDataCenter.getInstance().liveStreamManager

    val streaming: Boolean
        get() = Drone.initDone && runCatching { manager.isStreaming }.getOrDefault(false)

    private val statusListener = object : LiveStreamStatusListener {
        override fun onLiveStreamStatusUpdate(s: LiveStreamStatus?) {
            status = s
            Drone.changed()
        }

        override fun onError(error: IDJIError?) {
            if (error != null) {
                lastError = error.description() ?: error.errorCode()
                Log.w(TAG, "live stream error: $error")
            }
            Drone.changed()
        }
    }

    private fun ensureListener() {
        if (listening || !Drone.initDone) return
        manager.addLiveStreamStatusListener(statusListener)
        listening = true
    }

    fun start(rtmpUrl: String, fullHd: Boolean) {
        wanted = true
        url = rtmpUrl
        lastError = null
        ensureListener()
        configure(rtmpUrl, fullHd)
        attempt()
        main.removeCallbacks(watchdog)
        main.postDelayed(watchdog, RETRY_MS)
    }

    fun stop() {
        wanted = false
        main.removeCallbacks(watchdog)
        if (!Drone.initDone) return
        manager.stopStream(object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() { Drone.changed() }
            override fun onFailure(error: IDJIError) { Drone.changed() }
        })
    }

    private fun configure(rtmpUrl: String, fullHd: Boolean) {
        val m = manager
        m.liveStreamSettings = LiveStreamSettings.Builder()
            .setLiveStreamType(LiveStreamType.RTMP)
            .setRtmpSettings(RtmpSettings.Builder().setUrl(rtmpUrl).build())
            .build()
        m.cameraIndex = ComponentIndexType.LEFT_OR_MAIN
        // 2 = HD (720p), 3 = Full HD (1080p), as in DJI's sample
        m.liveStreamQuality = StreamQuality.find(if (fullHd) 3 else 2)
        m.liveVideoBitrateMode = LiveVideoBitrateMode.AUTO
    }

    private fun attempt() {
        if (!wanted || starting || streaming) return
        if (!Drone.registered || !Drone.aircraftConnected) return // the watchdog tries again
        starting = true
        manager.startStream(object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                starting = false
                lastError = null
                Drone.changed()
            }

            override fun onFailure(error: IDJIError) {
                starting = false
                lastError = error.description() ?: error.errorCode()
                Log.w(TAG, "start stream failed: $error")
                Drone.changed()
            }
        })
        Drone.changed()
    }

    private val watchdog = object : Runnable {
        override fun run() {
            if (!wanted) return
            ensureListener()
            attempt()
            main.postDelayed(this, RETRY_MS)
        }
    }
}
