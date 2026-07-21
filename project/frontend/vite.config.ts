import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

const nativeExternal = ['node-pty', 'better-sqlite3', 'exceljs']
// discord.js is a large Node library with dynamic requires (ws, zlib bindings).
// Keep it external for the bot child-process build so Rollup doesn't try to
// bundle it; it's resolved from node_modules at runtime like the native deps.
const botExternal = [...nativeExternal, 'discord.js']

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: nativeExternal,
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
      },
      renderer: {},
    }),
    // Second Electron build: the CHILD-PROCESS entries (agent runtime +
    // Discord bot) share one build — they used to be two separate plugin
    // instances, each re-bundling the shared electron/*.ts modules.
    electron({
      main: {
        entry: ['electron/agent-runtime.ts', 'electron/discord-bot.ts'],
        onstart() {
          // Do NOT auto-start Electron for these — main.ts spawns them as
          // child processes on demand.
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: botExternal,
              output: { entryFileNames: '[name].js' },
            },
          },
        },
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Keep the heavyweights out of the entry chunk. Monaco/xterm still
        // load from local disk (Electron loadFile — no network), but the
        // entry parses sooner and lazy panels only pull what they need.
        manualChunks(id: string) {
          if (id.includes('monaco-editor')) return 'monaco'
          if (id.includes('@xterm')) return 'xterm'
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('mdast') || id.includes('micromark') || id.includes('unified')) return 'markdown'
          if (id.includes('framer-motion')) return 'motion'
        },
      },
    },
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['node-pty'],
  },
})
