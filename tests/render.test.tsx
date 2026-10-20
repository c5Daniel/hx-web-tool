// @vitest-environment happy-dom
// Smoke test: both pages render, in both languages, without a device, and
// neither shows the other: the Modbus tool is ./, the Bluetooth status page ./ble/.
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import App from '../App';
import BleApp from '../BleApp';
import { BlePanel } from '../components/panels/BlePanel';
import { BleLink } from '../hooks/useBleStatus';
import { I18nProvider } from '../i18n';
import { Tab } from '../types';
import { decodeBleIdentity, decodeBleStatus } from '../utils/bleStatus';
import { h } from './mockLink';

const TABS: Tab[] = ['dashboard', 'link', 'config', 'lora', 'passthrough', 'factory', 'tools'];
const LEAKED_KEY = /(?:tab|conn|dash|field|common|mode|ble|fac)\.[a-z]+/;

const render = (node: ReactNode) => renderToString(<I18nProvider>{node}</I18nProvider>);

describe('App', () => {
  for (const lang of ['zh-TW', 'en']) {
    it.each(TABS)(`renders the %s tab (${lang})`, (tab) => {
      localStorage.setItem('hx-lang', lang);
      localStorage.setItem('hx-tab', tab);
      const html = render(<App />);
      expect(html).toContain(lang === 'en' ? 'HX Gateway Tool' : 'HX 閘道器工具');
      expect(html).not.toMatch(/(?:tab|conn|dash|field|common)\.[a-z]+/); // no untranslated key leaked
    });
  }

  it('has no Bluetooth page in it', () => {
    localStorage.setItem('hx-lang', 'en');
    localStorage.setItem('hx-tab', 'dashboard');
    const html = render(<App />);
    expect(html).not.toContain('HX Bluetooth status</h1>');
    expect(html).not.toContain('Connect device');
  });
});

describe('Bluetooth page', () => {
  for (const lang of ['zh-TW', 'en']) {
    it(`renders on its own and explains a browser without Web Bluetooth (${lang})`, () => {
      localStorage.setItem('hx-lang', lang);
      const html = render(<BleApp />);
      expect(html).toContain(lang === 'en' ? 'HX Bluetooth status' : 'HX 藍牙狀態');
      expect(html).toContain('Bluefy');
      expect(html).not.toContain(lang === 'en' ? 'HX Gateway Tool' : 'HX 閘道器工具'); // no serial bar
      expect(html).not.toContain(lang === 'en' ? 'Dashboard' : '儀表板'); // no Modbus tabs
      expect(html).not.toMatch(LEAKED_KEY);
    });
  }

  it('shows a connected snapshot in plain language', () => {
    localStorage.setItem('hx-lang', 'en');
    const status = decodeBleStatus(
      h('01 03 07 00 1F 00 01 00 02 00 00 00 01 00 03 00 92 FF 03 00 03 00 2A 00 00 00 10 0E 00 00 80 1F D7 6A'),
    );
    const id = new Uint8Array(124);
    id[0] = 1;
    id[1] = 1;
    id.set(new TextEncoder().encode('NTN-ADI01001'), 2);
    const ble: BleLink = {
      supported: true,
      phase: 'connected',
      deviceName: 'HX-NTN-ADI01001',
      status,
      statusAt: Date.now(),
      identity: decodeBleIdentity(id),
      notifying: true,
      error: null,
      canReconnect: true,
      connect: async () => {},
      disconnect: () => {},
      refresh: async () => {},
    };
    const html = render(<BlePanel ble={ble} />);
    expect(html).toContain('Online: satellite data can flow');
    expect(html).toContain('-110 dBm');
    expect(html).toContain('Good');
    expect(html).toContain('42 s ago');
    expect(html).toContain('Software reset');
    expect(html).toContain('01:00:00'); // uptime 3600 s
    expect(html).toContain('NTN-ADI01001');
    expect(html).not.toMatch(LEAKED_KEY);
  });
});
