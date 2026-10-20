import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // relative asset paths, so GitHub Pages works under any repo name
  build: {
    outDir: 'dist',
    // Two separate pages: the Modbus tool at ./ and the Bluetooth status page
    // at ./ble/ (phones, the device label's QR code). Neither loads the
    // other's code. Paths are relative to the project root (npm scripts run there).
    rollupOptions: {
      input: {
        main: 'index.html',
        ble: 'ble/index.html',
      },
    },
  },
});
