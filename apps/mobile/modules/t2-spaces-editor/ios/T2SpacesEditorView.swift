import ExpoModulesCore
import UIKit

private struct RichRun: Codable, Equatable {
  var text: String
  var bold: Bool
  var italic: Bool
  var code: Bool
  var link: String?
}

private struct RichSelection: Codable {
  var start: Int
  var end: Int
}

private struct RichDocument: Decodable {
  var version: Int
  var revision: Int
  var runs: [RichRun]
  var selection: RichSelection
}

private struct FormatCommand: Decodable {
  var revision: Int
  var selection: RichSelection
  var mark: String
  var enabled: Bool
}

final class SpacesTextView: UITextView {
  var settingMarkedText = false
  var compositionChanged: (() -> Void)?
  var allowReplacement: ((NSRange, String) -> Bool)?
  var composing: Bool { settingMarkedText || markedTextRange != nil }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if ["toggleBoldface:", "toggleItalics:", "toggleUnderline:"].contains(NSStringFromSelector(action)) {
      return false
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    if let range = markedTextRange ?? selectedTextRange {
      let start = offset(from: beginningOfDocument, to: range.start)
      let end = offset(from: beginningOfDocument, to: range.end)
      guard allowReplacement?(NSRange(location: start, length: end - start), markedText ?? "") != false else { return }
    }
    settingMarkedText = true
    super.setMarkedText(markedText, selectedRange: selectedRange)
    settingMarkedText = false
    compositionChanged?()
  }

  override func unmarkText() {
    super.unmarkText()
    compositionChanged?()
  }
}

public final class T2SpacesEditorView: ExpoView, UITextViewDelegate {
  let editor = SpacesTextView()
  private let onSpacesChange = EventDispatcher()
  private let onSpacesSelection = EventDispatcher()
  private let onSpacesLimit = EventDispatcher()
  private var revision = 0
  private var initialized = false
  private var applying = false
  private var wasComposing = false
  private var editable = true
  private var paused = false
  private let boldKey = NSAttributedString.Key("T2SpacesBold")
  private let italicKey = NSAttributedString.Key("T2SpacesItalic")
  private let codeKey = NSAttributedString.Key("T2SpacesCode")

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    editor.delegate = self
    editor.isScrollEnabled = true
    editor.backgroundColor = .clear
    editor.textContainerInset = .zero
    editor.textContainer.lineFragmentPadding = 0
    editor.allowsEditingTextAttributes = true
    editor.typingAttributes = attributes(RichRun(text: "", bold: false, italic: false, code: false))
    editor.accessibilityLabel = "Spaces block text"
    editor.compositionChanged = { [weak self] in
      self?.emit(change: true)
    }
    editor.allowReplacement = { [weak self] range, text in
      self?.canReplace(range, text: text) ?? false
    }
    addSubview(editor)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    editor.frame = bounds
  }

  private func attributes(_ run: RichRun) -> [NSAttributedString.Key: Any] {
    let base = run.code ? UIFont.monospacedSystemFont(ofSize: 17, weight: .regular) : UIFont.systemFont(ofSize: 17)
    var traits = base.fontDescriptor.symbolicTraits
    if run.bold { traits.insert(.traitBold) }
    if run.italic { traits.insert(.traitItalic) }
    let descriptor = base.fontDescriptor.withSymbolicTraits(traits) ?? base.fontDescriptor
    var result: [NSAttributedString.Key: Any] = [
      .font: UIFont(descriptor: descriptor, size: 17),
      .foregroundColor: UIColor.label,
      boldKey: run.bold,
      italicKey: run.italic,
      codeKey: run.code,
    ]
    if let link = run.link { result[.link] = link }
    return result
  }

  private func run(_ attrs: [NSAttributedString.Key: Any], text: String) -> RichRun {
    let traits = (attrs[.font] as? UIFont)?.fontDescriptor.symbolicTraits ?? []
    let link = (attrs[.link] as? String) ?? (attrs[.link] as? URL)?.absoluteString
    return RichRun(text: text, bold: attrs[boldKey] as? Bool ?? traits.contains(.traitBold), italic: attrs[italicKey] as? Bool ?? traits.contains(.traitItalic), code: attrs[codeKey] as? Bool ?? traits.contains(.traitMonoSpace), link: link)
  }

  private func runs(_ value: NSAttributedString) -> [RichRun] {
    var result: [RichRun] = []
    value.enumerateAttributes(in: NSRange(location: 0, length: value.length)) { attrs, range, _ in
      let next = run(attrs, text: (value.string as NSString).substring(with: range))
      if let last = result.last, last.bold == next.bold, last.italic == next.italic, last.code == next.code, last.link == next.link {
        result[result.count - 1].text += next.text
      } else {
        result.append(next)
      }
    }
    return result
  }

  private func runs() -> [RichRun] {
    runs(editor.attributedText ?? NSAttributedString(string: ""))
  }

  private func withinBudget(_ value: NSAttributedString) -> Bool {
    value.length <= 16_384 && runs(value).count <= 1_024
  }

  func setDocument(_ json: String) {
    guard let data = json.data(using: .utf8),
          let document = try? JSONDecoder().decode(RichDocument.self, from: data),
          document.version == 1,
          document.revision == revision,
          !editor.composing else { return }
    if initialized && runs() == document.runs { return }
    let value = NSMutableAttributedString(string: "")
    for item in document.runs {
      value.append(NSAttributedString(string: item.text, attributes: attributes(item)))
    }
    guard withinBudget(value) else { return }
    let selection = document.selection
    guard selection.start >= 0, selection.end >= selection.start, selection.end <= value.length else { return }
    applying = true
    editor.attributedText = value
    editor.selectedRange = NSRange(location: selection.start, length: selection.end - selection.start)
    if value.length > 0 {
      editor.typingAttributes = value.attributes(at: min(max(selection.start - 1, 0), value.length - 1), effectiveRange: nil)
    }
    editor.undoManager?.removeAllActions()
    initialized = true
    applying = false
    emit(change: false)
  }

  private func emit(change: Bool) {
    guard initialized, !applying else { return }
    let payload = snapshotPayload()
    if change { onSpacesChange(payload) } else { onSpacesSelection(payload) }
  }

  private func snapshotPayload() -> [String: Any] {
    let selection = editor.selectedRange
    let encodedRuns = (try? JSONEncoder().encode(runs())).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? []
    let typingRun = run(editor.typingAttributes, text: "")
    var typing: [String: Any] = ["bold": typingRun.bold, "italic": typingRun.italic, "code": typingRun.code]
    if let link = typingRun.link { typing["link"] = link }
    return [
      "version": 1,
      "revision": revision,
      "runs": encodedRuns,
      "selection": ["start": selection.location, "end": NSMaxRange(selection)],
      "composing": editor.composing,
      "typing": typing,
    ]
  }

  func setEditable(_ value: Bool) {
    editable = value
    editor.isEditable = editable && !paused
  }

  func freeze() -> String? {
    guard initialized, !editor.composing else { return nil }
    paused = true
    editor.isEditable = false
    guard let data = try? JSONSerialization.data(withJSONObject: snapshotPayload()) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func resume(_ expected: Int) -> Bool {
    guard initialized, editable, expected == revision, !editor.composing else { return false }
    paused = false
    editor.isEditable = true
    editor.becomeFirstResponder()
    return true
  }

  public func textViewDidChange(_ textView: UITextView) {
    guard !applying else { return }
    revision += 1
    wasComposing = editor.composing
    emit(change: true)
    invalidateIntrinsicContentSize()
  }

  public func textViewDidBeginEditing(_ textView: UITextView) {
    textView.undoManager?.levelsOfUndo = 50
  }

  public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    canReplace(range, text: text)
  }

  private func canReplace(_ range: NSRange, text: String) -> Bool {
    guard editable, !paused else { return false }
    let value = editor.attributedText ?? NSAttributedString(string: "")
    guard range.location <= value.length, NSMaxRange(range) <= value.length else { return false }
    if editor.undoManager?.isUndoing == true || editor.undoManager?.isRedoing == true { return true }
    let inserted = (text as NSString).length
    let candidate = NSMutableAttributedString(attributedString: value)
    candidate.deleteCharacters(in: range)
    var runCount = runs(candidate).count
    if inserted > 0 {
      let prefix = value.attributedSubstring(from: NSRange(location: 0, length: range.location))
      let suffix = value.attributedSubstring(from: NSRange(location: NSMaxRange(range), length: value.length - NSMaxRange(range)))
      // UIKit's delegate omits pasted attributes; reserve the worst case before it mutates text or undo.
      runCount = runs(prefix).count + inserted + runs(suffix).count
    }
    guard candidate.length + inserted <= 16_384, runCount <= 1_024 else {
      onSpacesLimit([:])
      return false
    }
    return true
  }

  public func textViewDidChangeSelection(_ textView: UITextView) {
    let composing = editor.composing
    let committed = wasComposing && !composing
    wasComposing = composing
    emit(change: committed)
  }

  private func restore(_ value: NSAttributedString, selection: NSRange, typing: [NSAttributedString.Key: Any]) {
    guard editable, !paused, withinBudget(value) else { return }
    let inverse = NSAttributedString(attributedString: editor.attributedText)
    let inverseSelection = editor.selectedRange
    let inverseTyping = editor.typingAttributes
    editor.undoManager?.registerUndo(withTarget: self) { target in
      target.restore(inverse, selection: inverseSelection, typing: inverseTyping)
    }
    applying = true
    editor.textStorage.setAttributedString(value)
    editor.selectedRange = selection
    editor.typingAttributes = typing
    applying = false
    revision += 1
    emit(change: true)
  }

  func format(_ json: String) -> Bool {
    guard let data = json.data(using: .utf8),
          let command = try? JSONDecoder().decode(FormatCommand.self, from: data),
          command.revision == revision, initialized, editable, !paused, !editor.composing,
          command.selection.start == editor.selectedRange.location,
          command.selection.end == NSMaxRange(editor.selectedRange),
          ["bold", "italic", "code"].contains(command.mark) else { return false }
    let value = NSMutableAttributedString(attributedString: editor.attributedText)
    let selection = editor.selectedRange
    func formatted(_ attrs: [NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any] {
      var item = run(attrs, text: "")
      switch command.mark {
      case "bold": item.bold = command.enabled
      case "italic": item.italic = command.enabled
      default: item.code = command.enabled
      }
      return attributes(item)
    }
    value.enumerateAttributes(in: selection) { attrs, range, _ in
      value.setAttributes(formatted(attrs), range: range)
    }
    guard withinBudget(value) else {
      onSpacesLimit([:])
      return false
    }
    restore(value, selection: selection, typing: formatted(editor.typingAttributes))
    return true
  }

  func history(_ backwards: Bool, revision expected: Int) -> Bool {
    guard initialized, editable, !paused, expected == revision, !editor.composing,
          let manager = editor.undoManager else { return false }
    if backwards {
      guard manager.canUndo else { return false }
      manager.undo()
    } else {
      guard manager.canRedo else { return false }
      manager.redo()
    }
    if revision == expected {
      revision += 1
      emit(change: true)
    }
    return true
  }
}
