// IDEFileTree.tsx — the explorer tree. Expansion state is lifted (so reveal /
// collapse-all work), rename & create happen INLINE (no window.prompt), and
// nodes can be drag-and-dropped into folders to move them. Rows also export
// their path via dataTransfer('text/orqon-path') so other panels (chat) can
// accept file drops.

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { getFileIcon } from './fileIcons'

interface FileNode {
  name: string
  relPath: string
  isDir: boolean
  children?: FileNode[]
}

export interface CreateRequest {
  parentDir: string
  isDir: boolean
  nonce: number
}

interface IDEFileTreeProps {
  files: FileNode[]
  selectedFile: string | null
  onSelectFile: (relPath: string) => void
  gitChanges: { file: string; type: string }[]
  /** Commit an inline rename (newName is the basename only). */
  onRenameCommit: (relPath: string, newName: string) => void
  onDelete: (relPath: string) => void
  /** Commit an inline create under parentDir ('' = workspace root). */
  onCreateCommit: (parentDir: string, name: string, isDir: boolean) => void
  /** Move a file/folder into a directory ('' = root). */
  onMove: (fromRel: string, toDir: string) => void
  /** Bump nonce to open an inline-create input under parentDir. */
  createRequest: CreateRequest | null
  /** Bump to expand ancestors of selectedFile and scroll it into view. */
  revealNonce: number
  /** Bump to collapse every directory. */
  collapseNonce: number
}

interface MenuState {
  x: number
  y: number
  node: FileNode
}

type Editing =
  | { kind: 'rename'; path: string }
  | { kind: 'create'; parentDir: string; isDir: boolean }
  | null

function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? '' : relPath.slice(0, i)
}

function ancestorsOf(relPath: string): string[] {
  const out: string[] = []
  const parts = relPath.split('/')
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

export function IDEFileTree({
  files, selectedFile, onSelectFile, gitChanges,
  onRenameCommit, onDelete, onCreateCommit, onMove,
  createRequest, revealNonce, collapseNonce,
}: IDEFileTreeProps) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Editing>(null)
  const [dragOverDir, setDragOverDir] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const lastCreateNonce = useRef(0)
  const lastRevealNonce = useRef(0)
  const lastCollapseNonce = useRef(0)

  // First load: expand root-level dirs (matches the old default).
  useEffect(() => {
    if (initializedRef.current || files.length === 0) return
    initializedRef.current = true
    setExpandedDirs(new Set(files.filter((f) => f.isDir).map((f) => f.relPath)))
  }, [files])

  const toggleDir = (relPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  // Auto-expand ancestors when the active file changes (VS Code-style reveal).
  useEffect(() => {
    if (!selectedFile) return
    setExpandedDirs((prev) => {
      const anc = ancestorsOf(selectedFile)
      if (anc.every((a) => prev.has(a))) return prev
      const next = new Set(prev)
      for (const a of anc) next.add(a)
      return next
    })
  }, [selectedFile])

  // Explicit reveal: expand + scroll the selected file into view.
  useEffect(() => {
    if (revealNonce === lastRevealNonce.current) return
    lastRevealNonce.current = revealNonce
    if (!selectedFile) return
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      for (const a of ancestorsOf(selectedFile)) next.add(a)
      return next
    })
    // Wait a frame for the expanded rows to render.
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector(`[data-relpath="${CSS.escape(selectedFile)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [revealNonce, selectedFile])

  // Collapse all.
  useEffect(() => {
    if (collapseNonce === lastCollapseNonce.current) return
    lastCollapseNonce.current = collapseNonce
    setExpandedDirs(new Set())
  }, [collapseNonce])

  // External create request (header buttons / palette): open the input row.
  useEffect(() => {
    if (!createRequest || createRequest.nonce === lastCreateNonce.current) return
    lastCreateNonce.current = createRequest.nonce
    if (createRequest.parentDir) {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        next.add(createRequest.parentDir)
        for (const a of ancestorsOf(createRequest.parentDir)) next.add(a)
        return next
      })
    }
    setEditing({ kind: 'create', parentDir: createRequest.parentDir, isDir: createRequest.isDir })
  }, [createRequest])

  const handleDropOn = (toDir: string, e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverDir(null)
    const from = e.dataTransfer.getData('text/orqon-path')
    if (!from) return
    if (from === toDir) return
    if (toDir === from || toDir.startsWith(from + '/')) return // into own subtree
    if (parentOf(from) === toDir) return // already there
    onMove(from, toDir)
  }

  return (
    <div
      ref={containerRef}
      className="text-xs select-none font-mono text-zinc-300 min-h-full pb-6"
      onClick={() => setMenu(null)}
      // Dropping on empty space moves to the workspace root.
      onDragOver={(e) => { e.preventDefault(); setDragOverDir('') }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverDir(null) }}
      onDrop={(e) => handleDropOn('', e)}
    >
      {editing?.kind === 'create' && editing.parentDir === '' && (
        <InlineNameInput
          depth={0}
          isDir={editing.isDir}
          onCommit={(name) => { setEditing(null); onCreateCommit('', name, editing.isDir) }}
          onCancel={() => setEditing(null)}
        />
      )}

      {files.map((node) => (
        <TreeNode
          key={node.relPath}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          gitChanges={gitChanges}
          expandedDirs={expandedDirs}
          toggleDir={toggleDir}
          editing={editing}
          setEditing={setEditing}
          onRenameCommit={onRenameCommit}
          onCreateCommit={onCreateCommit}
          dragOverDir={dragOverDir}
          setDragOverDir={setDragOverDir}
          onDropOn={handleDropOn}
          onContextMenu={(e, n) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, node: n })
          }}
        />
      ))}

      {/* Context menu — rendered through a portal to <body>. Inside the tree it
          would sit under framer-motion transformed ancestors, which turn
          position:fixed into ancestor-relative (wrong spot) and clip it. The
          full-screen backdrop also closes it on any outside click. */}
      {menu && createPortal(
        <div
          className="fixed inset-0 z-[95]"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
        >
          <div
            className="absolute min-w-40 bg-zinc-900 border border-zinc-700 rounded shadow-2xl py-1 text-xs font-mono text-zinc-300"
            style={{
              top: Math.min(menu.y, window.innerHeight - (menu.node.isDir ? 170 : 90)),
              left: Math.min(menu.x, window.innerWidth - 180),
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.node.isDir && (
              <>
                <MenuItem label="New File" onClick={() => { setEditing({ kind: 'create', parentDir: menu.node.relPath, isDir: false }); setExpandedDirs((p) => new Set(p).add(menu.node.relPath)); setMenu(null) }} />
                <MenuItem label="New Folder" onClick={() => { setEditing({ kind: 'create', parentDir: menu.node.relPath, isDir: true }); setExpandedDirs((p) => new Set(p).add(menu.node.relPath)); setMenu(null) }} />
                <div className="my-1 border-t border-zinc-800" />
              </>
            )}
            <MenuItem label="Rename" onClick={() => { setEditing({ kind: 'rename', path: menu.node.relPath }); setMenu(null) }} />
            <MenuItem label="Delete" danger onClick={() => { onDelete(menu.node.relPath); setMenu(null) }} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 hover:bg-zinc-800 ${danger ? 'text-rose-300' : 'text-zinc-200'}`}
    >
      {label}
    </button>
  )
}

// Inline text input used for rename + create. Enter commits, Esc/blur cancels.
function InlineNameInput({ depth, isDir, initial, onCommit, onCancel }: {
  depth: number
  isDir: boolean
  initial?: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Select the basename (before the extension) for quick renames.
    const dot = (initial ?? '').lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : (initial ?? '').length)
  }, [initial])

  const commit = () => {
    const name = value.trim()
    if (!name || name.includes('/') || name === initial) { onCancel(); return }
    onCommit(name)
  }

  return (
    <div className="flex items-center gap-1.5 py-0.5 px-2" style={{ paddingLeft: `${depth * 12 + 24}px` }}>
      <span className="shrink-0 text-[13px]">{isDir ? <Folder size={13} className="text-blue-400" /> : getFileIcon(value || 'file').icon}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          e.stopPropagation()
        }}
        onBlur={onCancel}
        onClick={(e) => e.stopPropagation()}
        placeholder={isDir ? 'folder name' : 'file name'}
        className="flex-1 min-w-0 px-1 py-0.5 bg-zinc-950 border border-blue-500/60 rounded text-xs text-zinc-100 focus:outline-none"
      />
    </div>
  )
}

interface TreeNodeProps {
  node: FileNode
  depth: number
  selectedFile: string | null
  onSelectFile: (relPath: string) => void
  gitChanges: { file: string; type: string }[]
  expandedDirs: Set<string>
  toggleDir: (relPath: string) => void
  editing: Editing
  setEditing: (e: Editing) => void
  onRenameCommit: (relPath: string, newName: string) => void
  onCreateCommit: (parentDir: string, name: string, isDir: boolean) => void
  dragOverDir: string | null
  setDragOverDir: (d: string | null) => void
  onDropOn: (toDir: string, e: React.DragEvent) => void
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
}

function TreeNode(props: TreeNodeProps) {
  const {
    node, depth, selectedFile, onSelectFile, gitChanges,
    expandedDirs, toggleDir, editing, setEditing, onRenameCommit, onCreateCommit,
    dragOverDir, setDragOverDir, onDropOn, onContextMenu,
  } = props
  const isOpen = expandedDirs.has(node.relPath)
  const isSelected = selectedFile === node.relPath
  const isRenaming = editing?.kind === 'rename' && editing.path === node.relPath
  const isDropTarget = node.isDir && dragOverDir === node.relPath

  const hasGitChanges = (n: FileNode): boolean =>
    gitChanges.some((c) => c.file === n.relPath || c.file.startsWith(n.relPath + '/'))

  const gitStatus = !node.isDir ? gitChanges.find((c) => c.file === node.relPath)?.type ?? null : null
  const isModified = gitStatus === 'M'
  const isAdded = gitStatus === 'A' || gitStatus === '??'

  const labelColor = isModified
    ? 'text-amber-400 hover:text-amber-300'
    : isAdded
    ? 'text-emerald-400 hover:text-emerald-300'
    : isSelected
    ? 'text-white'
    : 'text-zinc-400 hover:text-zinc-200'

  const paddingLeft = `${depth * 12 + 6}px`

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (node.isDir) toggleDir(node.relPath)
    else onSelectFile(node.relPath)
  }

  if (isRenaming) {
    return (
      <InlineNameInput
        depth={depth}
        isDir={node.isDir}
        initial={node.name}
        onCommit={(name) => { setEditing(null); onRenameCommit(node.relPath, name) }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div>
      <div
        data-relpath={node.relPath}
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.setData('text/orqon-path', node.relPath)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={node.isDir ? (e) => { e.preventDefault(); e.stopPropagation(); setDragOverDir(node.relPath) } : undefined}
        onDragLeave={node.isDir ? () => setDragOverDir(null) : undefined}
        onDrop={node.isDir ? (e) => onDropOn(node.relPath, e) : undefined}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer transition-colors group rounded ${
          isDropTarget
            ? 'bg-blue-500/15 ring-1 ring-inset ring-blue-500/50'
            : isSelected ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-900/60'
        }`}
        style={{ paddingLeft }}
      >
        {node.isDir ? (
          <>
            <span className="text-zinc-500">
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <span className={hasGitChanges(node) ? 'text-amber-500/80' : 'text-zinc-400 group-hover:text-zinc-200'}>
              {isOpen ? (
                <FolderOpen size={14} className="text-blue-400" />
              ) : (
                <Folder size={14} className="text-blue-400" />
              )}
            </span>
            <span className={`truncate font-medium ${hasGitChanges(node) ? 'text-amber-400/90 font-semibold' : 'text-zinc-300'}`}>
              {node.name}
            </span>
          </>
        ) : (
          <>
            <span className="w-3.5" /> {/* alignment spacer for files */}
            <span className="shrink-0 text-[14px] flex items-center" style={{ color: getFileIcon(node.name).color }}>
              {getFileIcon(node.name).icon}
            </span>
            <span className={`truncate ${labelColor} flex-1`}>
              {node.name}
            </span>
            {gitStatus && (
              <span
                className={`text-[9px] font-bold px-1 rounded-sm scale-90 ${
                  isModified
                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                }`}
              >
                {isModified ? 'M' : isAdded ? 'A' : gitStatus}
              </span>
            )}
          </>
        )}
      </div>

      {node.isDir && isOpen && (
        <div className="overflow-hidden">
          {editing?.kind === 'create' && editing.parentDir === node.relPath && (
            <InlineNameInput
              depth={depth + 1}
              isDir={editing.isDir}
              onCommit={(name) => { setEditing(null); onCreateCommit(node.relPath, name, editing.isDir) }}
              onCancel={() => setEditing(null)}
            />
          )}
          {(node.children ?? []).map((child) => (
            <TreeNode
              key={child.relPath}
              {...props}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}
