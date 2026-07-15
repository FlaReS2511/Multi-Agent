// ShellTerminal.tsx — a real interactive shell (pwsh/bash) running in the
// workspace root, for the user to run npm/git/python etc. Separate from the
// agent PTYs. Cmd/Ctrl+F opens an in-terminal search overlay (SearchAddon).

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

interface Props {
  id: string
  active: boolean
}

export function ShellTerminal({ id, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  // Cmd/Ctrl+F in-terminal search overlay.
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SF Mono, JetBrains Mono, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#a1a1aa',
      },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // Cmd/Ctrl+F opens the search overlay instead of reaching the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        setSearchOpen(true)
        return false
      }
      return true
    })

    requestAnimationFrame(() => {
      fit.fit()
      window.api.shellStart(id).then((res) => {
        if (!res.ok) {
          term.write(`\r\n\x1b[31m[shell unavailable: ${res.error ?? 'error'}]\x1b[0m\r\n`)
          return
        }
        if (res.history) term.write(res.history)
        window.api.shellResize(id, term.cols, term.rows)
      })
    })

    const offData = window.api.onShellData(id, (data) => term.write(data))
    const offExit = window.api.onShellExit(id, ({ exitCode }) => {
      term.write(`\r\n\x1b[33m[shell exited: ${exitCode}]\x1b[0m\r\n`)
    })
    const dataDisposable = term.onData((data) => window.api.shellWrite(id, data))
    const resizeDisposable = term.onResize(({ cols, rows }) => window.api.shellResize(id, cols, rows))

    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
    })
    ro.observe(containerRef.current)

    return () => {
      offData()
      offExit()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [id])

  useEffect(() => {
    if (active && termRef.current && fitRef.current) {
      requestAnimationFrame(() => {
        try { fitRef.current!.fit(); termRef.current!.focus() } catch { /* ignore */ }
      })
    }
  }, [active])

  // Focus the search input when the overlay opens.
  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [searchOpen])

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    try { searchRef.current?.clearDecorations() } catch { /* ignore */ }
    termRef.current?.focus()
  }

  return (
    <div className="h-full w-full bg-zinc-950 relative">
      {searchOpen && (
        <div className="absolute top-1.5 right-3 z-10 flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 shadow-xl">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (e.target.value) searchRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); searchRef.current?.findPrevious(query) }
              else if (e.key === 'Enter') { e.preventDefault(); searchRef.current?.findNext(query) }
              else if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
            }}
            placeholder="Find… (Enter next · ⇧Enter prev)"
            className="w-48 px-1.5 py-0.5 bg-zinc-950 border border-zinc-700 rounded text-[11px] text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
          />
          <button onClick={closeSearch} className="text-zinc-500 hover:text-zinc-200 text-xs px-1">✕</button>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  )
}
