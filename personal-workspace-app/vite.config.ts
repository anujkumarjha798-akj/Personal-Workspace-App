import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devPort = Number(process.env.VITE_DEV_PORT) || 4173
const apiPort = Number(process.env.PORT) || 5173

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Vite only serves the frontend during development. The workspace
    // server (server/index.mjs) listens on 0.0.0.0:5173 and proxies
    // non-API requests here, so Vite itself stays internal to the machine.
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
})
