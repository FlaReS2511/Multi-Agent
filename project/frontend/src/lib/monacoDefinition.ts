// monacoDefinition.ts — wire "Peek Definition" (Alt+F12), "Go to Definition"
// (F12) and the right-click menu entries to precise, disk-backed resolution
// from the main process (electron/ts-definitions.ts, TypeScript compiler API).
//
// Monaco ships the whole Peek widget UI — a floating, scrollable, in-place
// editor that auto-positions inside the viewport. We only feed it locations;
// the surfacing animation is styled in index.css (.peekview-widget).
//
// Imported for its side effects by monacoSetup after loader.config(monaco).

import type * as Monaco from 'monaco-editor'

// Languages whose files our TS service can resolve (see detectLanguage()).
const LANGS = ['typescript', 'javascript'] as const

// A model's Uri is created via `Uri.parse(relPath)` (uncontrolled <Editor path>),
// so the workspace-relative path is exactly the Uri's path minus any leading '/'.
function relFromUri(uri: Monaco.Uri): string {
  return uri.path.replace(/^\/+/, '')
}

// The app owns the tab strip. When the user "opens full" from the peek widget
// (or hits F12 to a different file), route it here so a real editor tab opens
// and reveals the line — standalone Monaco otherwise silently no-ops.
type OpenFn = (rel: string, line: number, column: number) => void
let opener: OpenFn | null = null
export function setDefinitionOpener(fn: OpenFn | null): void {
  opener = fn
}

let registered = false

export function registerDefinitionSupport(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  // Monaco's built-in TS worker also offers definitions, but only for models
  // already open in memory (it can't see the rest of the workspace) — which
  // would yield duplicate/partial peek entries. Make our disk-backed provider
  // the single source of truth. (The `typescript` namespace is stubbed in the
  // top-level d.ts as `{ deprecated: true }`; the real defaults object is
  // present at runtime once the language contribution loads.)
  try {
    interface ModeDefaults {
      modeConfiguration: Record<string, boolean>
      setModeConfiguration(m: Record<string, boolean>): void
      setDiagnosticsOptions(o: Record<string, boolean>): void
    }
    const tsd = monaco.languages.typescript as unknown as {
      typescriptDefaults: ModeDefaults
      javascriptDefaults: ModeDefaults
    }
    for (const defaults of [tsd.typescriptDefaults, tsd.javascriptDefaults]) {
      defaults.setModeConfiguration({ ...defaults.modeConfiguration, definitions: false })
      // The in-worker service only sees open models (no tsconfig, no full
      // program), so its SEMANTIC checks flag every cross-file import as an
      // error — pure noise. Keep syntax validation (real typos) but drop the
      // misleading red squiggles. Precise navigation comes from our provider.
      defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
    }
  } catch {
    /* typescript language services not present — provider below still works */
  }

  const provider: Monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position) {
      const rel = relFromUri(model.uri)
      if (!rel) return null
      const offset = model.getOffsetAt(position)
      let res
      try {
        // Ship the live buffer so offsets line up with unsaved edits.
        res = await window.api.resolveDefinition(rel, offset, model.getValue())
      } catch {
        return null
      }
      if (!res?.ok || !res.defs?.length) return null

      const locations: Monaco.languages.Location[] = []
      for (const d of res.defs) {
        const uri = monaco.Uri.parse(d.file)
        // The Peek widget renders the target inside a model at this Uri. If the
        // file isn't open yet, materialize a model from disk (reused verbatim
        // when the user later opens the tab — same path-keyed Uri).
        if (!monaco.editor.getModel(uri)) {
          try {
            const disk = await window.api.workspaceReadFile(d.file)
            if (disk.ok) monaco.editor.createModel(disk.content, undefined, uri)
          } catch {
            continue
          }
        }
        locations.push({
          uri,
          range: new monaco.Range(d.line, d.column, d.endLine, d.endColumn),
        })
      }
      return locations.length ? locations : null
    },
  }

  for (const lang of LANGS) {
    monaco.languages.registerDefinitionProvider(lang, provider)
  }

  // Bridge Monaco's "open this location" (peek → Open, cross-file F12) to the
  // app's tab system. Returning true marks it handled so Monaco doesn't fall
  // back to its standalone opener (which can't reach our tabs).
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const rel = relFromUri(resource)
      if (!rel || !opener) return false
      let line = 1
      let column = 1
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber
          column = selectionOrPosition.startColumn
        } else {
          line = selectionOrPosition.lineNumber
          column = selectionOrPosition.column
        }
      }
      opener(rel, line, column)
      return true
    },
  })
}
