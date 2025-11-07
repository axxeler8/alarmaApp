package com.anonymous.appalarma

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.*
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.provider.Settings
import org.json.JSONObject
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

object AlarmEventEmitter {
  var reactContext: ReactApplicationContext? = null
  fun send(event: String, params: WritableMap) {
    reactContext?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      ?.emit(event, params)
  }
}

class AlarmModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val actionAppEvent = "com.anonymous.appalarma.ACTION_FROM_ACTIVITY"
  private var actionReceiver: BroadcastReceiver? = null

  override fun getName(): String = "AndroidAlarm"

  override fun initialize() {
    super.initialize()
    AlarmEventEmitter.reactContext = ctx
    ensureChannel()
    registerInternalReceiver()
    // Deliver any pending action saved while the RN bridge was not ready
    try { consumePendingAction() } catch (_: Exception) {}
  }

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    try { ctx.unregisterReceiver(actionReceiver) } catch (_: Exception) {}
    AlarmEventEmitter.reactContext = null
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val id = "alarm"
      if (nm.getNotificationChannel(id) == null) {
        val chan = NotificationChannel(id, "Alarmas", NotificationManager.IMPORTANCE_HIGH)
        val attrs = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ALARM)
          .build()
        chan.enableVibration(true)
        chan.vibrationPattern = longArrayOf(0, 500, 500, 500)
        chan.setSound(Settings.System.DEFAULT_ALARM_ALERT_URI, attrs)
        nm.createNotificationChannel(chan)
      }
    }
  }

  private fun registerInternalReceiver() {
    actionReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        val id = intent?.getStringExtra("id") ?: return
        val action = intent.getStringExtra("action") ?: return
        Log.d("AppAlarma", "AlarmModule.onReceive action=" + action + " id=" + id + ", hasTrigger=" + intent.hasExtra("triggerAt"))
        val params = Arguments.createMap().apply {
          putString("id", id)
          putString("action", action)
          if (intent.hasExtra("triggerAt")) putDouble("triggerAt", intent.getLongExtra("triggerAt", 0L).toDouble())
        }
        AlarmEventEmitter.send("alarmActivityAction", params)
        // Clear any matching pending action persisted earlier to avoid duplicates
        try {
          val prefs = ctx.getSharedPreferences("appalarma", Context.MODE_PRIVATE)
          val j = prefs.getString("pendingAction", null)
          if (j != null) {
            val obj = JSONObject(j)
            if (obj.optString("id") == id && obj.optString("action") == action) {
              prefs.edit().remove("pendingAction").apply()
              Log.d("AppAlarma", "Cleared pendingAction from prefs after receive id=" + id)
            }
          }
        } catch (_: Exception) {}
      }
    }
    val filter = IntentFilter(actionAppEvent)
    // Android 13+ (API 33) requires specifying RECEIVER_EXPORTED/RECEIVER_NOT_EXPORTED
    // when registering non-system broadcast receivers programmatically.
    if (Build.VERSION.SDK_INT >= 33) {
      ctx.registerReceiver(actionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      ctx.registerReceiver(actionReceiver, filter)
    }
  }

  private fun consumePendingAction() {
    val prefs = ctx.getSharedPreferences("appalarma", Context.MODE_PRIVATE)
    val j = prefs.getString("pendingAction", null) ?: return
    prefs.edit().remove("pendingAction").apply()
    try {
      val obj = JSONObject(j)
      val id = obj.optString("id", null) ?: return
      val action = obj.optString("action", null) ?: return
      Log.d("AppAlarma", "Consuming pendingAction action=" + action + " id=" + id + ", hasTrigger=" + obj.has("triggerAt"))
      val params = Arguments.createMap().apply {
        putString("id", id)
        putString("action", action)
        if (obj.has("triggerAt")) putDouble("triggerAt", obj.optLong("triggerAt", 0L).toDouble())
      }
      AlarmEventEmitter.send("alarmActivityAction", params)
    } catch (e: Exception) {
      Log.e("AppAlarma", "Failed to consume pending action: ${e.message}")
    }
  }

  private fun alarmManager(): AlarmManager = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private fun requestCode(id: String): Int = id.hashCode()

  private fun pendingReceiver(id: String, label: String, type: String): PendingIntent {
    val i = Intent(ctx, AlarmReceiver::class.java).apply {
      putExtra("id", id)
      putExtra("label", label)
      putExtra("type", type)
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
    // Use unique requestCode per type+id to avoid reusing an old PendingIntent for another type
    return PendingIntent.getBroadcast(ctx, requestCode("$type:$id"), i, flags)
  }

  @ReactMethod
  fun checkExactAlarmPermission(promise: Promise) {
    val am = alarmManager()
    if (Build.VERSION.SDK_INT >= 31) {
      promise.resolve(am.canScheduleExactAlarms())
    } else {
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun requestExactAlarmPermission() {
    if (Build.VERSION.SDK_INT >= 31) {
      val i = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(i)
    }
  }

  @ReactMethod
  fun scheduleAlarm(id: String, triggerAtMs: Double, label: String, promise: Promise) {
    try {
      val am = alarmManager()
      val pending = pendingReceiver(id, label, "alarm")
      val nowWall = System.currentTimeMillis()
      val nowElapsed = SystemClock.elapsedRealtime()
      var rawDelay = triggerAtMs.toLong() - nowWall
      Log.d("AppAlarma", "scheduleAlarm id=$id triggerAtWall=${triggerAtMs.toLong()} nowWall=$nowWall rawDelay=$rawDelay nowElapsed=$nowElapsed")
      if (rawDelay < 1000L) {
        // If user picked a past or <1s future time, bump to 3s to avoid instant fire
        rawDelay = 3000L
      }
      val fireElapsed = nowElapsed + rawDelay
      Log.d("AppAlarma", "scheduleAlarm id=$id adjustedDelay=$rawDelay fireElapsed=$fireElapsed")
      if (Build.VERSION.SDK_INT >= 23) {
        am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, fireElapsed, pending)
      } else {
        am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, fireElapsed, pending)
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_SCHEDULE_ALARM", e)
    }
  }

  @ReactMethod
  fun scheduleTimer(id: String, delayMs: Double, label: String, promise: Promise) {
    try {
      val am = alarmManager()
      val pending = pendingReceiver(id, label, "timer")
      val nowElapsed = SystemClock.elapsedRealtime()
      val at = nowElapsed + delayMs.toLong()
      Log.d("AppAlarma", "scheduleTimer id=$id delayMs=${delayMs.toLong()} nowElapsed=$nowElapsed fireElapsed=$at")
      if (Build.VERSION.SDK_INT >= 23) {
        am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending)
      } else {
        am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending)
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_SCHEDULE_TIMER", e)
    }
  }

  @ReactMethod
  fun cancel(id: String, promise: Promise) {
    try {
      val am = alarmManager()
      val pending = pendingReceiver(id, "", "alarm")
      am.cancel(pending)
      val p2 = pendingReceiver(id, "", "timer")
      am.cancel(p2)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_CANCEL", e)
    }
  }
}

class AlarmPackage : com.facebook.react.ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<com.facebook.react.bridge.NativeModule> =
    listOf(AlarmModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<com.facebook.react.uimanager.ViewManager<*, *>> = emptyList()
}
