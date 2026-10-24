package com.hksit.dronelink.mobile

import android.app.Application
import android.content.Context

class DroneLinkApp : Application() {
    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(base)
        if (BuildConfig.UI_TEST) return
        // DJI Mobile SDK v5 needs this before anything else (from DJI's sample)
        com.cySdkyc.clx.Helper.install(this)
    }

    override fun onCreate() {
        super.onCreate()
        if (!BuildConfig.UI_TEST) Drone.init(this)
    }
}
