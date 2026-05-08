import { useEffect, useRef } from 'react'
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

  // Mount xterm + start pty + subscribe
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

    // Initial fit + start pty
    requestAnimationFrame(() => {
      fit.fit()
      const cols = term.cols
      const rows = term.rows

      window.api.ptyStart(agent).then(({ history }) => {
        if (history) term.write(history)
        window.api.ptyResize(agent, cols, rows)
      })
    })

    const offData = window.api.onPtyData(agent, (data) => {
      term.write(data)
    })
    const offExit = window.api.onPtyExit(agent, ({ exitCode }) => {
      term.write(`\r\n\x1b[31m[claude exited with code ${exitCode}]\x1b[0m\r\n`)
    })

    const dataDisposable = term.onData((data) => {
      window.api.ptyWrite(agent, data)
    })
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      window.api.ptyResize(agent, cols, rows)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(containerRef.current)

    return () => {
      offData()
      offExit()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      ro.disconnect()
      term.dispose()
    }
  }, [agent])

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

  return (
    <div className="h-full w-full bg-zinc-950">
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  )
}
