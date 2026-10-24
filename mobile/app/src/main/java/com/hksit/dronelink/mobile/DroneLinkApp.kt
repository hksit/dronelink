package com.hksit.dronelink.mobile

import android.app.Application
import android.content.Context

class DroneLinkApp : Application() {
    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(base)
        // DJI Mobile SDK v5 needs this before anything else (from DJI's sample)
        com.cySdkyc.clx.Helper.install(this)
    }

    override fun onCreate() {
        super.onCreate()
        Drone.init(this)
    }
}
