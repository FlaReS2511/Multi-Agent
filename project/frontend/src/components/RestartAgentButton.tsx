import { useState } from 'react'

interface Props {
  agent: string
  onRestarted?: () => void
  small?: boolean
}

export function RestartAgentButton({ agent, onRestarted, small }: Props) {
  const [busy, setBusy] = useState(false)

  const restart = async () => {
    if (busy) return
    if (!confirm(`Restart claude session for ${agent}?\n\nThis kills the current PTY and respawns with the configured model.`)) return
    setBusy(true)
    try {
      await window.api.ptyRestart(agent)
      onRestarted?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={restart}
      disabled={busy}
      className={`${
        small ? 'px-2 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'
      } font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50 rounded transition-colors`}
      title={`Restart ${agent} (kill PTY + respawn with current model)`}
    >
      {busy ? '↻…' : '↻ Restart'}
    </button>
  )
}
