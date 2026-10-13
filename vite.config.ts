import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths: the build works from any folder (GitHub Pages serves it at /Reclaimed/)
  base: './',
  server: { port: 5173, strictPort: true },
});
