// monacoSetup.ts — bundle Monaco locally instead of @monaco-editor/react's
// default jsdelivr CDN loader. Cold starts no longer hit the network (the
// editor previously could not come up offline at all), and the language
// workers run from local chunks.
//
// Imported for its side effects by IDEView before any <Editor> renders.

// monaco-editor ≥0.53 exposes subpaths through its exports map
// ("monaco-editor/<p>.js" → "./esm/vs/<p>.js") — the old esm/vs deep paths
// are blocked by Node package-exports resolution.
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

loader.config({ monaco })
