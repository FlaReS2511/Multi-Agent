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
    // Third Electron build: the Discord bot. Like agent-runtime, it's a
    // standalone Node entry spawned as a child process by main.ts (only when
    // discord.enabled=true). Built to dist-electron/discord-bot.js.
    electron({
      main: {
        entry: 'electron/discord-bot.ts',
        onstart() {
          // Do NOT auto-start Electron for this entry — main.ts spawns it.
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: botExternal,
              output: { entryFileNames: 'discord-bot.js' },
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
