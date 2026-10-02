import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/300.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import './styles.css';
import { App } from './App';
import { AppProvider } from './ctx';

createRoot(document.getElementById('root')!).render(<AppProvider><App /></AppProvider>);

// PWA: instala no celular/PC e abre a tela sem internet (dados continuam vindo do servidor)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}); });
}
