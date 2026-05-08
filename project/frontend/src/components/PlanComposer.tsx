import { useEffect, useMemo, useRef, useState } from 'react'
import { DraftPlan } from '../lib/api'

type Status =
  | { kind: 'idle' }
  | { kind: 'sending-prompt' }
  | { kind: 'waiting-planner' }
  | { kind: 'approving' }
  | { kind: 'sent'; ts: string }
  | { kind: 'error'; message: string }

const STORAGE_KEY = 'planComposer.v1'

interface PersistedState {
  title: string
  body: string
  prompt: string
  answers: Record<number, string>
  bodyDirty: boolean
  titleDirty: boolean
  lastSeenMtime: string | null
}

function loadFromStorage(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<PersistedState>) : {}
  } catch {
    return {}
  }
}

function saveToStorage(s: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

function parseOpenQuestions(body: string): string[] {
  const lines = body.split('\n')
  let inSection = false
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (!inSection) {
      if (/^open questions/i.test(trimmed)) inSection = true
      continue
    }
    if (!trimmed) continue
    // End of section: section heading like [GOAL] or "Hãy plan..." or "---"
    if (/^\[/.test(trimmed) || /^hãy plan/i.test(trimmed) || trimmed.startsWith('---')) break
    const m = trimmed.match(/^(?:\d+\.|[-*])\s+(.+)$/)
    if (m) out.push(m[1].trim())
  }
  return out
}

export function PlanComposer() {
  const initial = useRef<Partial<PersistedState>>(loadFromStorage()).current

  const [title, setTitle] = useState<string>(initial.title || '')
  const [body, setBody] = useState<string>(initial.body || '')
  const [prompt, setPrompt] = useState<string>(initial.prompt || '')
  const [answers, setAnswers] = useState<Record<number, string>>(initial.answers || {})
  const [titleDirty, setTitleDirty] = useState<boolean>(initial.titleDirty || !!initial.title)
  const [bodyDirty, setBodyDirty] = useState<boolean>(initial.bodyDirty || !!initial.body)
  const [pendingDraft, setPendingDraft] = useState<DraftPlan | null>(null)
  const [draftMtime, setDraftMtime] = useState<string | null>(null)
  const [hasDraft, setHasDraft] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const lastSeenMtimeRef = useRef<string | null>(initial.lastSeenMtime || null)

  // Persist state
  useEffect(() => {
    saveToStorage({
      title,
      body,
      prompt,
      answers,
      bodyDirty,
      titleDirty,
      lastSeenMtime: lastSeenMtimeRef.current,
    })
  }, [title, body, prompt, answers, bodyDirty, titleDirty])

  // Poll draft every 2s
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const draft = await window.api.getDraftPlan()
        if (cancelled) return
        if (!draft) {
          setHasDraft(false)
          setDraftMtime(null)
          lastSeenMtimeRef.current = null
          setPendingDraft(null)
          return
        }
        setHasDraft(true)
        setDraftMtime(draft.updated_at)
        if (lastSeenMtimeRef.current === draft.updated_at) return
        lastSeenMtimeRef.current = draft.updated_at

        setStatus((prev) =>
          prev.kind === 'waiting-planner' ? { kind: 'idle' } : prev,
        )

        const localDirty = titleDirty || bodyDirty
        if (!localDirty) {
          setTitle(draft.title)
          setBody(draft.body)
          setPendingDraft(null)
        } else {
          setPendingDraft(draft)
        }
      } catch {
        /* ignore */
      }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [titleDirty, bodyDirty])

  const questions = useMemo(() => parseOpenQuestions(body), [body])

  const sendPrompt = async () => {
    const text = prompt.trim()
    if (!text) return
    setStatus({ kind: 'sending-prompt' })
    try {
      await window.api.sendToPlanner(text)
      setPrompt('')
      setStatus({ kind: 'waiting-planner' })
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to send prompt',
      })
    }
  }

  const sendAnswers = async () => {
    const filled = questions
      .map((q, i) => ({ idx: i, q, a: (answers[i] || '').trim() }))
      .filter((x) => x.a)
    if (filled.length === 0) return
    const text =
      'Trả lời open questions:\n\n' +
      filled
        .map((x, i) => `${i + 1}. **Q:** ${x.q}\n   **A:** ${x.a}`)
        .join('\n\n')
    setStatus({ kind: 'sending-prompt' })
    try {
      await window.api.sendToPlanner(text)
      setAnswers({})
      setStatus({ kind: 'waiting-planner' })
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to send answers',
      })
    }
  }

  const onPromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendPrompt()
    }
  }

  const refreshFromDraft = () => {
    if (!pendingDraft) return
    setTitle(pendingDraft.title)
    setBody(pendingDraft.body)
    setPendingDraft(null)
    setTitleDirty(false)
    setBodyDirty(false)
    setAnswers({})
  }

  const reset = () => {
    setTitle('')
    setBody('')
    setPrompt('')
    setAnswers({})
    setTitleDirty(false)
    setBodyDirty(false)
    setPendingDraft(null)
    setStatus({ kind: 'idle' })
    lastSeenMtimeRef.current = null
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }

  const approve = async () => {
    if (!title.trim() || !body.trim()) return
    setStatus({ kind: 'approving' })
    try {
      const res = await window.api.approvePlan({ title: title.trim(), body: body.trim() })
      setStatus({ kind: 'sent', ts: res.ts })
      setTitle('')
      setBody('')
      setAnswers({})
      setTitleDirty(false)
      setBodyDirty(false)
      setPendingDraft(null)
      lastSeenMtimeRef.current = null
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Approve failed',
      })
    }
  }

  const canApprove =
    !!title.trim() &&
    !!body.trim() &&
    status.kind !== 'approving' &&
    status.kind !== 'sending-prompt'

  const canSendPrompt = !!prompt.trim() && status.kind !== 'sending-prompt'
  const canSendAnswers =
    Object.values(answers).some((a) => a.trim()) && status.kind !== 'sending-prompt'

  const statusBadge = () => {
    switch (status.kind) {
      case 'sending-prompt':
        return <span className="text-amber-300">⟳ sending…</span>
      case 'waiting-planner':
        return (
          <span className="text-violet-300 animate-pulse">
            ⟳ planner đang suy nghĩ… (cập nhật tự động khi xong)
          </span>
        )
      case 'approving':
        return <span className="text-emerald-300">⟳ approving…</span>
      case 'sent':
        return (
          <span className="text-emerald-400">
            ✓ approved & sent at {status.ts} → orchestrator
          </span>
        )
      case 'error':
        return <span className="text-rose-400">⚠ {status.message}</span>
      default:
        return hasDraft ? (
          <span className="text-violet-300">
            ● draft from planner · {draftMtime ? new Date(draftMtime).toLocaleTimeString() : ''}
          </span>
        ) : (
          <span className="text-zinc-600">○ chưa có draft — gõ idea bên dưới rồi Enter</span>
        )
    }
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100">
      <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-100">
            Plan Composer
          </h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Gõ idea → Enter → Planner generate plan + title → edit → Approve
          </p>
        </div>
        <div className="text-[11px] font-mono">{statusBadge()}</div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <Field label="Title (auto-filled by planner, editable)">
          <input
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleDirty(true)
            }}
            placeholder="Planner sẽ điền title sau khi bạn gõ idea bên dưới…"
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </Field>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Plan body (editable)
            </div>
            {pendingDraft && (
              <button
                onClick={refreshFromDraft}
                className="text-[11px] px-2 py-0.5 rounded bg-violet-600/20 text-violet-300 border border-violet-500/30 hover:bg-violet-600/30 transition-colors"
              >
                ↻ Planner has new version — pull
              </button>
            )}
          </div>
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              setBodyDirty(true)
            }}
            rows={18}
            placeholder="[GOAL] ...&#10;[CONTEXT] ...&#10;[SCOPE] ...&#10;(planner sẽ điền sau khi nhận prompt)"
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono resize-y"
          />
        </div>

        {questions.length > 0 && (
          <div className="border border-amber-700/40 bg-amber-500/5 rounded p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
                Open questions từ Planner ({questions.length})
              </div>
              <button
                onClick={sendAnswers}
                disabled={!canSendAnswers}
                className="text-[11px] px-2 py-1 rounded bg-amber-600/40 hover:bg-amber-600/60 disabled:bg-zinc-800 disabled:text-zinc-600 text-amber-100 transition-colors"
              >
                Send answers to Planner ↩
              </button>
            </div>
            <div className="space-y-2.5">
              {questions.map((q, i) => (
                <div key={i} className="space-y-1">
                  <div className="text-xs text-zinc-300">
                    <span className="font-mono text-amber-400 mr-1.5">Q{i + 1}.</span>
                    {q}
                  </div>
                  <textarea
                    value={answers[i] || ''}
                    onChange={(e) =>
                      setAnswers((a) => ({ ...a, [i]: e.target.value }))
                    }
                    rows={2}
                    placeholder="Trả lời…"
                    className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/60 resize-y"
                  />
                </div>
              ))}
            </div>
            <p className="text-[10px] text-zinc-500">
              Trả lời câu nào cần thì gửi — câu trống bỏ qua. Planner sẽ refine draft theo answers.
            </p>
          </div>
        )}

        <div className="border-t border-zinc-800 pt-4">
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-1.5">
            Chat with Planner (Enter để gửi · Shift+Enter xuống dòng)
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKeyDown}
            rows={3}
            placeholder="vd: tôi muốn thêm tab Settings cho dashboard, lưu theme dark/light…"
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-500 resize-y"
          />
          <div className="flex justify-between items-center mt-2">
            <p className="text-[10px] text-zinc-600">
              Send → ghi inbox/planner.md + đánh thức Planner pane trong tmux.
            </p>
            <button
              onClick={sendPrompt}
              disabled={!canSendPrompt}
              className="px-3 py-1.5 text-xs font-medium bg-violet-600/80 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors"
            >
              Send to Planner ↩
            </button>
          </div>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
        <button
          onClick={reset}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Reset
        </button>
        <button
          onClick={approve}
          disabled={!canApprove}
          className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors"
        >
          {status.kind === 'approving'
            ? 'Approving…'
            : 'Approve & Send to Orchestrator →'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-1.5">
        {label}
      </div>
      {children}
    </label>
  )
}
