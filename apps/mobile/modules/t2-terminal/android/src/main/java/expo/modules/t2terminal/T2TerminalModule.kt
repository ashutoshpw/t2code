package expo.modules.t2terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T2TerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T2TerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants(
      "hardwareKeyRevision" to 2,
    )

    View(T2TerminalView::class) {
      Prop("terminalKey") { view: T2TerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { view: T2TerminalView, initialBuffer: String ->
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { view: T2TerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Prop("focusRequest") { view: T2TerminalView, focusRequest: Double ->
        view.focusRequest = focusRequest
      }

      Prop("autoFocus") { view: T2TerminalView, autoFocus: Boolean ->
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { view: T2TerminalView, appearanceScheme: String ->
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { view: T2TerminalView, themeConfig: String ->
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { view: T2TerminalView, backgroundColor: String ->
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { view: T2TerminalView, foregroundColor: String ->
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { view: T2TerminalView, mutedForegroundColor: String ->
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Prop("captureRequest") { view: T2TerminalView, request: Double ->
        view.captureRequest = request
      }
      Events("onInput", "onResize", "onCapture")

      OnViewDestroys { view: T2TerminalView ->
        view.cleanup()
      }
    }
  }
}
