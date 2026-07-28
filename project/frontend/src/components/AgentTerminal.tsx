import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { enableWebgl } from '../lib/termWebgl'
import '@xterm/xterm/css/xterm.css'

interface Props {
  agent: string
  active: boolean
}

// While hidden, buffered PTY output is capped — beyond this the oldest chunks
// are dropped (the scrollback wouldn't keep them anyway).
const HIDDEN_BUFFER_MAX = 400_000

export function AgentTerminal({ agent, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [alive, setAlive] = useState<boolean | null>(null)
  const [starting, setStarting] = useState(false)
  // Once the terminal has been mounted for a live session, keep it mounted even
  // after the agent dies so its final output (including the crash message)
  // stays readable instead of being torn down within one poll cycle.
  const [hasMounted, setHasMounted] = useState(false)
  const shown = alive === true || hasMounted
  // Hidden terminals don't parse/render output — chunks buffer here and flush
  // in one write when the terminal is shown again.
  const activeRef = useRef(active)
  const pendingRef = useRef<{ chunks: string[]; bytes: number }>({ chunks: [], bytes: 0 })

  // Poll alive state so external spawns (inbox event, pre-warm) flip the UI
  // from placeholder to terminal without a manual refresh.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const detail = await window.api.ptyStatusDetail()
      if (cancelled) return
      const isAlive = detail.some((d) => d.agent === agent)
      setAlive((prev) => (prev === isAlive ? prev : isAlive))
    }
    tick()
    const i = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(i)
    }
  }, [agent])

  // Mount xterm + attach (no spawn) once shown. Keyed on `shown` (not `alive`)
  // so a dying agent doesn't tear the terminal down — the still-live onPtyData
  // subscription keeps appending, and a Restart reuses this same instance.
  useEffect(() => {
    if (!shown || !containerRef.current || termRef.current) return
    setHasMounted(true)

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SF Mono, JetBrains Mono, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#a1a1aa',
        black: '#27272a',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#e879f9',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fca5a5',
        brightGreen: '#6ee7b7',
        brightYellow: '#fcd34d',
        brightBlue: '#93c5fd',
        brightMagenta: '#f0abfc',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    if (activeRef.current) enableWebgl(term)

    termRef.current = term
    fitRef.current = fit
    pendingRef.current = { chunks: [], bytes: 0 }

    requestAnimationFrame(() => {
      fit.fit()
      const cols = term.cols
      const rows = term.rows
      window.api.ptyAttach(agent).then(({ history }) => {
        if (history) term.write(history)
        window.api.ptyResize(agent, cols, rows)
      })
    })

    const offData = window.api.onPtyData(agent, (data) => {
      // Hidden → buffer instead of parsing/rendering every byte off-screen.
      if (!activeRef.current) {
        const p = pendingRef.current
        p.chunks.push(data)
        p.bytes += data.length
        while (p.bytes > HIDDEN_BUFFER_MAX && p.chunks.length > 1) {
          p.bytes -= p.chunks[0].length
          p.chunks.shift()
        }
        return
      }
      term.write(data)
    })
    const offExit = window.api.onPtyExit(agent, ({ exitCode }) => {
      term.write(`\r\n\x1b[31m[agent exited with code ${exitCode}]\x1b[0m\r\n`)
    })

    const dataDisposable = term.onData((data) => {
      window.api.ptyWrite(agent, data)
    })
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      window.api.ptyResize(agent, cols, rows)
    })

    // Debounced refit: panel width animations fire ResizeObserver dozens of
    // times; resizing the PTY on each tick makes the CLI redraw its prompt at
    // every intermediate width. Fit once, after the size has settled.
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        try { fit.fit() } catch { /* ignore */ }
      }, 150)
    })
    ro.observe(containerRef.current)

    return () => {
      offData()
      offExit()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      if (fitTimer) clearTimeout(fitTimer)
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [agent, shown])

  // When this terminal becomes active: flush buffered output, upgrade to the
  // GPU renderer, refit & focus.
  useEffect(() => {
    activeRef.current = active
    if (active && termRef.current && fitRef.current) {
      const p = pendingRef.current
      if (p.chunks.length) {
        termRef.current.write(p.chunks.join(''))
        pendingRef.current = { chunks: [], bytes: 0 }
      }
      enableWebgl(termRef.current)
      requestAnimationFrame(() => {
        try {
          fitRef.current!.fit()
          termRef.current!.focus()
        } catch {
          /* ignore */
        }
      })
    }
  }, [active])

  const onStart = async () => {
    if (starting) return
    setStarting(true)
    try {
      await window.api.ptyStart(agent)
      // Polling tick will detect alive on next cycle (≤2s); flip handled there.
    } finally {
      setStarting(false)
    }
  }

  // Still checking, and never mounted → spinner.
  if (alive === null && !hasMounted) {
    return (
      <div className="h-full w-full bg-zinc-950 flex items-center justify-center">
        <span className="text-xs text-zinc-600">Checking session…</span>
      </div>
    )
  }

  // Never ran in this view → the Start placeholder.
  if (!shown) {
    return (
      <div className="h-full w-full bg-zinc-950 flex flex-col items-center justify-center gap-3">
        <div className="text-xs text-zinc-500">
          <span className="font-mono text-zinc-400">{agent}</span> is not running.
        </div>
        <div className="text-[10px] text-zinc-600 max-w-md text-center px-4">
          Tab clicks no longer auto-spawn agents. Click Start to launch this PTY,
          or send the agent a message — it will wake up automatically.
        </div>
        <button
          onClick={onStart}
          disabled={starting}
          className="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors"
        >
          {starting ? 'Starting…' : 'Start agent'}
        </button>
      </div>
    )
  }

  // Mounted: keep the terminal (and its final output) on screen. When the agent
  // has exited, overlay a slim banner with Restart instead of unmounting.
  return (
    <div className="h-full w-full bg-zinc-950 relative">
      {alive === false && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-rose-950/70 border-b border-rose-500/30 backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-rose-400 flex-shrink-0" />
          <span className="text-[11px] text-rose-200 flex-1">
            <span className="font-mono">{agent}</span> exited — output kept below
          </span>
          <button
            onClick={onStart}
            disabled={starting}
            className="text-[11px] font-medium px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-60 text-white"
          >
            {starting ? 'Restarting…' : 'Restart'}
          </button>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  )
}
