import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/* Clean URLs for the standalone pages. In production the Next app serves them
   (src/app/<page>/route.ts); this gives the dev and preview servers the same
   behaviour, instead of falling back to the landing page. */
const PAGES = ['grading-services', 'contact']

function cleanUrls() {
  const rewrite = (req, _res, next) => {
    const [path, query = ''] = req.url.split('?')
    const page = path.replace(/^\/|\/$/g, '')
    if (PAGES.includes(page)) req.url = `/${page}.html${query ? `?${query}` : ''}`
    next()
  }
  return {
    name: 'clean-urls',
    configureServer(server) {
      server.middlewares.use(rewrite)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite)
    },
  }
}

export default defineConfig({
  plugins: [react(), cleanUrls()],
  server: {
    port: 5173,
    // the API lives in the Next app (run it from the repo root, port 3000)
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    // separate entries — the policy, grading and contact pages are their own static
    // pages, so they need no router and none of the landing page's heavier bundle
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        grading: resolve(__dirname, 'grading-services.html'),
        contact: resolve(__dirname, 'contact.html'),
      },
    },
  },
})
