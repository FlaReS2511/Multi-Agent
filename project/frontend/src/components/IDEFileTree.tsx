import React, { useState } from 'react'
import { Folder, FolderOpen, File, ChevronDown, ChevronRight } from 'lucide-react'

interface FileNode {
  name: string
  relPath: string
  isDir: boolean
  children?: FileNode[]
}

interface IDEFileTreeProps {
  files: FileNode[]
  selectedFile: string | null
  onSelectFile: (relPath: string) => void
  gitChanges: { file: string; type: string }[]
}

export function IDEFileTree({ files, selectedFile, onSelectFile, gitChanges }: IDEFileTreeProps) {
  return (
    <div className="text-xs select-none font-mono text-zinc-300">
      {files.map((node) => (
        <TreeNode
          key={node.relPath}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          gitChanges={gitChanges}
        />
      ))}
    </div>
  )
}

interface TreeNodeProps {
  node: FileNode
  depth: number
  selectedFile: string | null
  onSelectFile: (relPath: string) => void
  gitChanges: { file: string; type: string }[]
}

function TreeNode({ node, depth, selectedFile, onSelectFile, gitChanges }: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(depth === 0) // expand root items by default
  const isSelected = selectedFile === node.relPath

  // Find if this node (or any of its children recursively) has git changes
  const hasGitChanges = (n: FileNode): boolean => {
    if (gitChanges.some((c) => c.file === n.relPath || c.file.startsWith(n.relPath + '/'))) {
      return true
    }
    return false
  }

  // Get specific Git change status for a file node
  const getGitStatus = (n: FileNode) => {
    if (n.isDir) return null
    const change = gitChanges.find((c) => c.file === n.relPath)
    if (!change) return null
    return change.type // 'M', 'A', '??', etc.
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
            <span className="text-zinc-500">
              <File size={14} className={labelColor} />
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
