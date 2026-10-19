// @vitest-environment happy-dom
// Smoke test: every tab renders, in both languages, without a device.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { I18nProvider } from '../i18n';
import { Tab } from '../types';

const TABS: Tab[] = ['dashboard', 'link', 'config', 'lora', 'passthrough', 'factory', 'tools'];

describe('App', () => {
  for (const lang of ['zh-TW', 'en']) {
    it.each(TABS)(`renders the %s tab (${lang})`, (tab) => {
      localStorage.setItem('hx-lang', lang);
      localStorage.setItem('hx-tab', tab);
      const html = renderToString(
        <I18nProvider>
          <App />
        </I18nProvider>,
      );
      expect(html).toContain(lang === 'en' ? 'HX Gateway Tool' : 'HX 閘道器工具');
      expect(html).not.toMatch(/(?:tab|conn|dash|field|common)\.[a-z]+/); // no untranslated key leaked
    });
  }
});
