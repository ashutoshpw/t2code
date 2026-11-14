package expo.modules.t2widgetexpiry

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T2WidgetExpiryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T2WidgetExpiry")
    Function("schedule") { name: String, deadlines: List<Double> ->
      val context = appContext.reactContext ?: return@Function
      WidgetExpiryReceiver.schedule(context, name, deadlines.map { it.toLong() }.toLongArray())
    }
  }
}
