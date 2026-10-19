import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // relative asset paths, so GitHub Pages works under any repo name
  build: {
    outDir: 'dist',
  },
});
