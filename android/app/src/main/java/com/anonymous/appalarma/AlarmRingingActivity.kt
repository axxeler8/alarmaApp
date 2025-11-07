package com.anonymous.appalarma

import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.SystemClock
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.facebook.react.bridge.Arguments

class AlarmRingingActivity : AppCompatActivity() {
  private var ringtone: Ringtone? = null
  private lateinit var id: String
  private lateinit var label: String
  private lateinit var type: String

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Window flags to show over lock screen and turn screen on
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
      (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).requestDismissKeyguard(this, null)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      )
    }

    id = intent.getStringExtra("id") ?: ""
    label = intent.getStringExtra("label") ?: ""
    type = intent.getStringExtra("type") ?: "alarm"

    // Simple programmatic UI
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(48, 64, 48, 48)
      gravity = Gravity.CENTER
    }
    val title = TextView(this).apply {
      text = if (type == "alarm") "⏰ Alarma" else "⏲️ Temporizador"
      textSize = 24f
    }
    val subtitle = TextView(this).apply {
      text = label
      textSize = 18f
      setPadding(0, 12, 0, 24)
    }
    val row1 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    val snooze5 = Button(this).apply { text = "Posponer 5m"; setOnClickListener { snooze(5) } }
    val snooze10 = Button(this).apply { text = "Posponer 10m"; setOnClickListener { snooze(10) } }
    val snooze15 = Button(this).apply { text = "Posponer 15m"; setOnClickListener { snooze(15) } }
    row1.addView(snooze5)
    row1.addView(snooze10)
    row1.addView(snooze15)
    val dismiss = Button(this).apply { text = "Desactivar"; setOnClickListener { dismissAlarm() } }
    layout.addView(title)
    layout.addView(subtitle)
    layout.addView(row1)
    layout.addView(dismiss)
    setContentView(layout)

    // Play alarm sound
    val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    ringtone = RingtoneManager.getRingtone(this, uri)
    ringtone?.audioAttributes = android.media.AudioAttributes.Builder()
      .setUsage(android.media.AudioAttributes.USAGE_ALARM).build()
    val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    am.mode = AudioManager.MODE_NORMAL
    ringtone?.play()
  }

  private fun alarmManager() = getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private fun pendingReceiver(@Suppress("UNUSED_PARAMETER") targetAt: Long): PendingIntent {
    val i = Intent(this, AlarmReceiver::class.java).apply {
      putExtra("id", id)
      putExtra("label", label)
      putExtra("type", type)
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    // Versión anterior: usar solo id.hashCode()
    return PendingIntent.getBroadcast(this, id.hashCode(), i, flags)
  }

  private fun sendToJs(action: String, triggerAt: Long? = null) {
    // Persist the action to prefs as a safety net in case the bridge isn't ready
    val reactReady = AlarmEventEmitter.reactContext != null
    android.util.Log.d("AppAlarma", "AlarmRingingActivity.sendToJs action=" + action + " reactReady=" + reactReady + " id=" + id)
    try {
      val prefs = getSharedPreferences("appalarma", Context.MODE_PRIVATE)
      val json = org.json.JSONObject().apply {
        put("id", id)
        put("action", action)
        if (triggerAt != null) put("triggerAt", triggerAt)
      }
      prefs.edit().putString("pendingAction", json.toString()).apply()
      android.util.Log.d("AppAlarma", "Saved pendingAction to prefs: " + json.toString())
    } catch (_: Exception) {}

    // If the RN bridge is alive, emit directly to JS for immediate handling
    if (reactReady) {
      try {
        val params = Arguments.createMap().apply {
          putString("id", id)
          putString("action", action)
          if (triggerAt != null) putDouble("triggerAt", triggerAt.toDouble())
        }
        AlarmEventEmitter.send("alarmActivityAction", params)
        android.util.Log.d("AppAlarma", "Emitted direct to JS for id=" + id + " action=" + action)
      } catch (_: Exception) {}
    }

    // Also broadcast within the app as a redundancy path
    try {
      val i = Intent("com.anonymous.appalarma.ACTION_FROM_ACTIVITY").apply {
        putExtra("id", id)
        putExtra("action", action)
        if (triggerAt != null) putExtra("triggerAt", triggerAt)
      }
      // Limit broadcast to our own app package
      i.setPackage(packageName)
      sendBroadcast(i)
      android.util.Log.d("AppAlarma", "Broadcasted ACTION_FROM_ACTIVITY for id=" + id + " action=" + action)
    } catch (_: Exception) {}
  }

  private fun cancelNotification() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.cancel((id + ":notif").hashCode())
  }

  private fun snooze(minutes: Int) {
    // Versión anterior: no reprogramar aquí para evitar duplicados; JS reprograma y actualiza UI.
    val atWall = System.currentTimeMillis() + minutes * 60_000L
    sendToJs("snooze", atWall)
    finish()
  }

  private fun dismissAlarm() {
    val am = alarmManager()
    // Cancel any OS-level pending intent best-effort (JS also cancels on receive)
    try { am.cancel(pendingReceiver(System.currentTimeMillis())) } catch (_: Exception) {}
    // Bring app to foreground first so the RN bridge is alive, then notify JS shortly after
    try {
      val i = Intent(this, MainActivity::class.java)
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      startActivity(i)
      android.util.Log.d("AppAlarma", "Started MainActivity from AlarmRingingActivity for id=" + id)
    } catch (_: Exception) {}
    // Post a small delay to allow React bridge to initialize; also persisted fallback covers cold starts
    android.os.Handler(mainLooper).postDelayed({
      sendToJs("dismiss")
      finish()
    }, 500)
  }

  override fun onDestroy() {
    super.onDestroy()
    try { ringtone?.stop() } catch (_: Exception) {}
    cancelNotification()
  }
}
