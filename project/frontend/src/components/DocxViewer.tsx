import React, { useEffect, useRef, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'

// Live, high-fidelity .docx preview (docx-preview renders the real OOXML —
// layout, styles, images — to DOM). Read-only in v1: the agent edits the file
// on disk and we re-render on `reloadKey`, so the user watches each edit land.
// Clicking a paragraph reports its index + text up to the chat (click-to-target).

interface Props {
  relPath: string
  /** Bumped by IDEView whenever the agent writes this .docx → re-fetch + re-render. */
  reloadKey: number
  /** True while an agent run is active (shows a subtle "updating" affordance). */
  busy?: boolean
  onSelectParagraph: (sel: { path: string; index: number; text: string }) => void
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// Number the body paragraphs docx-preview rendered, in document order, so a
// click maps to a ¶index. Excludes table / header / footer paragraphs to match
// the engine's body-paragraph indexing (agent still gets the text to confirm).
function tagParagraphs(root: HTMLElement): void {
  const ps = root.querySelectorAll('article p, section.docx p, .docx p')
  let idx = 0
  const seen = new Set<Element>()
  ps.forEach((p) => {
    if (seen.has(p)) return
    if (p.closest('table')) return
    const cls = (p.closest('[class]')?.className || '') + ' ' + p.className
    if (/header|footer/i.test(cls)) return
    seen.add(p)
    ;(p as HTMLElement).dataset.pIndex = String(idx++)
  })
}

export function DocxViewer({ relPath, reloadKey, busy, onSelectParagraph }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      const host = hostRef.current
      if (!host) return
      try {
        const res = await window.api.workspaceReadFileBytes(relPath)
        if (cancelled) return
        if (!res.ok || !res.base64) throw new Error(res.error || 'could not read file')
        const { renderAsync } = await import('docx-preview')
        if (cancelled) return
        host.innerHTML = ''
        await renderAsync(b64ToBytes(res.base64), host, undefined, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          useBase64URL: true,
        })
        if (cancelled) return
        tagParagraphs(host)
        setError(null)
        setFlash(true)
        setTimeout(() => !cancelled && setFlash(false), 450)
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    setLoading(true)
    void render()
    return () => { cancelled = true }
  }, [relPath, reloadKey])

  const onClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-p-index]') as HTMLElement | null
    if (!el) return
    const index = Number(el.dataset.pIndex)
    const text = (el.textContent || '').trim()
    onSelectParagraph({ path: relPath, index, text })
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-zinc-800">
      <div className="h-8 border-b border-zinc-800 bg-zinc-950/80 flex items-center gap-2 px-3 flex-shrink-0 text-[11px] text-zinc-400">
        <FileText size={12} className="text-blue-400" />
        <span className="truncate">{relPath}</span>
        {busy && (
          <span className="ml-auto flex items-center gap-1 text-blue-400">
            <Loader2 size={11} className="animate-spin" /> agent editing…
          </span>
        )}
        <span className="ml-auto text-zinc-600">click a paragraph to target it →</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-xs gap-2 z-10">
            <Loader2 size={14} className="animate-spin" /> rendering document…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-rose-400 text-xs p-6 text-center">
            Couldn't render {relPath}: {error}
          </div>
        )}
        {/* docx-preview injects its own styled DOM here. The flash ring cues a fresh render. */}
        <div
          ref={hostRef}
          onClick={onClick}
          className={`docx-host min-h-full flex justify-center py-4 transition-shadow duration-300 ${flash ? 'ring-2 ring-blue-500/40 ring-inset' : ''}`}
        />
      </div>
    </div>
  )
}
