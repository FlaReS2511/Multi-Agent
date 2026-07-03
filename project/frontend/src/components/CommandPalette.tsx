// CommandPalette.tsx — command palette (Ctrl+Shift+P) + quick-open (Ctrl+P).

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Search, Terminal, CornerDownLeft } from 'lucide-react'

export interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface Props {
  open: boolean
  mode: 'commands' | 'files'
  commands: Command[]
  files: string[]
  onClose: () => void
  onOpenFile: (file: string) => void
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1]
}

function dirname(p: string): string {
  const parts = p.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

// Rank files: startsWith basename > includes basename > includes path.
function rankFiles(files: string[], q: string): string[] {
  if (!q) return files.slice(0, 50)
  const lq = q.toLowerCase()
  const scored: { f: string; score: number }[] = []
  for (const f of files) {
    const base = basename(f).toLowerCase()
    const full = f.toLowerCase()
    let score = -1
    if (base.startsWith(lq)) score = 0
    else if (base.includes(lq)) score = 1
    else if (full.includes(lq)) score = 2
    if (score >= 0) scored.push({ f, score })
  }
  scored.sort((a, b) => a.score - b.score || a.f.length - b.f.length)
  return scored.slice(0, 50).map((s) => s.f)
}

export function CommandPalette({ open, mode, commands, files, onClose, onOpenFile }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open, mode])

  const fileResults = useMemo(
    () => (mode === 'files' ? rankFiles(files, query) : []),
    [mode, files, query],
  )
  const cmdResults = useMemo(
    () =>
      mode === 'commands'
        ? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
        : [],
    [mode, commands, query],
  )

  const count = mode === 'files' ? fileResults.length : cmdResults.length

  useEffect(() => {
    if (index >= count) setIndex(0)
  }, [count, index])

  if (!open) return null

  const select = (i: number) => {
    if (mode === 'files') {
      const f = fileResults[i]
      if (f) { onOpenFile(f); onClose() }
    } else {
      const c = cmdResults[i]
      if (c) { c.run(); onClose() }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (count ? (i + 1) % count : 0)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (count ? (i - 1 + count) % count : 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); select(index) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <motion.div
        className="absolute left-1/2 top-[15%] -translate-x-1/2 w-[640px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.98, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800">
          {mode === 'files' ? <Search size={15} className="text-zinc-500" /> : <Terminal size={15} className="text-zinc-500" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
            onKeyDown={onKeyDown}
            placeholder={mode === 'files' ? 'Go to file by name…' : 'Type a command…'}
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
          />
          <span className="flex items-center gap-1 text-[10px] text-zinc-600">
            <CornerDownLeft size={11} /> to run
          </span>
        </div>

        <div className="max-h-[50vh] overflow-y-auto py-1 scrollbar-thin">
          {count === 0 && (
            <div className="px-4 py-6 text-center text-xs text-zinc-600 italic">No results</div>
          )}

          {mode === 'files' && fileResults.map((f, i) => (
            <button
              key={f}
              onClick={() => select(i)}
              onMouseEnter={() => setIndex(i)}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm ${
                i === index ? 'bg-blue-600/20 text-white' : 'text-zinc-300 hover:bg-zinc-800/60'
              }`}
            >
              <span className="font-medium truncate">{basename(f)}</span>
              <span className="text-zinc-500 text-xs truncate">{dirname(f)}</span>
            </button>
          ))}

          {mode === 'commands' && cmdResults.map((c, i) => (
            <button
              key={c.id}
              onClick={() => select(i)}
              onMouseEnter={() => setIndex(i)}
              className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-2 text-sm ${
                i === index ? 'bg-blue-600/20 text-white' : 'text-zinc-300 hover:bg-zinc-800/60'
              }`}
            >
              <span className="truncate">{c.label}</span>
              {c.hint && <span className="text-zinc-600 text-[10px] font-mono">{c.hint}</span>}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
