import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Gera o service worker (sw.js) com a lista de arquivos do build para o app abrir sem internet. */
function serviceWorker(): Plugin {
  return {
    name: 'folha-sw',
    apply: 'build',
    generateBundle(_o, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const extra = ['./', 'index.html', 'manifest.webmanifest', 'folha.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
      const version = Date.now().toString(36);
      const list = JSON.stringify([...new Set([...extra, ...files.filter((f) => f !== 'index.html')])]);
      const code = `// Folha Caixa — service worker (gerado no build)
const CACHE = 'folha-${version}';
const FILES = ${list};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('folha-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return; // dados nunca vêm do cache do SW
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put('index.html', c)); return r; })
      .catch(() => caches.match('index.html', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return r; })));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // GitHub Pages serve em /folha-caixa/ (modo "supabase"); servidor local serve na raiz
  base: process.env.VITE_BASE ?? (mode === 'supabase' ? '/folha-caixa/' : '/'),
  plugins: [react(), serviceWorker()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:5170' } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
}));
