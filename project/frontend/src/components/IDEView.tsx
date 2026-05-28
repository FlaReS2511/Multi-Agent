import React, { useEffect, useState, useCallback, useRef } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import {
  FolderTree,
  GitBranch,
  Terminal as TerminalIcon,
  Save,
  Split,
  Eye,
  ChevronDown,
  ChevronUp,
  X,
  RefreshCw,
  Layout,
  Cpu,
  Layers,
  ArrowRight,
} from 'lucide-react'
import { IDEFileTree } from './IDEFileTree'
import { AgentTerminal } from './AgentTerminal'
import { activeAgents, AgentsConfig, colorFor } from '../lib/api'

interface FileNode {
  name: string
  relPath: string
  isDir: boolean
  children?: FileNode[]
}

interface GitChange {
  file: string
  type: string
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'py':
      return 'python'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
      return 'markdown'
    case 'sh':
      return 'shell'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}

export function IDEView() {
  // Sidebar State
  const [activeSidebar, setActiveSidebar] = useState<'explorer' | 'git' | 'agents'>('explorer')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  // Files & Git State
  const [files, setFiles] = useState<FileNode[]>([])
  const [gitChanges, setGitChanges] = useState<GitChange[]>([])
  const [loadingWorkspace, setLoadingWorkspace] = useState(false)

  // Editor Tabs State
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  
  // File Contents State
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [originalContents, setOriginalContents] = useState<Record<string, string>>({})
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({})

  // Editor View Configuration
  const [diffMode, setDiffMode] = useState(false)
  const [renderSideBySide, setRenderSideBySide] = useState(false) // default inline diff (green/red lines)

  // Bottom dock panel state
  const [isBottomOpen, setIsBottomOpen] = useState(true)
  const [bottomTab, setBottomTab] = useState<'terminal' | 'logs'>('terminal')
  const [selectedAgent, setSelectedAgent] = useState<string>('orchestrator')
  const [agentsConfig, setAgentsConfig] = useState<AgentsConfig | null>(null)
  const [agentLogs, setAgentLogs] = useState<Record<string, string[]>>({})

  const editorRef = useRef<any>(null)

  // Scan workspace files
  const refreshWorkspace = useCallback(async () => {
    setLoadingWorkspace(true)
    try {
      const allFiles = await window.api.workspaceListFiles()
      setFiles(allFiles)
      const changes = await window.api.workspaceGitStatus()
      setChangesList(changes)
    } catch (err) {
      console.error('Failed to load workspace files:', err)
    } finally {
      setLoadingWorkspace(false)
    }
  }, [])

  const setChangesList = (changes: GitChange[]) => {
    setGitChanges(changes)
  }

  // Load agents config to get the list of active agents
  useEffect(() => {
    window.api.getAgentsConfig().then(setAgentsConfig)
    refreshWorkspace()
  }, [refreshWorkspace])

  // Get active agents list
  const agentsList = activeAgents(agentsConfig)

  // Periodically refresh Git status and live logs
  useEffect(() => {
    const tick = async () => {
      // Refresh git changes
      const changes = await window.api.workspaceGitStatus()
      setChangesList(changes)

      // Refresh logs
      const allLogs = await window.api.getLogs()
      const logMap: Record<string, string[]> = {}
      for (const entry of allLogs) {
        logMap[entry.agent] = entry.lines
      }
      setAgentLogs(logMap)
    };

    tick()
    const i = setInterval(tick, 2000)
    return () => clearInterval(i)
  }, [])

  // Live-reload logic when AI modifies files on disk
  useEffect(() => {
    if (!activeTab) return

    const checkFileOnDisk = async () => {
      try {
        const diskFile = await window.api.workspaceReadFile(activeTab)
        if (!diskFile.ok) return

        // If file content on disk has changed
        if (diskFile.content !== fileContents[activeTab]) {
          // If the file is NOT dirty (no unsaved edits by the user in this session),
          // reload the content live! This allows seeing AI writing changes live!
          if (!dirtyFiles[activeTab]) {
            setFileContents((prev) => ({ ...prev, [activeTab]: diskFile.content }))
            
            // Also re-fetch original HEAD content in case the AI committed it or we need a fresh baseline
            const originalFile = await window.api.workspaceGitShowHead(activeTab)
            if (originalFile.ok) {
              setOriginalContents((prev) => ({ ...prev, [activeTab]: originalFile.content }))
            }
          }
        }
      } catch (err) {
        console.error('Failed to live-reload file:', err)
      }
    }

    const timer = setInterval(checkFileOnDisk, 2000)
    return () => clearInterval(timer)
  }, [activeTab, fileContents, dirtyFiles])

  // Handle open a file
  const openFile = async (relPath: string) => {
    // If not already in tabs, add it
    if (!openTabs.includes(relPath)) {
      setOpenTabs((prev) => [...prev, relPath])
      
      // Load file content
      const diskFile = await window.api.workspaceReadFile(relPath)
      const originalFile = await window.api.workspaceGitShowHead(relPath)

      if (diskFile.ok) {
        setFileContents((prev) => ({ ...prev, [relPath]: diskFile.content }))
      } else {
        setFileContents((prev) => ({ ...prev, [relPath]: `Failed to load file: ${diskFile.content}` }))
      }

      if (originalFile.ok) {
        setOriginalContents((prev) => ({ ...prev, [relPath]: originalFile.content }))
      } else {
        setOriginalContents((prev) => ({ ...prev, [relPath]: '' }))
      }
    }

    setActiveTab(relPath)
    
    // Automatically enable diff mode if the file is modified in git (added/modified)
    const isModified = gitChanges.some((c) => c.file === relPath)
    if (isModified) {
      setDiffMode(true)
    } else {
      setDiffMode(false)
    }
  }

  // Handle close tab
  const closeTab = (e: React.MouseEvent, relPath: string) => {
    e.stopPropagation()
    const nextTabs = openTabs.filter((t) => t !== relPath)
    setOpenTabs(nextTabs)

    if (activeTab === relPath) {
      if (nextTabs.length > 0) {
        setActiveTab(nextTabs[nextTabs.length - 1])
      } else {
        setActiveTab(null)
      }
    }
  }

  // Handle file edit inside Editor
  const handleEditorChange = (value: string | undefined) => {
    if (!activeTab || value === undefined) return
    setFileContents((prev) => ({ ...prev, [activeTab]: value }))
    setDirtyFiles((prev) => ({ ...prev, [activeTab]: true }))
  }

  // Handle save file
  const saveActiveFile = async () => {
    if (!activeTab || !dirtyFiles[activeTab]) return
    const content = fileContents[activeTab] || ''
    const res = await window.api.workspaceWriteFile(activeTab, content)
    if (res.ok) {
      setDirtyFiles((prev) => ({ ...prev, [activeTab]: false }))
      // Update original baseline post-save to match git if we commit, or just keep it
      // Let's refresh workspace to update Git changes state
      refreshWorkspace()
    } else {
      alert(`Error saving file: ${res.error}`)
    }
  }

  // Handle keyboard shortcut for Save (Cmd+S / Ctrl+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveActiveFile()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, fileContents, dirtyFiles])

  // Custom theme initialization for Monaco
  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor
    // Set custom HSL dark theme values
    monaco.editor.defineTheme('vscode-dark-harmony', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
        { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
        { token: 'string', foreground: 'ce9178' },
        { token: 'number', foreground: 'b5cea8' },
        { token: 'regexp', foreground: 'd16969' },
        { token: 'type', foreground: '4ec9b0' },
        { token: 'class', foreground: '4ec9b0' },
        { token: 'function', foreground: 'dcdcaa' },
      ],
      colors: {
        'editor.background': '#09090b', // zinc-950
        'editor.foreground': '#e4e4e7', // zinc-200
        'editor.lineHighlightBackground': '#18181b', // zinc-900
        'editorCursor.foreground': '#a1a1aa', // zinc-400
        'editorLineNumber.foreground': '#3f3f46', // zinc-700
        'editorLineNumber.activeForeground': '#a1a1aa', // zinc-400
        'editor.selectionBackground': '#264f78',
        'minimap.background': '#09090b',
      },
    })
    monaco.editor.setTheme('vscode-dark-harmony')
  }

  return (
    <div className="h-full flex bg-zinc-950 text-zinc-200 overflow-hidden select-none font-sans">
      {/* 1. Icon-only Activity Bar */}
      <nav className="w-12 border-r border-zinc-800 bg-zinc-950 flex flex-col items-center py-3 gap-6 flex-shrink-0">
        <ActivityButton
          icon={<FolderTree size={20} />}
          label="Explorer"
          active={activeSidebar === 'explorer' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'explorer' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('explorer')
              setIsSidebarOpen(true)
            }
          }}
        />
        <ActivityButton
          icon={
            <div className="relative">
              <GitBranch size={20} />
              {gitChanges.length > 0 && (
                <span className="absolute -top-1 -right-1 size-3.5 bg-amber-500 text-zinc-950 rounded-full text-[9px] font-bold flex items-center justify-center animate-pulse scale-90">
                  {gitChanges.length}
                </span>
              )}
            </div>
          }
          label="Source Control"
          active={activeSidebar === 'git' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'git' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('git')
              setIsSidebarOpen(true)
            }
          }}
        />
        <ActivityButton
          icon={<Cpu size={20} />}
          label="AI Agents"
          active={activeSidebar === 'agents' && isSidebarOpen}
          onClick={() => {
            if (activeSidebar === 'agents' && isSidebarOpen) {
              setIsSidebarOpen(false)
            } else {
              setActiveSidebar('agents')
              setIsSidebarOpen(true)
            }
          }}
        />
        <div className="mt-auto flex flex-col gap-4">
          <ActivityButton
            icon={<RefreshCw size={18} className={loadingWorkspace ? 'animate-spin text-blue-400' : ''} />}
            label="Refresh Workspace"
            active={false}
            onClick={refreshWorkspace}
          />
        </div>
      </nav>

      {/* 2. Expandable Sidebar Panel */}
      {isSidebarOpen && (
        <aside className="w-64 border-r border-zinc-800 bg-zinc-950/40 backdrop-blur-md flex flex-col flex-shrink-0 overflow-hidden transition-all duration-300">
          {/* Header */}
          <div className="h-10 px-3 border-b border-zinc-800 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-zinc-400">
            <span>
              {activeSidebar === 'explorer' && 'Workspace Explorer'}
              {activeSidebar === 'git' && 'Source Control'}
              {activeSidebar === 'agents' && 'AI Agents Cost & Status'}
            </span>
            <button
              onClick={() => setIsSidebarOpen(false)}
              className="text-zinc-500 hover:text-zinc-300 p-0.5 rounded transition-colors"
            >
              <Layout size={14} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
            {activeSidebar === 'explorer' && (
              <IDEFileTree
                files={files}
                selectedFile={activeTab}
                onSelectFile={openFile}
                gitChanges={gitChanges}
              />
            )}

            {activeSidebar === 'git' && (
              <div className="flex flex-col gap-2">
                <div className="text-[10px] text-zinc-500 font-medium px-2 py-1 uppercase tracking-wider">
                  Uncommitted Changes ({gitChanges.length})
                </div>
                {gitChanges.length === 0 ? (
                  <div className="text-xs text-zinc-600 px-2 py-4 text-center italic">
                    No files changed. Clean working tree.
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {gitChanges.map((change) => {
                      const isMod = change.type === 'M'
                      return (
                        <div
                          key={change.file}
                          onClick={() => openFile(change.file)}
                          className={`flex items-center justify-between px-2 py-1.5 rounded cursor-pointer transition-all ${
                            activeTab === change.file
                              ? 'bg-zinc-800/80 text-white font-medium shadow-sm'
                              : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                          }`}
                        >
                          <span className="text-xs truncate font-mono flex-1">{change.file}</span>
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded-sm scale-90 ${
                              isMod
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            }`}
                          >
                            {change.type}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {activeSidebar === 'agents' && (
              <div className="flex flex-col gap-3 p-1">
                {agentsList.map((agent) => (
                  <div
                    key={agent}
                    onClick={() => {
                      setSelectedAgent(agent)
                      setIsBottomOpen(true)
                    }}
                    className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                      selectedAgent === agent && isBottomOpen
                        ? 'bg-zinc-900 border-zinc-700 shadow-md ring-1 ring-zinc-700/50'
                        : 'bg-zinc-900/40 border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900/60'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-semibold font-mono ${colorFor(agent)}`}>
                        {agent}
                      </span>
                      <span className="size-1.5 rounded-full bg-zinc-600" />
                    </div>
                    <div className="text-[10px] text-zinc-500 flex items-center justify-between">
                      <span>Logs: {agentLogs[agent]?.length || 0} lines</span>
                      <span className="font-mono text-zinc-400 hover:text-white flex items-center gap-0.5">
                        Open PTY <ArrowRight size={10} />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      )}

      {/* 3. Editor & Terminal Dashboard Workspace */}
      <section className="flex-1 flex flex-col overflow-hidden bg-zinc-950">
        
        {/* Tab Bar Header */}
        <div className="h-10 border-b border-zinc-800 bg-zinc-950/60 backdrop-blur flex items-center justify-between px-2 flex-shrink-0 overflow-x-auto select-none">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 max-w-full">
            {openTabs.map((tab) => {
              const isActive = activeTab === tab
              const isDirty = dirtyFiles[tab]
              const hasGit = gitChanges.some((c) => c.file === tab)
              
              let tabColor = 'border-transparent text-zinc-500 bg-transparent hover:bg-zinc-900/40 hover:text-zinc-300'
              if (isActive) {
                tabColor = 'border-blue-500 text-white bg-zinc-900/60 shadow-inner'
              } else if (hasGit) {
                tabColor = 'border-transparent text-amber-500/80 bg-transparent hover:bg-zinc-900/40'
              }

              return (
                <div
                  key={tab}
                  onClick={() => openFile(tab)}
                  className={`h-8 px-3 border-b-2 flex items-center gap-2 cursor-pointer transition-all text-xs font-mono select-none rounded-t ${tabColor}`}
                >
                  <span className="truncate max-w-[140px]">{tab.split('/').pop()}</span>
                  
                  {isDirty ? (
                    <span className="size-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
                  ) : (
                    <button
                      onClick={(e) => closeTab(e, tab)}
                      className="text-zinc-600 hover:text-zinc-300 p-0.5 rounded-full flex-shrink-0 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              )
            })}

            {openTabs.length === 0 && (
              <span className="text-xs text-zinc-600 font-mono px-3">No files open</span>
            )}
          </div>

          {/* Action Bar (Top Right Toolbar) */}
          {activeTab && (
            <div className="flex items-center gap-1.5 flex-shrink-0 pl-4 border-l border-zinc-800/80">
              {/* Save Button */}
              <button
                onClick={saveActiveFile}
                disabled={!dirtyFiles[activeTab]}
                title="Save (Cmd+S)"
                className={`p-1.5 rounded flex items-center justify-center transition-all ${
                  dirtyFiles[activeTab]
                    ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-500/10'
                    : 'text-zinc-600 bg-zinc-900/40 border border-zinc-800 cursor-not-allowed'
                }`}
              >
                <Save size={14} />
              </button>

              {/* Diff Toggle Button */}
              <button
                onClick={() => setDiffMode(!diffMode)}
                title={diffMode ? 'Switch to Normal Editor' : 'Switch to Diff Highlight View'}
                className={`p-1.5 rounded border transition-all flex items-center gap-1 ${
                  diffMode
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                <Eye size={14} />
                <span className="text-[10px] font-semibold hidden md:inline">Diff View</span>
              </button>

              {/* Split screen diff vs inline diff (only visible when in diffMode) */}
              {diffMode && (
                <button
                  onClick={() => setRenderSideBySide(!renderSideBySide)}
                  title={renderSideBySide ? 'Switch to Inline Diff' : 'Switch to Side-by-Side Split Diff'}
                  className="p-1.5 rounded border border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800 transition-all flex items-center gap-1"
                >
                  <Split size={14} className={renderSideBySide ? '' : 'rotate-90'} />
                  <span className="text-[10px] font-semibold hidden md:inline">
                    {renderSideBySide ? 'Side' : 'Inline'}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Editor Main Content Area */}
        <div className="flex-1 min-h-0 relative overflow-hidden flex flex-col bg-zinc-950">
          {activeTab ? (
            <div className="absolute inset-0 flex flex-col">
              {diffMode ? (
                <div className="flex-1 w-full overflow-hidden relative">
                  <DiffEditor
                    height="100%"
                    language={detectLanguage(activeTab)}
                    original={originalContents[activeTab] || ''}
                    modified={fileContents[activeTab] || ''}
                    theme="vscode-dark-harmony"
                    options={{
                      renderSideBySide,
                      originalEditable: false,
                      readOnly: false,
                      fontSize: 13,
                      lineHeight: 1.5,
                      fontFamily: 'ui-monospace, SF Mono, JetBrains Mono, Consolas, monospace',
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                    }}
                  />
                </div>
              ) : (
                <div className="flex-1 w-full overflow-hidden relative">
                  <Editor
                    height="100%"
                    language={detectLanguage(activeTab)}
                    value={fileContents[activeTab] || ''}
                    onChange={handleEditorChange}
                    onMount={handleEditorDidMount}
                    theme="vscode-dark-harmony"
                    options={{
                      fontSize: 13,
                      lineHeight: 1.5,
                      fontFamily: 'ui-monospace, SF Mono, JetBrains Mono, Consolas, monospace',
                      minimap: { enabled: true },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      tabSize: 4,
                      insertSpaces: true,
                    }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 select-none bg-zinc-950">
              <Layers size={40} className="text-zinc-800 mb-3 animate-pulse" />
              <p className="text-sm font-semibold">VSCode Workspace IDE View</p>
              <p className="text-xs text-zinc-700 mt-1 max-w-xs text-center">
                Select a file from the Explorer sidebar or view changes in the Source Control tab to open them in Monaco Editor with live AI-execution highlighting.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 max-w-sm text-zinc-600 text-[10px] font-mono border-t border-zinc-900 pt-4">
                <span className="text-right">Open File:</span>
                <span className="text-zinc-500">Click Explorer item</span>
                <span className="text-right">Save Changes:</span>
                <span className="text-zinc-500">Cmd + S</span>
                <span className="text-right">Live Code Diff:</span>
                <span className="text-zinc-500">Enable Diff View</span>
                <span className="text-right">Active Agent Terminal:</span>
                <span className="text-zinc-500">Click Agents sidebar</span>
              </div>
            </div>
          )}
        </div>

        {/* 4. Collapsible Integrated Agent Dock (Terminal & Logs) */}
        <div
          className={`flex flex-col border-t border-zinc-800 bg-zinc-950/80 backdrop-blur-md transition-all duration-300 flex-shrink-0 ${
            isBottomOpen ? 'h-64' : 'h-8'
          }`}
        >
          {/* Header Panel Control */}
          <div
            onClick={() => setIsBottomOpen(!isBottomOpen)}
            className="h-8 px-3 border-b border-zinc-900 bg-zinc-950 flex items-center justify-between cursor-pointer select-none text-zinc-500 hover:text-zinc-300"
          >
            <div className="flex items-center gap-4 text-xs font-semibold tracking-wide" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setBottomTab('terminal')
                  setIsBottomOpen(true)
                }}
                className={`py-1 px-2 rounded-md transition-all ${
                  bottomTab === 'terminal' && isBottomOpen ? 'text-white bg-zinc-800 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="flex items-center gap-1">
                  <TerminalIcon size={12} />
                  Agent Live Terminal ({selectedAgent})
                </span>
              </button>
              
              <button
                onClick={() => {
                  setBottomTab('logs')
                  setIsBottomOpen(true)
                }}
                className={`py-1 px-2 rounded-md transition-all ${
                  bottomTab === 'logs' && isBottomOpen ? 'text-white bg-zinc-800 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="flex items-center gap-1">
                  <Eye size={12} />
                  Logs Viewer
                </span>
              </button>
            </div>

            <div className="flex items-center gap-3">
              {/* Agent Selector Dropdown */}
              <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold font-mono">Agent:</span>
                <select
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-[10px] font-mono px-2 py-0.5 rounded focus:outline-none focus:border-zinc-600 select-none cursor-pointer"
                >
                  {agentsList.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                </select>
              </div>
              
              {isBottomOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </div>
          </div>

          {/* Bottom Dock Workspace Content */}
          {isBottomOpen && (
            <div className="flex-1 min-h-0 relative bg-zinc-950 overflow-hidden">
              {bottomTab === 'terminal' ? (
                <div className="h-full w-full relative">
                  <AgentTerminal key={selectedAgent} agent={selectedAgent} active={isBottomOpen && bottomTab === 'terminal'} />
                </div>
              ) : (
                <div className="h-full w-full bg-zinc-950 p-2 overflow-y-auto font-mono text-[11px] text-zinc-400 select-text scrollbar-thin">
                  {agentLogs[selectedAgent] && agentLogs[selectedAgent].length > 0 ? (
                    agentLogs[selectedAgent].map((line, idx) => (
                      <div key={idx} className="hover:bg-zinc-900/60 py-0.5 px-2 border-l border-zinc-800">
                        {line}
                      </div>
                    ))
                  ) : (
                    <div className="h-full flex items-center justify-center text-zinc-600 italic">
                      No logs recorded for {selectedAgent} in this session.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

      </section>
    </div>
  )
}

interface ActivityButtonProps {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}

function ActivityButton({ icon, label, active, onClick }: ActivityButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`size-10 rounded-lg flex items-center justify-center transition-all ${
        active
          ? 'bg-zinc-800 text-white shadow-inner scale-105 border border-zinc-700/50'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
      }`}
    >
      {icon}
    </button>
  )
}
