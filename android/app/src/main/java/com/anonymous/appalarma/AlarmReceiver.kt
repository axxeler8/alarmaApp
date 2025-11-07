package com.anonymous.appalarma

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    Log.d("AppAlarma", "AlarmReceiver onReceive atWall=" + System.currentTimeMillis() + " id=" + intent.getStringExtra("id"))
    val id = intent.getStringExtra("id") ?: return
    val label = intent.getStringExtra("label") ?: ""
    val type = intent.getStringExtra("type") ?: "alarm"

    val fullScreenIntent = Intent(context, AlarmRingingActivity::class.java).apply {
      putExtra("id", id)
      putExtra("label", label)
      putExtra("type", type)
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_NO_USER_ACTION
      )
    }
    try {
      context.startActivity(fullScreenIntent)
    } catch (e: Exception) {
      Log.e("AppAlarma", "Failed to start AlarmRingingActivity: ${e.message}")
    }
  }
}
