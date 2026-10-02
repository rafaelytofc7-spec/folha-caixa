import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

/** versão do app: package.json da raiz (aparece em Config. e no nome do cache do service worker) */
const APP_VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Gera o service worker (sw.js) com a lista de arquivos do build para o app abrir sem internet. */
function serviceWorker(): Plugin {
  return {
    name: 'folha-sw',
    apply: 'build',
    generateBundle(_o, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const icons = fs.readdirSync(new URL('./public/icons', import.meta.url)).filter((f) => f.endsWith('.png')).map((f) => 'icons/' + f);
      const extra = ['./', 'index.html', 'manifest.webmanifest', 'folha.svg', ...icons];
      const version = Date.now().toString(36);
      const list = JSON.stringify([...new Set([...extra, ...files.filter((f) => f !== 'index.html')])]);
      const code = `// Folha Caixa — service worker (gerado no build)
const VERSION = '${APP_VERSION}';
const CACHE = 'folha-v${APP_VERSION}-${version}';
const FILES = ${list};
// Versão nova NÃO assume sozinha no meio de uma venda: o app mostra "Nova versão — Atualizar" e manda SKIP_WAITING.
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); });
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
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
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:5170' } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
}));
