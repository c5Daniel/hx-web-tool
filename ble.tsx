import React from 'react';
import ReactDOM from 'react-dom/client';
import BleApp from './BleApp';
import { I18nProvider } from './i18n';
import './index.css';

// Entry of the Bluetooth status page (ble/index.html). Same worker as the
// Modbus tool: one registration at the site root covers both pages, so the
// script and its default scope are one level up.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('../sw.js').catch(() => {
      /* best effort: the page works online without it */
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <BleApp />
    </I18nProvider>
  </React.StrictMode>,
);
