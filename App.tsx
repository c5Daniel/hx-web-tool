import { useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConnectionBar } from './components/ConnectionBar';
import { LogViewer } from './components/LogViewer';
import { ConfigPanel } from './components/panels/ConfigPanel';
import { DashboardPanel } from './components/panels/DashboardPanel';
import { FactoryPanel } from './components/panels/FactoryPanel';
import { LinkPanel } from './components/panels/LinkPanel';
import { LoraPanel } from './components/panels/LoraPanel';
import { PassthroughPanel } from './components/panels/PassthroughPanel';
import { ToolsPanel } from './components/panels/ToolsPanel';
import { useGateway } from './hooks/useGateway';
import { MessageKey, useI18n } from './i18n';
import { Tab } from './types';
import { Dashboard } from './utils/ops/info';
import { isSerialSupported } from './utils/serialTransport';

const TABS: Tab[] = ['dashboard', 'link', 'config', 'lora', 'passthrough', 'factory', 'tools'];
const TAB_KEY = 'hx-tab';

function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY) as Tab | null;
    if (v && TABS.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return 'dashboard';
}

/** The Modbus tool (./). The Bluetooth status page is a page of its own at ./ble/ (BleApp.tsx). */
export default function App() {
  const { t } = useI18n();
  const gw = useGateway();
  const [tab, setTabState] = useState<Tab>(loadTab);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const supported = isSerialSupported();

  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <ConnectionBar gw={gw} />

        {!supported && (
          <div className="flex items-start gap-2 rounded-lg border border-red-700/60 bg-red-900/20 px-4 py-3 text-sm text-red-300">
            <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
            <div className="space-y-1">
              <p>{t('app.unsupported')}</p>
              {/* An old install of this page on a phone lands here: point it at the page it wanted. */}
              <p>
                {t('app.blePage')}{' '}
                <a href="ble/" className="underline text-red-200 hover:text-white">
                  {t('app.blePageLink')}
                </a>
              </p>
            </div>
          </div>
        )}

        <nav className="flex flex-wrap gap-2">
          {TABS.map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 min-w-[7rem] px-4 py-2 rounded-xl text-sm font-semibold transition-all border ${
                tab === id
                  ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-500/20'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200 hover:bg-slate-700'
              }`}
            >
              {t(`tab.${id}` as MessageKey)}
            </button>
          ))}
        </nav>

        <main>
          {tab === 'dashboard' && <DashboardPanel gw={gw} dashboard={dashboard} setDashboard={setDashboard} />}
          {tab === 'link' && <LinkPanel gw={gw} />}
          {tab === 'config' && <ConfigPanel gw={gw} />}
          {tab === 'lora' && <LoraPanel gw={gw} />}
          {tab === 'passthrough' && <PassthroughPanel gw={gw} />}
          {tab === 'factory' && <FactoryPanel gw={gw} />}
          {tab === 'tools' && <ToolsPanel gw={gw} imsi={dashboard?.ntn.imsi ?? ''} />}
        </main>

        <div className="h-80">
          <LogViewer logs={gw.logs} onClear={gw.clearLogs} />
        </div>
      </div>

      {gw.confirmReq && <ConfirmDialog request={gw.confirmReq} onAnswer={gw.answerConfirm} />}
    </div>
  );
}
