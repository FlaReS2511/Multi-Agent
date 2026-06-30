// InlineAIPrompt.tsx — the floating prompt window for the inline "Ask AI"
// feature. Anchored next to the selection; fades + scales in via framer-motion.
// It only collects the instruction + provider/model and kicks off generation.
// The streamed/generated code is shown separately by <InlineAICard/>, so this
// window hides itself once a result is in flight.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, X } from 'lucide-react'
import { InlineEditState } from './useInlineAIEdit'
import { ModelOption } from '../lib/api'

interface Props {
  state: InlineEditState
  models: ModelOption[]
  defaultProvider?: string
  defaultModel?: string
  onGenerate: (instruction: string, provider: string, model?: string) => void
  onReject: () => void
}

export function InlineAIPrompt({
  state, models, defaultProvider, defaultModel, onGenerate, onReject,
}: Props) {
  const [instruction, setInstruction] = useState('')
  const [provider, setProvider] = useState(defaultProvider ?? '')
  const [model, setModel] = useState(defaultModel ?? '')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (state.open) {
      setInstruction('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [state.open])

  useEffect(() => {
    if (!provider && models.length > 0) {
      setProvider(models[0].provider)
      setModel(models[0].id)
    }
  }, [models, provider])

  // Hide the prompt window once we have a result (the floating card takes over).
  if (!state.open || state.hasResult) return null

  const providerIds = Array.from(new Set(models.map((m) => m.provider)))
  const providerModels = models.filter((m) => m.provider === provider)

  const submit = () => {
    if (!instruction.trim() || state.streaming) return
    onGenerate(instruction.trim(), provider, model || undefined)
  }

  const top = Math.min(state.anchorTop, 9999)
  const left = Math.min(state.anchorLeft, 9999)

  return (
    <motion.div
      className="absolute z-40 w-[420px] max-w-[90%] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
      style={{ top, left }}
      initial={{ opacity: 0, scale: 0.92, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, y: -6 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-blue-300">
          <Sparkles size={13} /> Ask AI to edit selection
        </span>
        <button onClick={onReject} className="text-zinc-500 hover:text-zinc-200">
          <X size={14} />
        </button>
      </div>

      <div className="p-3 flex flex-col gap-2">
        <textarea
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
            if (e.key === 'Escape') onReject()
          }}
          placeholder="e.g. add error handling, convert to async, add docstrings…"
          rows={2}
          className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 resize-none focus:outline-none focus:border-blue-500"
        />

        <div className="flex items-center gap-2">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value)
              const first = models.find((m) => m.provider === e.target.value)
              setModel(first?.id ?? '')
            }}
            className="px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-[11px] text-zinc-200"
          >
            {providerIds.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-[11px] text-zinc-200"
          >
            {providerModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>

        {state.error && (
          <div className="px-2 py-1 text-[11px] rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">
            {state.error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={submit}
            disabled={!instruction.trim() || state.streaming}
            className="px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors flex items-center gap-1.5"
          >
            {state.streaming ? (
              <><span className="size-1.5 rounded-full bg-white animate-pulse" /> Generating…</>
            ) : (
              <><Sparkles size={12} /> Generate</>
            )}
          </button>
        </div>
      </div>
    </motion.div>
  )
}
