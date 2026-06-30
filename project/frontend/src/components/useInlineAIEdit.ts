// useInlineAIEdit.ts — wires the "Ask AI" inline-edit experience onto a Monaco
// editor instance.
//
// Flow:
//  1. User selects code → a floating "Ask AI" content widget appears at the
//     selection end (anchored, follows scroll).
//  2. User opens the prompt window, types an instruction, picks provider/model,
//     hits Generate.
//  3. The rewrite streams into a FLOATING CODE CARD anchored to the right of the
//     selection (raised above the editor with shadow/depth) — the editor itself
//     is untouched during preview.
//  4. Accept → the card SLIDES from its floating spot into the selection's
//     on-screen position; on arrival we replace the text via executeEdits and
//     flash a fading green highlight on the merged lines.
//     Reject/Discard → the card fades out and nothing changes.

import { useEffect, useRef, useState, useCallback } from 'react'

// Minimal Monaco typings we rely on (kept loose to avoid a hard monaco dep here).
type MonacoEditor = any
type Monaco = any

export interface InlineEditState {
  open: boolean
  // Prompt-window anchor (relative to the editor container).
  anchorTop: number
  anchorLeft: number
  streaming: boolean
  error: string | null
  preview: string
  hasResult: boolean
  // Floating result-card geometry (relative to the editor container).
  cardTop: number
  cardLeft: number
  // Slide destination = the selection's start position on screen.
  targetTop: number
  targetLeft: number
  // True while the accept slide animation is running.
  accepting: boolean
  language: string
}

export interface InlineEditController {
  state: InlineEditState
  openPrompt: () => void
  cancel: () => void
  generate: (instruction: string, provider: string, model?: string) => void
  accept: () => void          // begins the slide animation
  finishMerge: () => void     // called by the card when the slide completes
  reject: () => void
}

let reqCounter = 0

export function useInlineAIEdit(
  editorRef: React.MutableRefObject<MonacoEditor | null>,
  monacoRef: React.MutableRefObject<Monaco | null>,
  language: string,
): InlineEditController {
  const [state, setState] = useState<InlineEditState>({
    open: false,
    anchorTop: 0,
    anchorLeft: 0,
    streaming: false,
    error: null,
    preview: '',
    hasResult: false,
    cardTop: 0,
    cardLeft: 0,
    targetTop: 0,
    targetLeft: 0,
    accepting: false,
    language,
  })

  const selectionRef = useRef<any>(null)
  const widgetRef = useRef<any>(null)
  const reqIdRef = useRef<string | null>(null)
  const unsubsRef = useRef<(() => void)[]>([])
  const previewRef = useRef<string>('')

  // ── Floating "Ask AI" widget on non-empty selection ──────────
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return

    const widgetNode = document.createElement('div')
    widgetNode.className = 'inline-ai-widget'
    widgetNode.innerHTML = '✦ Ask AI'
    widgetNode.style.cssText =
      'background:#2563eb;color:#fff;font-size:11px;font-weight:600;padding:2px 8px;' +
      'border-radius:6px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);white-space:nowrap;'
    widgetNode.onclick = () => openPrompt()

    const widget = {
      getId: () => 'inline.ai.widget',
      getDomNode: () => widgetNode,
      getPosition: () => {
        const sel = editor.getSelection()
        if (!sel || sel.isEmpty()) return null
        return {
          position: { lineNumber: sel.endLineNumber, column: sel.endColumn },
          preference: [monaco.editor.ContentWidgetPositionPreference.BELOW,
                       monaco.editor.ContentWidgetPositionPreference.ABOVE],
        }
      },
    }
    widgetRef.current = widget
    editor.addContentWidget(widget)

    const sub = editor.onDidChangeCursorSelection(() => {
      editor.layoutContentWidget(widget)
    })

    return () => {
      sub.dispose()
      try { editor.removeContentWidget(widget) } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorRef.current, monacoRef.current])

  // Geometry of the current selection, in editor-container pixels.
  const computeGeometry = useCallback(() => {
    const editor = editorRef.current
    const sel = selectionRef.current ?? editor?.getSelection()
    if (!editor || !sel) {
      return { anchorTop: 60, anchorLeft: 60, cardTop: 60, cardLeft: 360, targetTop: 60, targetLeft: 60 }
    }
    const scrollTop = editor.getScrollTop()
    const scrollLeft = editor.getScrollLeft?.() ?? 0
    const startTop = editor.getTopForPosition(sel.startLineNumber, sel.startColumn) - scrollTop
    const endTop = editor.getTopForPosition(sel.endLineNumber, sel.endColumn) - scrollTop
    const startLeft = editor.getOffsetForColumn(sel.startLineNumber, sel.startColumn) - scrollLeft
    const endLeft = editor.getOffsetForColumn(sel.endLineNumber, sel.endColumn) - scrollLeft
    const layout = editor.getLayoutInfo?.() ?? { width: 800, contentLeft: 64 }
    // Card floats to the right of the widest selection edge, raised above content.
    const rightEdge = Math.max(startLeft, endLeft) + (layout.contentLeft ?? 64) + 24
    const cardLeft = Math.min(rightEdge, (layout.width ?? 800) - 380)
    return {
      anchorTop: Math.max(8, endTop + 22),
      anchorLeft: Math.max(8, startLeft + (layout.contentLeft ?? 64)),
      cardTop: Math.max(8, startTop),
      cardLeft: Math.max(120, cardLeft),
      targetTop: Math.max(0, startTop),
      targetLeft: Math.max(0, startLeft + (layout.contentLeft ?? 64)),
    }
  }, [editorRef])

  const openPrompt = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const sel = editor.getSelection()
    if (!sel || sel.isEmpty()) return
    selectionRef.current = sel
    const g = computeGeometry()
    setState((s) => ({
      ...s, open: true, error: null, preview: '', hasResult: false, accepting: false,
      anchorTop: g.anchorTop, anchorLeft: g.anchorLeft,
    }))
  }, [editorRef, computeGeometry])

  const cleanupStream = useCallback(() => {
    unsubsRef.current.forEach((u) => u())
    unsubsRef.current = []
  }, [])

  const generate = useCallback((instruction: string, provider: string, model?: string) => {
    const editor = editorRef.current
    const sel = selectionRef.current
    if (!editor || !sel) return
    const modelObj = editor.getModel()
    const selection = modelObj.getValueInRange(sel)
    const fullValue: string = modelObj.getValue()
    const startOffset = modelObj.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn })
    const endOffset = modelObj.getOffsetAt({ lineNumber: sel.endLineNumber, column: sel.endColumn })
    const prefix = fullValue.slice(0, startOffset)
    const suffix = fullValue.slice(endOffset)

    const g = computeGeometry()
    const reqId = `inline-${++reqCounter}-${Date.now()}`
    reqIdRef.current = reqId
    previewRef.current = ''
    setState((s) => ({
      ...s, streaming: true, error: null, preview: '', hasResult: false, accepting: false,
      cardTop: g.cardTop, cardLeft: g.cardLeft, targetTop: g.targetTop, targetLeft: g.targetLeft,
    }))

    const offChunk = window.api.onAiInlineChunk(reqId, (delta) => {
      previewRef.current += delta
      setState((s) => ({ ...s, preview: previewRef.current }))
    })
    const offDone = window.api.onAiInlineDone(reqId, (info) => {
      cleanupStream()
      if (info.ok) {
        const finalText = info.text ?? previewRef.current
        previewRef.current = finalText
        setState((s) => ({ ...s, streaming: false, preview: finalText, hasResult: true }))
      } else {
        setState((s) => ({ ...s, streaming: false, error: info.error ?? 'failed' }))
      }
    })
    unsubsRef.current = [offChunk, offDone]

    window.api.aiInlineEdit(reqId, {
      provider, model, instruction, selection,
      language, prefix, suffix,
    }).catch((e) => {
      cleanupStream()
      setState((s) => ({ ...s, streaming: false, error: String(e) }))
    })
  }, [editorRef, language, computeGeometry, cleanupStream])

  // Accept just flips `accepting` — the card component runs the slide animation
  // and calls finishMerge() when it lands on the target.
  const accept = useCallback(() => {
    // Recompute target in case the user scrolled.
    const g = computeGeometry()
    setState((s) => ({ ...s, accepting: true, targetTop: g.targetTop, targetLeft: g.targetLeft }))
  }, [computeGeometry])

  const finishMerge = useCallback(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const sel = selectionRef.current
    if (!editor || !monaco || !sel) {
      setState((s) => ({ ...s, open: false, accepting: false, hasResult: false, preview: '' }))
      return
    }
    const text = previewRef.current
    const startLine = sel.startLineNumber
    const newLineCount = Math.max(1, text.split('\n').length)
    editor.executeEdits('inline-ai', [{ range: sel, text, forceMoveMarkers: true }])

    const decorations = editor.deltaDecorations([], [{
      range: new monaco.Range(startLine, 1, startLine + newLineCount - 1, 1),
      options: { isWholeLine: true, className: 'inline-ai-accepted-line' },
    }])
    setTimeout(() => {
      try { editor.deltaDecorations(decorations, []) } catch { /* ignore */ }
    }, 1600)

    setState((s) => ({ ...s, open: false, streaming: false, preview: '', hasResult: false, accepting: false }))
  }, [editorRef, monacoRef])

  const reject = useCallback(() => {
    if (reqIdRef.current) window.api.aiInlineCancel(reqIdRef.current).catch(() => {})
    cleanupStream()
    setState((s) => ({
      ...s, open: false, streaming: false, preview: '', hasResult: false, error: null, accepting: false,
    }))
  }, [cleanupStream])

  const cancel = reject

  return { state, openPrompt, cancel, generate, accept, finishMerge, reject }
}
