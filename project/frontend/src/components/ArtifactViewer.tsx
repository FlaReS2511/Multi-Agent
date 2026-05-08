import { useEffect, useState, useMemo } from 'react'
import { ArtifactNode } from '../lib/api'

interface Props {
  initialTaskId?: string | null
}

const TEXT_EXT = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'log',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'rb', 'sh',
  'css', 'html', 'xml', 'toml', 'ini', 'env', 'sql', 'csv',
])

function extOf(name: string): string {
  const m = name.match(/\.([^.]+)$/)
  return m ? m[1].toLowerCase() : ''
}

export function ArtifactViewer({ initialTaskId }: Props) {
  const [tasks, setTasks] = useState<string[]>([])
  const [selectedTask, setSelectedTask] = useState<string | null>(initialTaskId ?? null)
  const [tree, setTree] = useState<ArtifactNode[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [contentOk, setContentOk] = useState<boolean>(true)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    window.api.listArtifactTasks().then(setTasks)
  }, [])

  useEffect(() => {
    if (initialTaskId) {
      setSelectedTask(initialTaskId)
      setSelectedFile(null)
    }
  }, [initialTaskId])

  useEffect(() => {
    if (!selectedTask) {
      setTree([])
      return
    }
    window.api.listArtifactTree(selectedTask).then((nodes) => {
      setTree(nodes)
      const firstFile = nodes.find((n) => !n.isDir)
      if (firstFile) setSelectedFile(firstFile.name)
      else setSelectedFile(null)
    })
  }, [selectedTask])

  useEffect(() => {
    if (!selectedTask || !selectedFile) {
      setContent('')
      return
    }
    setLoading(true)
    window.api
      .readArtifactFile(selectedTask, selectedFile)
      .then((r) => {
        setContent(r.content)
        setContentOk(r.ok)
      })
      .finally(() => setLoading(false))
  }, [selectedTask, selectedFile])

  const filteredTasks = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return tasks
    return tasks.filter((t) => t.toLowerCase().includes(q))
  }, [tasks, filter])

  return (
    <div className="h-full flex bg-zinc-950 text-zinc-200">
      <div className="w-56 border-r border-zinc-800 flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-800">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            Tasks ({tasks.length})
          </div>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="w-full px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredTasks.length === 0 ? (
            <div className="p-3 text-xs text-zinc-600 italic">no tasks</div>
          ) : (
            <ul>
              {filteredTasks.map((t) => (
                <li key={t}>
                  <button
                    onClick={() => setSelectedTask(t)}
                    className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
                      selectedTask === t
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                    }`}
                  >
                    {t}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="w-64 border-r border-zinc-800 flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-800">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Files</div>
          <div className="text-xs font-mono text-zinc-300 mt-0.5">{selectedTask ?? '—'}</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {!selectedTask ? (
            <div className="p-3 text-xs text-zinc-600 italic">Select a task</div>
          ) : tree.length === 0 ? (
            <div className="p-3 text-xs text-zinc-600 italic">empty</div>
          ) : (
            <ul>
              {tree.map((n) => (
                <li key={n.name}>
                  <button
                    onClick={() => !n.isDir && setSelectedFile(n.name)}
                    disabled={n.isDir}
                    className={`w-full text-left px-3 py-1 text-xs font-mono flex items-center gap-1.5 transition-colors ${
                      n.isDir
                        ? 'text-zinc-500 cursor-default'
                        : selectedFile === n.name
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                    }`}
                  >
                    <span className="text-zinc-600">{n.isDir ? '📁' : '📄'}</span>
                    <span className="truncate">{n.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
          <div className="text-xs font-mono text-zinc-300 truncate">
            {selectedTask && selectedFile
              ? `${selectedTask}/${selectedFile}`
              : 'Preview'}
          </div>
          <div className="text-[10px] text-zinc-600">
            {loading ? 'loading…' : `${content.length} bytes`}
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {!selectedFile ? (
            <div className="p-8 text-center text-zinc-600 text-sm">Select a file to preview</div>
          ) : !contentOk ? (
            <div className="p-8 text-center text-rose-400 text-sm">Failed to read file</div>
          ) : (
            <FilePreview filename={selectedFile} content={content} />
          )}
        </div>
      </div>
    </div>
  )
}

function FilePreview({ filename, content }: { filename: string; content: string }) {
  const ext = extOf(filename)
  const isText = TEXT_EXT.has(ext) || ext === ''

  if (!isText) {
    return (
      <div className="p-6 text-zinc-500 text-sm">
        Binary file ({ext || 'no ext'}) — preview not supported.
      </div>
    )
  }

  if (ext === 'md') {
    return <MarkdownPreview content={content} />
  }

  return <CodePreview content={content} lang={ext} />
}

function CodePreview({ content, lang }: { content: string; lang: string }) {
  return (
    <div>
      {lang && (
        <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">{lang}</div>
      )}
      <pre className="p-4 text-[12px] font-mono text-zinc-200 whitespace-pre-wrap leading-relaxed">
        <code>{content}</code>
      </pre>
    </div>
  )
}

function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return (
    <div
      className="p-4 text-sm text-zinc-200 prose-md leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true
  try {
    const parsed = new URL(trimmed)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function renderInline(s: string): string {
  let out = escapeHtml(s)
  out = out.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-zinc-800 text-amber-300 text-[12px]">$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-white">$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, rawUrl) => {
    const url = rawUrl.trim()
    if (!isSafeUrl(url)) return escapeHtml(label)
    return `<a href="${escapeHtml(url)}" class="text-blue-400 underline">${label}</a>`
  })
  return out
}

function renderMarkdown(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let codeBuf: string[] = []
  let inList = false

  const flushList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const line of lines) {
    if (inCode) {
      if (/^```/.test(line)) {
        out.push(
          `<pre class="my-2 p-3 rounded bg-zinc-900 border border-zinc-800 text-[12px] font-mono text-zinc-200 overflow-x-auto"><code>${escapeHtml(
            codeBuf.join('\n')
          )}</code></pre>`
        )
        if (codeLang) {
          out[out.length - 1] = `<div class="mt-2 mb-1 text-[10px] uppercase tracking-wider text-zinc-600">${codeLang}</div>` + out[out.length - 1]
        }
        codeBuf = []
        codeLang = ''
        inCode = false
      } else {
        codeBuf.push(line)
      }
      continue
    }

    const fence = line.match(/^```(\w*)/)
    if (fence) {
      flushList()
      inCode = true
      codeLang = fence[1] ?? ''
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.+)/)
    if (h) {
      flushList()
      const level = h[1].length
      const sizeCls =
        level === 1 ? 'text-xl font-bold mt-3 mb-2 text-white' :
        level === 2 ? 'text-lg font-semibold mt-3 mb-1.5 text-white' :
        level === 3 ? 'text-base font-semibold mt-2 mb-1 text-zinc-100' :
                      'text-sm font-semibold mt-2 mb-1 text-zinc-200'
      out.push(`<h${level} class="${sizeCls}">${renderInline(h[2])}</h${level}>`)
      continue
    }

    const li = line.match(/^[-*]\s+(.+)/)
    if (li) {
      if (!inList) {
        out.push('<ul class="my-1 ml-5 list-disc text-zinc-200 space-y-0.5">')
        inList = true
      }
      out.push(`<li>${renderInline(li[1])}</li>`)
      continue
    }

    if (line.trim() === '') {
      flushList()
      out.push('')
      continue
    }

    flushList()
    out.push(`<p class="my-1.5">${renderInline(line)}</p>`)
  }

  if (inCode) {
    out.push(
      `<pre class="my-2 p-3 rounded bg-zinc-900 border border-zinc-800 text-[12px] font-mono text-zinc-200 overflow-x-auto"><code>${escapeHtml(
        codeBuf.join('\n')
      )}</code></pre>`
    )
  }
  flushList()

  return out.join('\n')
}
