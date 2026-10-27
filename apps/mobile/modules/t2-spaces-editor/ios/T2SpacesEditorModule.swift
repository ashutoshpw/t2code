import ExpoModulesCore

@ExpoModule("T2SpacesEditor")
public class T2SpacesEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Constants(["richRunBridgeRevision": 2])
    View(T2SpacesEditorView.self) {
      Prop("documentJson") { (view: T2SpacesEditorView, value: String) in
        view.setDocument(value)
      }
      Prop("editable") { (view: T2SpacesEditorView, value: Bool) in
        view.setEditable(value)
      }
      Events("onSpacesChange", "onSpacesSelection", "onSpacesLimit")
      AsyncFunction("format") { (view: T2SpacesEditorView, command: String) in
        view.format(command)
      }
      AsyncFunction("history") { (view: T2SpacesEditorView, backwards: Bool, revision: Int) in
        view.history(backwards, revision: revision)
      }
      AsyncFunction("focus") { (view: T2SpacesEditorView) in
        view.editor.becomeFirstResponder()
      }
      AsyncFunction("blur") { (view: T2SpacesEditorView) in
        view.editor.resignFirstResponder()
      }
      AsyncFunction("freeze") { (view: T2SpacesEditorView) in
        view.freeze()
      }
      AsyncFunction("resume") { (view: T2SpacesEditorView, revision: Int) in
        view.resume(revision)
      }
    }
  }
}
