package expo.modules.t2spaceseditor

import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.Typeface
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Html
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.TextWatcher
import android.text.style.MetricAffectingSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.URLSpan
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject

internal data class RichStyle(
  val bold: Boolean = false,
  val italic: Boolean = false,
  val code: Boolean = false,
  val link: String? = null
)

private class RichSpan(val style: RichStyle) : MetricAffectingSpan() {
  override fun updateMeasureState(paint: TextPaint) = apply(paint)
  override fun updateDrawState(paint: TextPaint) = apply(paint)

  private fun apply(paint: TextPaint) {
    val flags = (if (style.bold) Typeface.BOLD else 0) or (if (style.italic) Typeface.ITALIC else 0)
    paint.typeface = Typeface.create(if (style.code) "monospace" else "sans-serif", flags)
    paint.isUnderlineText = style.link != null
  }
}

private data class RichSnapshot(
  val value: SpannableStringBuilder,
  val start: Int,
  val end: Int,
  val typing: RichStyle
)

private data class RichSegment(val start: Int, val end: Int, val style: RichStyle)

class T2SpacesEditorView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  internal val editor = SpacesEditText(context)
  private val onSpacesChange by EventDispatcher()
  private val onSpacesSelection by EventDispatcher()
  private val onSpacesLimit by EventDispatcher()
  private var revision = 0
  private var initialized = false
  private var applying = false
  private var typing = RichStyle()
  private var insertedStart = 0
  private var insertedCount = 0
  private var before: RichSnapshot? = null
  private var editingText = false
  private var rejectedInput = false
  private var startingComposition = false
  private var compositionBefore: RichSnapshot? = null
  private val undo = ArrayDeque<RichSnapshot>()
  private val redo = ArrayDeque<RichSnapshot>()

  init {
    editor.setBackgroundColor(Color.TRANSPARENT)
    editor.gravity = Gravity.TOP or Gravity.START
    editor.setTextColor(Color.BLACK)
    editor.textSize = 17f
    editor.setPadding(0, 0, 0, 0)
    editor.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    editor.filters = arrayOf(
      InputFilter { _, start, end, dest, from, to ->
        rejectedInput = false
        if (applying || !initialized) return@InputFilter null
        if (!canReplace(dest, from, to, end - start)) {
          rejectedInput = true
          dest.subSequence(from, to)
        } else {
          null
        }
      }
    )
    editor.contentDescription = "Spaces block text"
    addView(editor, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    editor.selectionChanged = {
      if (!applying && initialized) {
        val text = editor.text
        if (!editingText && text != null && text.isNotEmpty()) {
          val start = minOf(editor.selectionStart, editor.selectionEnd)
          typing = styleAt(text, (start - 1).coerceIn(0, text.length - 1))
        }
        emit(false)
      }
    }
    editor.compositionChanged = {
      startingComposition = false
      if (!composing()) {
        applying = true
        editor.text?.let { applySegments(it, segments(it)) }
        applying = false
        compositionBefore?.let { remember(it) }
        compositionBefore = null
      }
      emit(true)
    }
    editor.compositionStarting = {
      startingComposition = true
      if (compositionBefore == null) compositionBefore = snapshot()
    }
    editor.history = { backwards -> travel(backwards) }
    editor.copyRich = { cut -> copySelection(cut) }
    editor.allowReplacement = { replacement ->
      val text = editor.text
      if (text == null) {
        false
      } else {
        val composingStart = BaseInputConnection.getComposingSpanStart(text)
        val composingEnd = BaseInputConnection.getComposingSpanEnd(text)
        val anchor = if (composingStart >= 0 && composingEnd >= 0) {
          composingStart
        } else {
          editor.selectionStart
        }
        val focus = if (composingStart >= 0 && composingEnd >= 0) {
          composingEnd
        } else {
          editor.selectionEnd
        }
        canReplace(text, minOf(anchor, focus), maxOf(anchor, focus), replacement?.length ?: 0)
      }
    }
    editor.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {
        if (!applying) {
          before = snapshot()
          editingText = true
        }
      }

      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {
        insertedStart = start
        insertedCount = count
      }

      override fun afterTextChanged(text: Editable?) {
        if (applying || text == null || !initialized) return
        if (rejectedInput) {
          rejectedInput = false
          before = null
          editingText = false
          return
        }
        applyTypingStyle(text)
        before?.let {
          if (composing()) {
            if (compositionBefore == null) compositionBefore = it
          } else if (compositionBefore == null) {
            remember(it)
          }
        }
        before = null
        editingText = false
        if (!composing() && compositionBefore == null) {
          applying = true
          applySegments(text, segments(text))
          applying = false
        }
        revision += 1
        emit(true)
      }
    })
  }

  private fun applyTypingStyle(text: Editable) {
    if (insertedCount <= 0) return
    val end = (insertedStart + insertedCount).coerceAtMost(text.length)
    val styledPaste = editor.pasting && (
      text.getSpans(insertedStart, end, StyleSpan::class.java).isNotEmpty() ||
        text.getSpans(insertedStart, end, URLSpan::class.java).isNotEmpty() ||
        text.getSpans(insertedStart, end, TypefaceSpan::class.java).isNotEmpty()
      )
    if (styledPaste) return
    // Split inherited spans so an explicit caret format also takes effect inside a run.
    text.getSpans(insertedStart, end, RichSpan::class.java).forEach { span ->
      val from = text.getSpanStart(span)
      val to = text.getSpanEnd(span)
      text.removeSpan(span)
      if (from < insertedStart) {
        text.setSpan(RichSpan(span.style), from, insertedStart, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
      if (to > end) {
        text.setSpan(RichSpan(span.style), end, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    }
    text.setSpan(RichSpan(typing), insertedStart, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  private fun composing(): Boolean = startingComposition || (
    editor.text?.let {
      BaseInputConnection.getComposingSpanStart(it) >= 0
    } ?: false
    )

  private fun styleAt(text: Spanned, index: Int): RichStyle {
    val base =
      text.getSpans(index, index + 1, RichSpan::class.java).lastOrNull()?.style ?: RichStyle()
    val nativeStyles = text.getSpans(index, index + 1, StyleSpan::class.java)
    val faces = text.getSpans(index, index + 1, TypefaceSpan::class.java)
    val styles = nativeStyles.fold(0) { value, span -> value or span.style }
    return RichStyle(
      bold = if (nativeStyles.isEmpty()) base.bold else styles and Typeface.BOLD != 0,
      italic = if (nativeStyles.isEmpty()) base.italic else styles and Typeface.ITALIC != 0,
      code = if (faces.isEmpty()) base.code else faces.any { it.family == "monospace" },
      link = text.getSpans(index, index + 1, URLSpan::class.java).lastOrNull()?.url ?: base.link,
    )
  }

  private fun styleJson(style: RichStyle, text: String): Map<String, Any> = buildMap {
    put("text", text)
    put("bold", style.bold)
    put("italic", style.italic)
    put("code", style.code)
    style.link?.let { put("link", it) }
  }

  private fun segments(text: Spanned): List<RichSegment> {
    val result = mutableListOf<RichSegment>()
    var start = 0
    while (start < text.length) {
      val style = styleAt(text, start)
      var end = text.nextSpanTransition(start, text.length, MetricAffectingSpan::class.java)
      end = minOf(end, text.nextSpanTransition(start, text.length, URLSpan::class.java))
      while (end < text.length && styleAt(text, end) == style) {
        end = minOf(
          text.nextSpanTransition(end, text.length, MetricAffectingSpan::class.java),
          text.nextSpanTransition(end, text.length, URLSpan::class.java),
        )
      }
      result.add(RichSegment(start, end, style))
      start = end
    }
    return result
  }

  private fun runs(): List<Map<String, Any>> {
    val text = editor.text ?: return emptyList()
    return segments(text).map { styleJson(it.style, text.subSequence(it.start, it.end).toString()) }
  }

  private fun withinBudget(value: Spanned): Boolean =
    value.length <= 16_384 && segments(value).size <= 1_024

  private fun canReplace(text: Spanned, start: Int, end: Int, inserted: Int): Boolean {
    if (start < 0 || end < start || end > text.length) return false
    val candidate = SpannableStringBuilder(text).delete(start, end)
    // Reserve arbitrary pasted attributes before Editable or the IME can mutate the destination.
    val runCount = if (inserted == 0) {
      segments(candidate).size
    } else {
      segments(SpannableStringBuilder(text, 0, start)).size + inserted +
        segments(SpannableStringBuilder(text, end, text.length)).size
    }
    val accepted = candidate.length + inserted <= 16_384 && runCount <= 1_024
    if (!accepted) {
      onSpacesLimit(emptyMap<String, Any>())
    }
    return accepted
  }

  private fun applySegments(text: Editable, values: List<RichSegment>) {
    text.getSpans(0, text.length, RichSpan::class.java).forEach { text.removeSpan(it) }
    text.getSpans(0, text.length, StyleSpan::class.java).forEach { text.removeSpan(it) }
    text.getSpans(0, text.length, TypefaceSpan::class.java).forEach { text.removeSpan(it) }
    text.getSpans(0, text.length, URLSpan::class.java).forEach { text.removeSpan(it) }
    values.forEach {
      text.setSpan(RichSpan(it.style), it.start, it.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
  }

  private fun copySelection(cut: Boolean): Boolean {
    if (composing()) return false
    return editor.text?.let { copySelection(it, cut) } ?: false
  }

  private fun copySelection(text: Editable, cut: Boolean): Boolean {
    val start = minOf(editor.selectionStart, editor.selectionEnd)
    val end = maxOf(editor.selectionStart, editor.selectionEnd)
    if (start < 0 || end <= start) return false
    val value = SpannableStringBuilder(text, start, end)
    val values = segments(value)
    value.getSpans(0, value.length, RichSpan::class.java).forEach { value.removeSpan(it) }
    values.forEach {
      val flags =
        (if (it.style.bold) Typeface.BOLD else 0) or (if (it.style.italic) Typeface.ITALIC else 0)
      if (flags != 0) {
        value.setSpan(StyleSpan(flags), it.start, it.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
      if (it.style.code) {
        value.setSpan(
          TypefaceSpan("monospace"),
          it.start,
          it.end,
          Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
      }
      it.style.link?.let { link ->
        value.setSpan(URLSpan(link), it.start, it.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    }
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    return clipboard?.let {
      it.setPrimaryClip(
        ClipData.newHtmlText(
          "Spaces",
          value.toString(),
          Html.toHtml(value, Html.TO_HTML_PARAGRAPH_LINES_CONSECUTIVE)
        ),
      )
      if (cut) text.delete(start, end)
      true
    } ?: false
  }

  private fun emit(change: Boolean) {
    if (applying || !initialized) return
    val payload = mapOf(
      "version" to 1,
      "revision" to revision,
      "runs" to runs(),
      "selection" to mapOf(
        "start" to minOf(editor.selectionStart, editor.selectionEnd).coerceAtLeast(0),
        "end" to maxOf(editor.selectionStart, editor.selectionEnd).coerceAtLeast(0),
      ),
      "composing" to composing(),
      "typing" to styleJson(typing, "").filterKeys { it != "text" },
    )
    if (change) onSpacesChange(payload) else onSpacesSelection(payload)
  }

  fun setDocument(json: String) {
    val document = runCatching { JSONObject(json) }.getOrNull()?.takeIf {
      it.optInt("version") == 1 && it.optInt("revision", -1) == revision && !composing()
    } ?: return
    val value = parseRuns(document) ?: return
    if (withinBudget(value)) {
      val unchanged = initialized && editor.text.toString() == value.toString() && sameStyles(value)
      if (!unchanged) applyDocument(document, value)
    }
  }

  private fun parseRuns(document: JSONObject): SpannableStringBuilder? {
    return document.optJSONArray("runs")?.let { incoming ->
      val value = SpannableStringBuilder()
      for (index in 0 until incoming.length()) {
        val run = incoming.optJSONObject(index) ?: return null
        val start = value.length
        value.append(run.optString("text"))
        if (value.length > start) {
          val style = RichStyle(
            run.optBoolean("bold"),
            run.optBoolean("italic"),
            run.optBoolean("code"),
            if (run.has("link") && !run.isNull("link")) run.getString("link") else null,
          )
          value.setSpan(RichSpan(style), start, value.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
      }
      value
    }
  }

  private fun applyDocument(document: JSONObject, value: SpannableStringBuilder) {
    val selection = document.optJSONObject("selection") ?: return
    val start = selection.optInt("start", -1)
    val end = selection.optInt("end", -1)
    if (start < 0 || end < start || end > value.length) return
    applying = true
    editor.setText(value)
    editor.setSelection(start, end)
    typing =
      if (value.isEmpty()) {
        RichStyle()
      } else {
        styleAt(value, (start - 1).coerceIn(0, value.length - 1))
      }
    undo.clear()
    redo.clear()
    initialized = true
    applying = false
    emit(false)
  }

  private fun snapshot(): RichSnapshot {
    val value = SpannableStringBuilder(editor.text)
    BaseInputConnection.removeComposingSpans(value)
    return RichSnapshot(
      value,
      editor.selectionStart.coerceAtLeast(0),
      editor.selectionEnd.coerceAtLeast(0),
      typing
    )
  }

  private fun sameStyles(value: Spanned): Boolean {
    val current = editor.text ?: return value.isEmpty()
    return sameStyles(current, value)
  }

  private fun sameStyles(current: Spanned, value: Spanned): Boolean {
    var index = 0
    while (index < value.length) {
      if (styleAt(current, index) != styleAt(value, index)) return false
      index = minOf(
        current.nextSpanTransition(index, value.length, MetricAffectingSpan::class.java),
        current.nextSpanTransition(index, value.length, URLSpan::class.java),
        value.nextSpanTransition(index, value.length, RichSpan::class.java),
      )
    }
    return true
  }

  private fun remember(value: RichSnapshot) {
    val current = editor.text ?: return
    if (
      value.value.toString() == current.toString() && segments(value.value) == segments(current) &&
      value.typing == typing
    ) {
      return
    }
    undo.addLast(value)
    if (undo.size > 50) undo.removeFirst()
    redo.clear()
  }

  private fun travel(backwards: Boolean): Boolean =
    if (composing() || !initialized) false else restoreHistory(backwards)

  private fun restoreHistory(backwards: Boolean): Boolean {
    val source = if (backwards) undo else redo
    val destination = if (backwards) redo else undo
    val value = source.lastOrNull()
    if (value == null || !withinBudget(value.value)) return false
    source.removeLast()
    destination.addLast(snapshot())
    applying = true
    editor.setText(value.value)
    editor.setSelection(value.start, value.end)
    typing = value.typing
    applying = false
    revision += 1
    emit(true)
    return true
  }

  fun history(backwards: Boolean, expectedRevision: Int): Boolean =
    expectedRevision == revision && travel(backwards)

  fun format(json: String): Boolean {
    val command = runCatching { JSONObject(json) }.getOrNull()?.takeIf {
      initialized && !composing() && it.optInt("revision", -1) == revision
    } ?: return false
    return if (command.optString("mark") in listOf("bold", "italic", "code")) {
      editor.text?.let { format(it, command) } ?: false
    } else {
      false
    }
  }

  private fun matchesSelection(command: JSONObject, start: Int, end: Int): Boolean {
    val selection = command.optJSONObject("selection") ?: return false
    return selection.optInt("start", -1) == start && selection.optInt("end", -1) == end
  }

  private fun format(text: Editable, command: JSONObject): Boolean {
    val mark = command.optString("mark")
    val enabled = command.optBoolean("enabled")
    fun updated(style: RichStyle) = when (mark) {
      "bold" -> style.copy(bold = enabled)
      "italic" -> style.copy(italic = enabled)
      else -> style.copy(code = enabled)
    }
    val start = minOf(editor.selectionStart, editor.selectionEnd)
    val end = maxOf(editor.selectionStart, editor.selectionEnd)
    if (start < 0 || !matchesSelection(command, start, end)) return false
    // Rebuild spans, never text, so formatting does not disturb the native selection.
    val values = segments(text).flatMap { segment ->
      val boundaries = listOf(segment.start, segment.end, start, end)
        .filter { it in segment.start..segment.end }.distinct().sorted()
      boundaries.zipWithNext { from, to ->
        RichSegment(
          from,
          to,
          if (from >= start && to <= end) {
            updated(segment.style)
          } else {
            segment.style
          }
        )
      }
    }
    val candidate = SpannableStringBuilder(text)
    applySegments(candidate, values)
    return if (!withinBudget(candidate)) {
      onSpacesLimit(emptyMap<String, Any>())
      false
    } else {
      val previous = snapshot()
      applying = true
      applySegments(text, values)
      applying = false
      typing = updated(typing)
      remember(previous)
      revision += 1
      emit(true)
      true
    }
  }
}

internal class SpacesEditText(context: Context) : EditText(context) {
  var selectionChanged: (() -> Unit)? = null
  var compositionChanged: (() -> Unit)? = null
  var compositionStarting: (() -> Unit)? = null
  var history: ((Boolean) -> Boolean)? = null
  var copyRich: ((Boolean) -> Boolean)? = null
  var allowReplacement: ((CharSequence?) -> Boolean)? = null
  var pasting = false
    private set

  override fun onSelectionChanged(start: Int, end: Int) {
    super.onSelectionChanged(start, end)
    selectionChanged?.invoke()
  }

  override fun onTextContextMenuItem(id: Int): Boolean = when (id) {
    android.R.id.undo -> history?.invoke(true) ?: false
    android.R.id.redo -> history?.invoke(false) ?: false
    android.R.id.copy -> copyRich?.invoke(false) ?: false
    android.R.id.cut -> copyRich?.invoke(true) ?: false
    else -> {
      pasting = id == android.R.id.paste || id == android.R.id.pasteAsPlainText
      try {
        super.onTextContextMenuItem(id)
      } finally {
        pasting = false
      }
    }
  }

  override fun onKeyShortcut(keyCode: Int, event: KeyEvent): Boolean {
    if (!event.isCtrlPressed) return super.onKeyShortcut(keyCode, event)
    return when (keyCode) {
      KeyEvent.KEYCODE_Z -> history?.invoke(!event.isShiftPressed) ?: false
      KeyEvent.KEYCODE_Y -> history?.invoke(false) ?: false
      KeyEvent.KEYCODE_C -> onTextContextMenuItem(android.R.id.copy)
      KeyEvent.KEYCODE_X -> onTextContextMenuItem(android.R.id.cut)
      KeyEvent.KEYCODE_V -> onTextContextMenuItem(
        if (event.isShiftPressed) android.R.id.pasteAsPlainText else android.R.id.paste,
      )
      else -> super.onKeyShortcut(keyCode, event)
    }
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs) ?: return null
    return object : InputConnectionWrapper(connection, false) {
      override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
        if (allowReplacement?.invoke(text) == false) return false
        compositionStarting?.invoke()
        val result = super.setComposingText(text, newCursorPosition)
        compositionChanged?.invoke()
        return result
      }

      override fun setComposingRegion(start: Int, end: Int): Boolean {
        compositionStarting?.invoke()
        val result = super.setComposingRegion(start, end)
        compositionChanged?.invoke()
        return result
      }

      override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        if (allowReplacement?.invoke(text) == false) return false
        val result = super.commitText(text, newCursorPosition)
        compositionChanged?.invoke()
        return result
      }

      override fun finishComposingText(): Boolean {
        val result = super.finishComposingText()
        compositionChanged?.invoke()
        return result
      }
    }
  }

  override fun onFocusChanged(focused: Boolean, direction: Int, rect: android.graphics.Rect?) {
    super.onFocusChanged(focused, direction, rect)
    if (focused) {
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
        ?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
  }
}
