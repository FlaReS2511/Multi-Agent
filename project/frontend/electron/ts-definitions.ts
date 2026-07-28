// ts-definitions.ts — precise "Go to / Peek Definition" resolution for the
// editor, backed by the real TypeScript compiler API (not a grep heuristic).
//
// A LanguageService is created lazily per tsconfig scope the first time a file
// under it is queried. It reads sources straight from disk (through ts.sys),
// so cross-file / aliased / re-exported / overloaded symbols resolve exactly
// the way tsc would — no need to have the target file open in the editor.
//
// Runs in the Electron MAIN process: parsing a large program never blocks the
// renderer. `typescript` is kept EXTERNAL by the bundler (see vite.config.ts)
// and required from node_modules at runtime, like the native deps.

// Default import (not `* as ts`): the built main process is native ESM and
// `typescript` is an external CJS `export =` module. Under Node's ESM↔CJS
// interop only the default binding reliably maps to module.exports — a
// namespace import can come back with no named members (TS's exports live
// inside an IIFE, invisible to cjs-module-lexer).
import ts from 'typescript'
import * as path from 'path'
import * as fsSync from 'fs'

export interface DefResult {
  /** Workspace-relative path of the definition's file (forward slashes). */
  file: string
  /** 1-based line/column of the definition's name span (Monaco Range coords). */
  line: number
  column: number
  endLine: number
  endColumn: number
  name?: string
  kind?: string
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/')
}

// The actively-edited file may have unsaved changes whose line offsets differ
// from disk. The renderer ships its live buffer so resolution lines up with
// what the user is actually looking at; target files still come from disk.
const liveContents = new Map<string, string>() // normalized abs → content
const liveVersions = new Map<string, number>() // normalized abs → bump counter

function getScriptVersion(fileName: string): string {
  const n = normalize(fileName)
  if (liveContents.has(n)) return 'live:' + (liveVersions.get(n) || 0)
  try {
    return 'disk:' + fsSync.statSync(fileName).mtimeMs
  } catch {
    return 'missing'
  }
}

function getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
  const n = normalize(fileName)
  const live = liveContents.get(n)
  if (live != null) return ts.ScriptSnapshot.fromString(live)
  try {
    return ts.ScriptSnapshot.fromString(fsSync.readFileSync(fileName, 'utf8'))
  } catch {
    return undefined
  }
}

interface Svc {
  service: ts.LanguageService
  roots: Set<string> // normalized abs paths that seed this service's program
}

// One service per tsconfig scope (handles monorepos with several projects);
// falls back to a permissive default config for folders without a tsconfig.
const services = new Map<string, Svc>()

// Walk up from `startDir` to (and including) `root` looking for a tsconfig.
function findTsconfig(startDir: string, root: string): string | undefined {
  let dir = startDir
  // Only search inside the workspace so we don't pick up an unrelated config
  // living above the opened folder.
  while (dir === root || dir.startsWith(root + path.sep)) {
    const candidate = path.join(dir, 'tsconfig.json')
    if (fsSync.existsSync(candidate)) return candidate
    if (dir === root) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function loadCompilerOptions(tsconfig: string | undefined, root: string): ts.CompilerOptions {
  // Permissive defaults: resolve .ts/.tsx/.js/.jsx, JSX, bundler-style module
  // resolution. `allowNonTsExtensions` lets us feed .tsx roots directly.
  const base: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    baseUrl: root,
  }
  if (tsconfig) {
    try {
      const read = ts.readConfigFile(tsconfig, ts.sys.readFile)
      if (!read.error) {
        // Honors the project's baseUrl/paths (import aliases), jsx, lib, etc.
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfig))
        return { ...base, ...parsed.options }
      }
    } catch {
      /* fall back to base */
    }
  }
  return base
}

function makeHost(root: string, options: ts.CompilerOptions, roots: Set<string>): ts.LanguageServiceHost {
  return {
    getScriptFileNames: () => Array.from(roots),
    getScriptVersion,
    getScriptSnapshot,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    // Route existence/read through the live overrides so an unsaved buffer is
    // visible to module resolution too.
    fileExists: (f) => liveContents.has(normalize(f)) || ts.sys.fileExists(f),
    readFile: (f) => {
      const live = liveContents.get(normalize(f))
      return live != null ? live : ts.sys.readFile(f)
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  }
}

function getServiceFor(absFile: string, root: string): Svc {
  const tsconfig = findTsconfig(path.dirname(absFile), root)
  const key = tsconfig ? normalize(tsconfig) : 'default:' + normalize(root)
  let svc = services.get(key)
  if (!svc) {
    const options = loadCompilerOptions(tsconfig, root)
    const roots = new Set<string>()
    svc = { service: ts.createLanguageService(makeHost(root, options, roots), ts.createDocumentRegistry()), roots }
    services.set(key, svc)
  }
  // A newly-visited file becomes a program root; the service picks it up on the
  // next query (getScriptFileNames is read live).
  svc.roots.add(normalize(absFile))
  return svc
}

function setLive(absFile: string, liveContent: string | undefined): void {
  const n = normalize(absFile)
  if (liveContent == null) return
  if (liveContents.get(n) !== liveContent) {
    liveContents.set(n, liveContent)
    liveVersions.set(n, (liveVersions.get(n) || 0) + 1)
  }
}

/**
 * Resolve the definition(s) of the symbol at `offset` (a UTF-16 character
 * offset within `absFile`). Returns only definitions that live INSIDE the
 * workspace (own code + node_modules) — built-in lib.d.ts targets are dropped
 * since they can't be opened through the workspace-sandboxed file reader.
 */
export function resolveDefinition(
  absFile: string,
  offset: number,
  root: string,
  liveContent?: string,
): DefResult[] {
  setLive(absFile, liveContent)
  const { service } = getServiceFor(absFile, root)
  const fileName = normalize(absFile)
  const defs = service.getDefinitionAtPosition(fileName, offset)
  if (!defs || defs.length === 0) return []
  const program = service.getProgram()
  const out: DefResult[] = []
  const seen = new Set<string>()
  for (const d of defs) {
    const sf = program?.getSourceFile(d.fileName)
    if (!sf) continue
    // OS-native separators: the renderer keys models/tabs by `Uri.parse(rel)`
    // where `rel` comes from Node's `path.relative` (backslashes on Windows).
    // Returning forward slashes here would mismatch on Windows and spawn
    // duplicate tabs. Keep `path.relative`'s native output for `file`.
    const rel = path.relative(root, d.fileName)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue // outside workspace (e.g. lib.d.ts)
    const start = sf.getLineAndCharacterOfPosition(d.textSpan.start)
    const end = sf.getLineAndCharacterOfPosition(d.textSpan.start + d.textSpan.length)
    const key = `${normalize(rel)}:${start.line}:${start.character}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      file: rel,
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      name: d.name,
      kind: d.kind,
    })
  }
  return out
}

/** Drop all cached services (e.g. when the workspace root changes). */
export function resetDefinitionServices(): void {
  services.clear()
  liveContents.clear()
  liveVersions.clear()
}
