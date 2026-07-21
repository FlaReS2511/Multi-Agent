import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Search,
  CaseSensitive,
  Regex,
  Replace,
  ChevronRight,
  ChevronDown,
} from 'lucide-react'

// Rows rendered per file group before a "show more" expander takes over —
// 2000 raw result rows in the DOM made the whole sidebar crawl.
const GROUP_ROW_CAP = 50

interface Match {
  file: string
  line: number
  column: number
  text: string
}

interface Props {
  onOpenResult: (file: string, line: number, column: number) => void
}

interface FileGroup {
  file: string
  matches: Match[]
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function dirname(p: string): string {
  const parts = p.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

function groupByFile(matches: Match[]): FileGroup[] {
  const map = new Map<string, Match[]>()
  for (const m of matches) {
    const arr = map.get(m.file)
    if (arr) arr.push(m)
    else map.set(m.file, [m])
  }
  return Array.from(map.entries()).map(([file, matches]) => ({ file, matches }))
}

// Split a line of text around the first case-(in)sensitive occurrence of the
// query so we can highlight it. Falls back to no-highlight for regex queries.
function highlightParts(
  text: string,
  query: string,
  caseSensitive: boolean,
): { before: string; hit: string; after: string } | null {
  if (!query) return null
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const idx = hay.indexOf(needle)
  if (idx < 0) return null
  return {
    before: text.slice(0, idx),
    hit: text.slice(idx, idx + query.length),
    after: text.slice(idx + query.length),
  }
}

const HISTORY_KEY = 'orqon.searchHistory'

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}

export const SearchPanel = React.memo(function SearchPanel({ onOpenResult }: Props) {
  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [includeGlob, setIncludeGlob] = useState('')
  const [excludeGlob, setExcludeGlob] = useState('')
  const [history, setHistory] = useState<string[]>(readHistory)
  const [matches, setMatches] = useState<Match[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Remember recent queries (deduped, last 10) for the datalist dropdown.
  const recordHistory = useCallback((q: string) => {
    if (q.length < 3) return
    setHistory((prev) => {
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, 10)
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const runSearch = useCallback(
    async (q: string) => {
      if (!q) {
        setMatches([])
        setError(null)
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const res = await window.api.workspaceSearch(q, {
          caseSensitive,
          regex,
          maxResults: 2000,
          include: includeGlob || undefined,
          exclude: excludeGlob || undefined,
        })
        if (!res.ok) {
          setError(res.error || 'Search failed')
          setMatches([])
        } else {
          setError(null)
          setMatches(res.matches)
          if (res.matches.length > 0) recordHistory(q)
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Search failed')
        setMatches([])
      } finally {
        setSearching(false)
      }
    },
    [caseSensitive, regex, includeGlob, excludeGlob, recordHistory],
  )

  // Debounced search on query / option changes.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      runSearch(query)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, runSearch])

  const groups = useMemo(() => groupByFile(matches), [matches])
  // Groups the user explicitly expanded past the row cap.
  const [uncapped, setUncapped] = useState<Set<string>>(new Set())

  const replaceAll = async () => {
    if (!query || !groups.length) return
    setSearching(true)
    try {
      for (const g of groups) {
        await window.api.workspaceReplaceInFile(g.file, query, replaceText, {
          regex,
          caseSensitive,
        })
      }
    } finally {
      await runSearch(query)
    }
  }

  const toggleCollapse = (file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-xs text-zinc-300">
      <div className="p-2 border-b border-zinc-800 space-y-1.5">
        <div className="flex items-start gap-1">
          <button
            onClick={() => setShowReplace((v) => !v)}
            className="mt-1 text-zinc-500 hover:text-zinc-200"
            title={showReplace ? 'Hide replace' : 'Show replace'}
          >
            {showReplace ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
          {/* min-w-0 lets the inputs shrink below their intrinsic width so the
              column never overflows the 256px sidebar. */}
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center gap-1 px-2 bg-zinc-900 border border-zinc-700 rounded focus-within:border-blue-500">
              <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                list="orqon-search-history"
                className="flex-1 py-1 bg-transparent text-zinc-100 placeholder-zinc-600 focus:outline-none"
              />
              <datalist id="orqon-search-history">
                {history.map((h) => <option key={h} value={h} />)}
              </datalist>
              <button
                onClick={() => setCaseSensitive((v) => !v)}
                title="Match Case"
                className={`p-0.5 rounded ${
                  caseSensitive
                    ? 'bg-blue-600/30 text-blue-300'
                    : 'text-zinc-500 hover:text-zinc-200'
                }`}
              >
                <CaseSensitive className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setRegex((v) => !v)}
                title="Use Regular Expression"
                className={`p-0.5 rounded ${
                  regex
                    ? 'bg-blue-600/30 text-blue-300'
                    : 'text-zinc-500 hover:text-zinc-200'
                }`}
              >
                <Regex className="w-3.5 h-3.5" />
              </button>
            </div>

            {showReplace && (
              <div className="flex items-center gap-1 px-2 bg-zinc-900 border border-zinc-700 rounded focus-within:border-blue-500">
                <Replace className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <input
                  type="text"
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  placeholder="Replace"
                  className="flex-1 py-1 bg-transparent text-zinc-100 placeholder-zinc-600 focus:outline-none"
                />
                <button
                  onClick={replaceAll}
                  disabled={!query || !groups.length || searching}
                  title="Replace All"
                  className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 disabled:text-zinc-700 disabled:hover:bg-transparent"
                >
                  <Replace className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Include / exclude glob filters (comma-separated, rg -g syntax).
                Stacked vertically — the sidebar is only 256px wide. */}
            <input
              type="text"
              value={includeGlob}
              onChange={(e) => setIncludeGlob(e.target.value)}
              placeholder="include: src/**/*.ts"
              className="w-full min-w-0 px-2 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
            />
            <input
              type="text"
              value={excludeGlob}
              onChange={(e) => setExcludeGlob(e.target.value)}
              placeholder="exclude: *.test.ts"
              className="w-full min-w-0 px-2 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {query && !error && (
          <div className="text-[10px] text-zinc-500 pl-5">
            {matches.length} result{matches.length === 1 ? '' : 's'} in{' '}
            {groups.length} file{groups.length === 1 ? '' : 's'}
            {searching && ' · searching…'}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-2 text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {!error && query && !searching && matches.length === 0 && (
          <div className="p-3 text-zinc-600">No results</div>
        )}

        {!error &&
          groups.map((g) => {
            const isCollapsed = collapsed.has(g.file)
            return (
              <div key={g.file}>
                <button
                  onClick={() => toggleCollapse(g.file)}
                  className="w-full flex items-center gap-1 px-2 py-1 hover:bg-zinc-800/60 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  )}
                  <span className="font-semibold text-zinc-200 truncate">
                    {basename(g.file)}
                  </span>
                  <span className="text-zinc-600 truncate">{dirname(g.file)}</span>
                  <span className="ml-auto shrink-0 min-w-4 text-center text-[10px] text-zinc-400 bg-zinc-800 rounded-full px-1.5">
                    {g.matches.length}
                  </span>
                </button>

                {!isCollapsed &&
                  (uncapped.has(g.file) ? g.matches : g.matches.slice(0, GROUP_ROW_CAP)).map((m, i) => {
                    const parts = regex
                      ? null
                      : highlightParts(m.text, query, caseSensitive)
                    return (
                      <button
                        key={`${m.line}:${m.column}:${i}`}
                        onClick={() => onOpenResult(m.file, m.line, m.column)}
                        className="w-full flex items-baseline gap-2 pl-7 pr-2 py-0.5 hover:bg-zinc-800/60 text-left"
                      >
                        <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                          {m.line}:{m.column}
                        </span>
                        <span className="truncate font-mono text-zinc-400">
                          {parts ? (
                            <>
                              {parts.before}
                              <mark className="bg-amber-500/30 text-amber-200 rounded-sm">
                                {parts.hit}
                              </mark>
                              {parts.after}
                            </>
                          ) : (
                            m.text
                          )}
                        </span>
                      </button>
                    )
                  })}
                {!isCollapsed && !uncapped.has(g.file) && g.matches.length > GROUP_ROW_CAP && (
                  <button
                    onClick={() => setUncapped((prev) => new Set(prev).add(g.file))}
                    className="w-full pl-7 pr-2 py-1 text-left text-[10px] text-blue-300/80 hover:text-blue-200"
                  >
                    Show {g.matches.length - GROUP_ROW_CAP} more…
                  </button>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
})
