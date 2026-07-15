import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  agent: string
  active: boolean
}

export function AgentTerminal({ agent, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [alive, setAlive] = useState<boolean | null>(null)
  const [starting, setStarting] = useState(false)

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

  // Mount xterm + attach (no spawn) when agent is alive.
  useEffect(() => {
    if (!alive || !containerRef.current) return

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

    termRef.current = term
    fitRef.current = fit

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
  }, [agent, alive])

  // When this terminal becomes active, refit & focus
  useEffect(() => {
    if (active && termRef.current && fitRef.current) {
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

  if (alive === null) {
    return (
      <div className="h-full w-full bg-zinc-950 flex items-center justify-center">
        <span className="text-xs text-zinc-600">Checking session…</span>
      </div>
    )
  }

  if (!alive) {
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

  return (
    <div className="h-full w-full bg-zinc-950">
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  )
}
