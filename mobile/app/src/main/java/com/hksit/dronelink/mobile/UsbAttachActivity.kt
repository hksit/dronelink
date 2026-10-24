package com.hksit.dronelink.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** The DJI controller was plugged in: open (or bring back) the main screen. */
class UsbAttachActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        finish()
    }
}
