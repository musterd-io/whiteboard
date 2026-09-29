import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the browser page (web/) that renders the live board. The node service serves the
// output of this build from dist-web/ — see serveStatic() in src/service.ts.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    // tldraw 4.x ships syntax past vite's default baseline; this page only ever runs in the
    // operator's own current browser, so target the build at modern engines.
    target: 'es2022',
    outDir: '../dist-web',
    emptyOutDir: true,
  },
});
