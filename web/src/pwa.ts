// Instalação do app (PWA) e atualização do service worker.
// O Chrome do Android dispara "beforeinstallprompt" quando o app pode ser instalado: guardamos o evento
// para o botão "Instalar app" abrir a janela de instalação na hora.
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferred: BIP | null = null;
let installed = false;
let waitingSW: ServiceWorker | null = null;
const emit = () => window.dispatchEvent(new Event('folha:pwa'));

export const isStandalone = () => typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: minimal-ui)').matches || (navigator as any).standalone === true);
const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);
export const isIOS = () => /iphone|ipad|ipod/i.test(ua()) || (/macintosh/i.test(ua()) && 'ontouchend' in document);
export const isAndroid = () => /android/i.test(ua());
/** navegador interno de app (WhatsApp, Instagram, Facebook…): não instala PWA */
export const inAppBrowser = () => /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|; wv\)|Snapchat|TikTok|musical_ly|Telegram/i.test(ua());
export const isSamsung = () => /SamsungBrowser/i.test(ua());

export function pwaState() {
  return { canPrompt: !!deferred, installed: installed || isStandalone(), updateReady: !!waitingSW };
}
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const d = deferred; deferred = null; emit();
  await d.prompt();
  const r = await d.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  return r.outcome;
}
/** abre esta página no Chrome (sai do navegador do WhatsApp/Instagram) */
export const chromeIntentUrl = () => `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(location.href)};end`;

export function applyUpdate() {
  if (!waitingSW) { location.reload(); return; }
  waitingSW.postMessage('SKIP_WAITING');
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BIP; emit(); });
  window.addEventListener('appinstalled', () => { installed = true; deferred = null; emit(); });
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
      const hadController = !!navigator.serviceWorker.controller;
      const track = (sw: ServiceWorker | null) => {
        if (!sw) return;
        const done = () => { if (sw.state === 'installed' && navigator.serviceWorker.controller) { waitingSW = sw; emit(); } };
        done(); sw.addEventListener('statechange', done);
      };
      // abriu o app e já tinha versão nova esperando: ainda não começou a venda, então atualiza na hora
      if (reg.waiting && hadController) { waitingSW = reg.waiting; applyUpdate(); return; }
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
      // confere atualização a cada 30 min e quando o app volta para a frente
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    } catch { /* sem SW: o app funciona, só não abre offline */ }
  });
}
