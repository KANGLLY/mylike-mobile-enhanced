package expo.modules.homeicon

import android.content.Intent
import android.graphics.BitmapFactory
import android.util.Base64
import android.webkit.CookieManager
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HomeIconModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HomeIcon")

    AsyncFunction("clearCookies") {
      try {
        val cookieManager = CookieManager.getInstance()
        cookieManager.removeAllCookies(null)
        cookieManager.flush()
        true
      } catch (e: Exception) {
        false
      }
    }

    AsyncFunction("pinHomeShortcut") { name: String, base64: String ->
      val context = appContext.reactContext ?: appContext.currentActivity
      if (context == null) {
        false
      } else {
        val decoded = Base64.decode(base64, Base64.DEFAULT)
        val bitmap = if (decoded.isEmpty()) null else BitmapFactory.decodeByteArray(decoded, 0, decoded.size)
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (bitmap == null || launchIntent == null) {
          false
        } else {
          launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          val label = if (name.isBlank()) "MyLike" else name
          val icon = IconCompat.createWithBitmap(bitmap)
          val shortcut = ShortcutInfoCompat.Builder(context, "mylike_custom_" + System.currentTimeMillis())
            .setShortLabel(label)
            .setLongLabel(label)
            .setIcon(icon)
            .setIntent(launchIntent)
            .build()
          ShortcutManagerCompat.requestPinShortcut(context, shortcut, null)
        }
      }
    }
  }
}
