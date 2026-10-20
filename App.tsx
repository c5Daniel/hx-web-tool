import { useEffect, useState } from 'react';
import { CommandLineIcon, ExclamationTriangleIcon, SignalIcon } from '@heroicons/react/24/outline';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConnectionBar } from './components/ConnectionBar';
import { LogViewer } from './components/LogViewer';
import { BlePanel } from './components/panels/BlePanel';
import { ConfigPanel } from './components/panels/ConfigPanel';
import { DashboardPanel } from './components/panels/DashboardPanel';
import { FactoryPanel } from './components/panels/FactoryPanel';
import { LinkPanel } from './components/panels/LinkPanel';
import { LoraPanel } from './components/panels/LoraPanel';
import { PassthroughPanel } from './components/panels/PassthroughPanel';
import { ToolsPanel } from './components/panels/ToolsPanel';
import { useBleStatus } from './hooks/useBleStatus';
import { useGateway } from './hooks/useGateway';
import { MessageKey, useI18n } from './i18n';
import { AppMode, Tab } from './types';
import { Dashboard } from './utils/ops/info';
import { isSerialSupported } from './utils/serialTransport';

const TABS: Tab[] = ['dashboard', 'link', 'config', 'lora', 'passthrough', 'factory', 'tools'];
const TAB_KEY = 'hx-tab';
const MODES: AppMode[] = ['serial', 'ble'];
const MODE_KEY = 'hx-mode';
const MODE_ICON = { serial: CommandLineIcon, ble: SignalIcon } as const;

function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY) as Tab | null;
    if (v && TABS.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return 'dashboard';
}

/** `#ble` / `#serial` in the URL; the device label's QR code points at `#ble`. */
function modeFromHash(): AppMode | null {
  const h = window.location.hash.replace(/^#/, '').toLowerCase();
  return MODES.includes(h as AppMode) ? (h as AppMode) : null;
}

function loadMode(): AppMode {
  const fromHash = modeFromHash();
  if (fromHash) return fromHash;
  try {
    const v = localStorage.getItem(MODE_KEY) as AppMode | null;
    if (v && MODES.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return 'serial';
}

export default function App() {
  const { t } = useI18n();
  const gw = useGateway();
  // Lives here, not in the page, so switching modes does not drop the BLE link.
  const ble = useBleStatus();
  const [mode, setModeState] = useState<AppMode>(loadMode);
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

  const setMode = (next: AppMode) => {
    setModeState(next);
    try {
      const url = `${window.location.pathname}${window.location.search}${next === 'ble' ? '#ble' : ''}`;
      window.history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
  };

  // Remembered also when it came from `#ble`, so an installed app (start_url ./) reopens where the QR code led.
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  useEffect(() => {
    const onHash = () => {
      const m = modeFromHash();
      if (m) setModeState(m);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <nav className="grid grid-cols-2 gap-1 p-1 rounded-2xl border border-slate-700 bg-slate-800/50">
          {MODES.map((id) => {
            const Icon = MODE_ICON[id];
            return (
              <button
                key={id}
                onClick={() => setMode(id)}
                className={`inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                  mode === id ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
                }`}
              >
                <Icon className="w-5 h-5" />
                {t(`mode.${id}` as MessageKey)}
              </button>
            );
          })}
        </nav>

        {mode === 'ble' ? (
          <BlePanel ble={ble} />
        ) : (
          <>
            <ConnectionBar gw={gw} />

            {!supported && (
              <div className="flex items-center gap-2 rounded-lg border border-red-700/60 bg-red-900/20 px-4 py-3 text-sm text-red-300">
                <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
                {t('app.unsupported')}
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
          </>
        )}
      </div>

      {gw.confirmReq && <ConfirmDialog request={gw.confirmReq} onAnswer={gw.answerConfirm} />}
    </div>
  );
}
