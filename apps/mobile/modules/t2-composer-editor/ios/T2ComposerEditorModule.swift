import ExpoModulesCore
import UIKit

enum T2ComposerClipboard {
  static let fragmentType = "app.t3.context-fragment"

  static func write(text: String, fragment: String) {
    var items: [String: Any] = ["public.utf8-plain-text": text]
    if let data = fragment.data(using: .utf8),
       var payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let records = payload["records"] as? [[String: Any]] {
      var selected = records.filter { record in
        guard let id = record["contextId"] as? String else { return false }
        return text.contains("/\(id))")
      }
      let screenshots = Set(selected.compactMap { $0["screenshotContextId"] as? String })
      selected.append(contentsOf: records.filter { screenshots.contains($0["contextId"] as? String ?? "") && !text.contains("/\($0["contextId"] as? String ?? ""))") })
      payload["records"] = selected
      if !selected.isEmpty, let encoded = try? JSONSerialization.data(withJSONObject: payload), let raw = String(data: encoded, encoding: .utf8) {
        let attribute = raw.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        items[fragmentType] = encoded
        items["public.html"] = Data("<pre data-t3-context-fragment=\"\(attribute)\">\(escaped)</pre>".utf8)
      }
    }
    UIPasteboard.general.items = [items]
  }

  static func read() -> [String: String] {
    let board = UIPasteboard.general
    return [
      "text": board.string ?? "",
      "fragment": board.data(forPasteboardType: fragmentType).flatMap { String(data: $0, encoding: .utf8) } ?? "",
      "html": board.data(forPasteboardType: "public.html").flatMap { String(data: $0, encoding: .utf8) } ?? "",
    ]
  }
}

public class T2ComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T2ComposerEditor")

    AsyncFunction("writeContextClipboard") { (text: String, fragment: String) in
      T2ComposerClipboard.write(text: text, fragment: fragment)
    }.runOnQueue(.main)

    View(T2ComposerEditorView.self) {
      Prop("controlledDocumentJson") { (view: T2ComposerEditorView, documentJson: String) in
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { (view: T2ComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("clipboardFragment") { (view: T2ComposerEditorView, fragment: String) in
        view.setClipboardFragment(fragment)
      }
      Prop("placeholder") { (view: T2ComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { (view: T2ComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: T2ComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: T2ComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: T2ComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: T2ComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("readOnly") { (view: T2ComposerEditorView, readOnly: Bool) in
        view.setReadOnly(readOnly)
      }
      Prop("scrollEnabled") { (view: T2ComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: T2ComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: T2ComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: T2ComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }
      Prop("enterBehavior") { (view: T2ComposerEditorView, behavior: String) in
        view.setEnterBehavior(behavior)
      }
      Prop("textPasteThresholdBytes") { (view: T2ComposerEditorView, threshold: Int) in
        view.setTextPasteThresholdBytes(threshold)
      }
      Prop("maxInputChars") { (view: T2ComposerEditorView, maxInputChars: Int) in
        view.setMaxInputChars(maxInputChars)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerSubmit",
        "onComposerPasteImages",
        "onComposerContextPress",
        "onComposerPasteContext",
        "onComposerPasteText",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: T2ComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: T2ComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: T2ComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
