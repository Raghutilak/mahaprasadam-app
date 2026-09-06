import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Listen on all network interfaces (0.0.0.0), not just localhost —
    // required for a phone on the same Wi-Fi to reach this dev server
    // via the laptop's LAN IP at all.
    host: true,
    port: 5173,
    strictPort: true,
    hmr: {
      // Without this, the browser's hot-reload WebSocket tries to
      // reconnect to "localhost:5173" literally — which resolves to
      // the PHONE itself (not the laptop) when opened from another
      // device, so the socket can never connect. Setting clientPort
      // explicitly (and letting the browser use whatever hostname it
      // actually loaded the page from) fixes that mismatch.
      clientPort: 5173,
    },
  },
})



// import { defineConfig } from 'vite'
// import react from '@vitejs/plugin-react'

// export default defineConfig({
//   plugins: [react()],
//   server: {
//     host: '0.0.0.0',
//     port: 5173,
//   },
// })