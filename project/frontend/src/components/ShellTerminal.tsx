// ShellTerminal.tsx — a real interactive shell (pwsh/bash) running in the
// workspace root, for the user to run npm/git/python etc. Separate from the
// agent PTYs.

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  id: string
  active: boolean
}

export function ShellTerminal({ id, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

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
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit

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
    }
  }, [id])

  useEffect(() => {
    if (active && termRef.current && fitRef.current) {
      requestAnimationFrame(() => {
        try { fitRef.current!.fit(); termRef.current!.focus() } catch { /* ignore */ }
      })
    }
  }, [active])

  return (
    <div className="h-full w-full bg-zinc-950">
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  )
}
