import React, { useState } from 'react'
import { Folder, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { getFileIcon } from './fileIcons'

interface FileNode {
  name: string
  relPath: string
  isDir: boolean
  children?: FileNode[]
}

interface FileOps {
  onRename?: (relPath: string) => void
  onDelete?: (relPath: string) => void
  onNewFile?: (parentDir: string) => void
  onNewFolder?: (parentDir: string) => void
}

interface IDEFileTreeProps extends FileOps {
  files: FileNode[]
  selectedFile: string | null
  onSelectFile: (relPath: string) => void
  gitChanges: { file: string; type: string }[]
}

interface MenuState {
  x: number
  y: number
  node: FileNode
}

export function IDEFileTree({ files, selectedFile, onSelectFile, gitChanges, onRename, onDelete, onNewFile, onNewFolder }: IDEFileTreeProps) {
  const [menu, setMenu] = useState<MenuState | null>(null)

  const ops: FileOps = { onRename, onDelete, onNewFile, onNewFolder }

  return (
    <div className="text-xs select-none font-mono text-zinc-300" onClick={() => setMenu(null)}>
      {files.map((node) => (
        <TreeNode
          key={node.relPath}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          gitChanges={gitChanges}
          onContextMenu={(e, n) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, node: n })
          }}
        />
      ))}

      {menu && (
        <div
          className="fixed z-50 min-w-40 bg-zinc-900 border border-zinc-700 rounded shadow-2xl py-1 text-xs"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.node.isDir && (
            <>
              <MenuItem label="New File" onClick={() => { ops.onNewFile?.(menu.node.relPath); setMenu(null) }} />
              <MenuItem label="New Folder" onClick={() => { ops.onNewFolder?.(menu.node.relPath); setMenu(null) }} />
              <div className="my-1 border-t border-zinc-800" />
            </>
          )}
          <MenuItem label="Rename" onClick={() => { ops.onRename?.(menu.node.relPath); setMenu(null) }} />
          <MenuItem label="Delete" danger onClick={() => { ops.onDelete?.(menu.node.relPath); setMenu(null) }} />
        </div>
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

interface TreeNodeProps {
  node: FileNode
  depth: number
  selectedFile: string | null
  onSelectFile: (relPath: string) => void
  gitChanges: { file: string; type: string }[]
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
}

function TreeNode({ node, depth, selectedFile, onSelectFile, gitChanges, onContextMenu }: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(depth === 0) // expand root items by default
  const isSelected = selectedFile === node.relPath

  const hasGitChanges = (n: FileNode): boolean =>
    gitChanges.some((c) => c.file === n.relPath || c.file.startsWith(n.relPath + '/'))

  const getGitStatus = (n: FileNode) => {
    if (n.isDir) return null
    const change = gitChanges.find((c) => c.file === n.relPath)
    return change ? change.type : null
  }

  const gitStatus = getGitStatus(node)
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
    if (node.isDir) {
      setIsOpen(!isOpen)
    } else {
      onSelectFile(node.relPath)
    }
  }

  return (
    <div>
      <div
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer transition-colors group rounded ${
          isSelected ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-900/60'
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

      {node.isDir && isOpen && node.children && (
        <div className="overflow-hidden">
          {node.children.map((child) => (
            <TreeNode
              key={child.relPath}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              gitChanges={gitChanges}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  )
}
