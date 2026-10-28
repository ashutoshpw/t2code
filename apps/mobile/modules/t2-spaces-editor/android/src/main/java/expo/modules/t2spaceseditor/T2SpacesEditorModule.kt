package expo.modules.t2spaceseditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T2SpacesEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T2SpacesEditor")
    Constants("richRunBridgeRevision" to 2)
    View(T2SpacesEditorView::class) {
      Prop("documentJson") { view: T2SpacesEditorView, value: String -> view.setDocument(value) }
      Prop("editable") { view: T2SpacesEditorView, value: Boolean -> view.setEditable(value) }
      Events("onSpacesChange", "onSpacesSelection", "onSpacesLimit")
      AsyncFunction("format") { view: T2SpacesEditorView, command: String -> view.format(command) }
      AsyncFunction("history") { view: T2SpacesEditorView, backwards: Boolean, revision: Int ->
        view.history(backwards, revision)
      }
      AsyncFunction("focus") { view: T2SpacesEditorView -> view.editor.requestFocus() }
      AsyncFunction("blur") { view: T2SpacesEditorView -> view.editor.clearFocus() }
      AsyncFunction("freeze") { view: T2SpacesEditorView -> view.freeze() }
      AsyncFunction("resume") { view: T2SpacesEditorView, revision: Int -> view.resume(revision) }
    }
  }
}
