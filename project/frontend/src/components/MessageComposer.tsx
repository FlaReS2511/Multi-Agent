import { useState, KeyboardEvent } from 'react'

interface Props {
  to: string
  onSent: () => void
}

export function MessageComposer({ to, onSent }: Props) {
  const [body, setBody] = useState('')
  const [taskId, setTaskId] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    if (!body.trim() || sending) return
    setSending(true)
    try {
      await window.api.sendMessage({
        to,
        from: 'ui',
        taskId: taskId.trim() || 'T-000',
        body: body.trim(),
      })
      setBody('')
      onSent()
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/80 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          placeholder="T-000"
          className="w-20 px-2 py-1 text-xs font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
        />
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
          → {to}
        </span>
        <span className="ml-auto text-[10px] text-zinc-600">⌘+Enter to send</span>
      </div>
      <div className="flex gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={`Ask ${to} a question or send instructions...`}
          className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
        />
        <button
          onClick={send}
          disabled={!body.trim() || sending}
          className="px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors self-stretch"
        >
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </div>
  )
}
