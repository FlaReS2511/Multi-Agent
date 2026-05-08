import { useState, useEffect } from 'react'
import { AgentName, Priority, Task } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
  existingTasks: Task[]
  agents: string[]
}

export function NewTaskDialog({ open, onClose, onCreated, existingTasks, agents }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [owner, setOwner] = useState<AgentName>('orchestrator')
  const [priority, setPriority] = useState<Priority>('medium')
  const [deps, setDeps] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTitle('')
      setDescription('')
      setOwner('orchestrator')
      setPriority('medium')
      setDeps([])
      setError(null)
    }
  }, [open])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const submit = async () => {
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await window.api.createTask({
        title: title.trim(),
        description: description.trim(),
        owner,
        priority,
        deps,
      })
      onCreated()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task')
    } finally {
      setSubmitting(false)
    }
  }

  const toggleDep = (id: string) => {
    setDeps((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-100">New Task</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          <Field label="Title">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="e.g. Implement CSV parser"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </Field>

          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Spec, acceptance criteria, links..."
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-y"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Assign to">
              <select
                value={owner}
                onChange={(e) => setOwner(e.target.value as AgentName)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
              >
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Priority">
              <div className="flex gap-1">
                {(['low', 'medium', 'high'] as Priority[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`flex-1 px-2 py-2 text-xs font-medium rounded border transition-colors ${
                      priority === p
                        ? 'bg-zinc-700 border-zinc-600 text-white'
                        : 'bg-zinc-950 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          {existingTasks.length > 0 && (
            <Field label={`Dependencies (${deps.length} selected)`}>
              <div className="max-h-32 overflow-y-auto bg-zinc-950 border border-zinc-700 rounded p-2 space-y-1">
                {existingTasks.map((t) => (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-800/50 cursor-pointer text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={deps.includes(t.id)}
                      onChange={() => toggleDep(t.id)}
                      className="accent-blue-500"
                    />
                    <span className="font-mono text-zinc-500">{t.id}</span>
                    <span className="text-zinc-300 truncate">{t.title}</span>
                    <span className="ml-auto text-[10px] text-zinc-600">{t.status}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}

          {error && (
            <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !title.trim()}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors"
          >
            {submitting ? 'Creating...' : 'Create & Send'}
          </button>
        </div>
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
