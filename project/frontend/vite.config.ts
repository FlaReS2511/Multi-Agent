import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

const nativeExternal = ['node-pty', 'better-sqlite3']

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
    // Second Electron build: the agent runtime. It's a standalone Node entry
    // (spawned as a child process by the main process), not part of the app
    // window. Built to dist-electron/agent-runtime.js.
    electron({
      main: {
        entry: 'electron/agent-runtime.ts',
        onstart() {
          // Do NOT auto-start Electron for this entry — it's a child process
          // launched on demand by main.ts, not the app itself.
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: nativeExternal,
              output: { entryFileNames: 'agent-runtime.js' },
            },
          },
        },
      },
    }),
  ],
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['node-pty'],
  },
})
