// The Bluetooth status page: what the firmware's read-only BLE service
// reports, in plain language, laid out for a phone in the field. No serial
// port involved; it runs on useBleStatus alone.

import React, { useEffect, useState } from 'react';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  LanguageIcon,
  LinkIcon,
  LinkSlashIcon,
  SignalIcon,
} from '@heroicons/react/24/outline';
import { BLE_POLL_S, BleLink } from '../../hooks/useBleStatus';
import { BLE_CSQ_GRADES } from '../../utils/bleStatus';
import { MessageKey, Translate, useI18n } from '../../i18n';
import { hex4 } from '../../utils/modbusRtu';
import {
  ACTMODE_MODES,
  LINK_ONLINE,
  LINK_STATUS_BITS,
  PCIE_STATUS_LORA_READY,
  WORKMODE_MODBUS,
  WORKMODE_PT_LORA,
  WORKMODE_PT_NTN,
} from '../../utils/registers';
import { DashboardCard } from '../DashboardCard';
import { Button, KV, Pill, Result } from '../controls';
import { formatResetCause } from '../format';

const WORKMODES: readonly number[] = [WORKMODE_MODBUS, WORKMODE_PT_NTN, WORKMODE_PT_LORA];

/** Date.now(), ticking once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function formatAgo(s: number, t: Translate): string {
  if (s < 120) return t('ble.ago.s', { n: s });
  if (s < 7200) return t('ble.ago.m', { n: Math.floor(s / 60) });
  return t('ble.ago.h', { n: Math.floor(s / 3600) });
}

function formatUptime(s: number, t: Translate): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = Math.floor(s / 86400);
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? t('ble.uptimeDays', { d, hms }) : hms;
}

const Unsupported: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-red-700/60 bg-red-900/20 px-4 py-3 text-sm text-red-300 space-y-2">
      <div className="flex items-center gap-2 font-semibold">
        <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
        {t('ble.unsupported')}
      </div>
      <ul className="list-disc pl-6 space-y-1 text-red-200/90">
        <li>{t('ble.unsupported.ios')}</li>
        <li>{t('ble.unsupported.other')}</li>
        <li>{t('ble.unsupported.https')}</li>
      </ul>
    </div>
  );
};

export const BlePanel: React.FC<{ ble: BleLink }> = ({ ble }) => {
  const { t, lang, setLang } = useI18n();
  const connected = ble.phase === 'connected';
  const working = ble.phase !== 'idle' && !connected;
  const now = useNow(connected);
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;

  // Values move between reads (uptime, clock, CSQ age); count on from the last read while connected.
  const elapsed = connected && ble.statusAt ? Math.max(0, Math.floor((now - ble.statusAt) / 1000)) : 0;
  const s = ble.status;
  const id = ble.identity;

  const missing = s ? LINK_STATUS_BITS.find((bit) => (s.linkStatus & (1 << bit)) === 0) : undefined;
  const online = !!s && s.linkStatus === LINK_ONLINE;
  const csqShown = !!s && s.csqValid;

  const phasePill = (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
        connected
          ? 'bg-green-900/40 text-green-300 border-green-700/60'
          : working
            ? 'bg-blue-900/40 text-blue-300 border-blue-700/60'
            : 'bg-slate-800 text-slate-400 border-slate-700'
      }`}
    >
      {working && <span className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />}
      {t(`ble.phase.${ble.phase}` as MessageKey)}
    </span>
  );

  return (
    <div className="space-y-4">
      <div className="bg-slate-800/50 p-4 sm:p-5 rounded-2xl border border-slate-700 backdrop-blur-sm space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 bg-blue-600/20 rounded-xl border border-blue-500/30 shrink-0">
              <SignalIcon className="w-7 h-7 text-blue-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-white">{t('ble.title')}</h1>
              <p className="text-xs text-slate-400">{t('ble.subtitle')}</p>
            </div>
          </div>
          <Button variant="ghost" onClick={() => setLang(lang === 'en' ? 'zh-TW' : 'en')} className="inline-flex items-center gap-1 shrink-0">
            <LanguageIcon className="w-4 h-4" />
            {t('lang.switch')}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {phasePill}
          {ble.deviceName && <span className="font-mono text-sm text-slate-300 break-all">{ble.deviceName}</span>}
        </div>

        {!ble.supported ? (
          <Unsupported />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {connected || working ? (
              <Button variant="secondary" className="py-3 text-base inline-flex justify-center items-center gap-2" onClick={ble.disconnect}>
                <LinkSlashIcon className="w-5 h-5" />
                {t('ble.disconnect')}
              </Button>
            ) : (
              <Button className="py-3 text-base inline-flex justify-center items-center gap-2" onClick={() => void ble.connect(false)}>
                <LinkIcon className="w-5 h-5" />
                {t('ble.connect')}
              </Button>
            )}
            {connected ? (
              <Button variant="ghost" className="py-3 text-base inline-flex justify-center items-center gap-2" onClick={() => void ble.refresh(true)}>
                <ArrowPathIcon className="w-5 h-5" />
                {t('ble.refresh')}
              </Button>
            ) : (
              ble.canReconnect &&
              !working && (
                <Button variant="secondary" className="py-3 text-base inline-flex justify-center items-center gap-2" onClick={() => void ble.connect(true)}>
                  <ArrowPathIcon className="w-5 h-5" />
                  {t('ble.reconnect')}
                </Button>
              )
            )}
          </div>
        )}

        {ble.supported && insecure && <Result tone="warn">{t('ble.insecure')}</Result>}

        {ble.phase === 'pairing' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-300">
            <InformationCircleIcon className="w-5 h-5 shrink-0" />
            {t('ble.pair.waiting')}
          </div>
        )}

        {ble.error && (
          <Result tone={ble.error.kind === 'cancelled' ? 'info' : 'error'}>
            {t(`ble.err.${ble.error.kind}` as MessageKey)}
            <span className="block mt-1 font-mono text-xs opacity-70">{t('ble.err.detail', { d: ble.error.detail })}</span>
          </Result>
        )}

        {ble.supported && !connected && (
          <div className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
            <span className="block font-semibold text-slate-200 mb-1">{t('ble.pair.title')}</span>
            {t('ble.pair.body')}
          </div>
        )}
      </div>

      {!s ? (
        <p className="text-center text-sm text-slate-500 py-6">{t('ble.empty')}</p>
      ) : (
        <>
          <DashboardCard
            title={t('ble.link')}
            accent="cyan"
            actions={<Pill on={online}>{online ? t('dash.online') : t('dash.offline')}</Pill>}
          >
            <p className={`text-base font-semibold mb-3 ${online ? 'text-green-300' : 'text-amber-300'}`}>
              {online || missing === undefined
                ? t('ble.stage.online')
                : t('ble.stage.waiting', { step: t(`link.bit${missing}` as MessageKey) })}
            </p>
            <ol className="space-y-1.5">
              {LINK_STATUS_BITS.map((bit) => {
                const on = (s.linkStatus & (1 << bit)) !== 0;
                return (
                  <li key={bit} className={`flex items-center gap-2 text-sm ${on ? 'text-slate-100' : 'text-slate-500'}`}>
                    {on ? (
                      <CheckCircleIcon className="w-5 h-5 text-green-400 shrink-0" />
                    ) : (
                      <span className="w-5 h-5 shrink-0 flex items-center justify-center">
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-600" />
                      </span>
                    )}
                    {t(`link.bit${bit}` as MessageKey)}
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 text-right font-mono text-xs text-slate-500">0x{hex4(s.linkStatus)}</p>
          </DashboardCard>

          <div className="grid md:grid-cols-2 gap-4">
            <DashboardCard title={t('ble.signal')} accent="green">
              <KV label={t('field.rsrp')} value={csqShown ? `${s.rsrp} dBm` : '—'} />
              <KV label={t('field.sinr')} value={csqShown ? `${s.sinr} dB` : '—'} />
              <KV
                label={t('field.grade')}
                value={
                  !csqShown
                    ? '—'
                    : (BLE_CSQ_GRADES as readonly number[]).includes(s.grade)
                      ? t(`ble.grade.${s.grade}` as MessageKey)
                      : t('ble.unknown', { v: s.grade })
                }
                mono={false}
              />
              <KV
                label={t('ble.reading')}
                value={csqShown && s.csqAgeS !== null ? formatAgo(s.csqAgeS + elapsed, t) : t('ble.noReading')}
                mono={false}
              />
            </DashboardCard>

            <DashboardCard title={t('ble.state')} accent="blue">
              <KV
                label={t('field.uplinkChannel')}
                value={<Pill on={s.uplinkStatus === 0}>{s.uplinkStatus === 0 ? t('val.free') : t('val.busy')}</Pill>}
              />
              <KV
                label={t('ble.workmode')}
                value={WORKMODES.includes(s.workmode) ? t(`wm.${s.workmode}` as MessageKey) : t('ble.unknown', { v: s.workmode })}
                mono={false}
              />
              <KV
                label={t('ble.actmode')}
                value={
                  (ACTMODE_MODES as readonly number[]).includes(s.actmode)
                    ? t(`act.mode${s.actmode}` as MessageKey)
                    : t('ble.unknown', { v: s.actmode })
                }
                mono={false}
              />
              <KV
                label={t('field.loraReady')}
                value={
                  <Pill on={(s.pcieStatus & PCIE_STATUS_LORA_READY) !== 0}>
                    {s.pcieStatus & PCIE_STATUS_LORA_READY ? t('val.ready') : t('val.notReady')}
                  </Pill>
                }
              />
              <KV label={t('field.resetCause')} value={formatResetCause(s.resetCause, t)} mono={false} />
              <KV label={t('ble.uptime')} value={formatUptime(s.uptimeS + elapsed, t)} />
              <KV
                label={t('ble.moduleTime')}
                value={s.moduleTimeS !== null ? new Date((s.moduleTimeS + elapsed) * 1000).toLocaleString() : t('ble.notSynced')}
                mono={s.moduleTimeS !== null}
              />
            </DashboardCard>
          </div>

          <DashboardCard title={t('ble.identity')} accent="purple">
            <div className="grid md:grid-cols-2 md:gap-x-6">
              <div>
                <KV label={t('field.sn')} value={id?.sn || '—'} />
                <KV label={t('field.model')} value={id?.model || '—'} />
                <KV label={t('field.sku')} value={id?.sku || '—'} />
                <KV label={t('field.fw')} value={id?.fwVersion || '—'} />
                <KV label={t('field.hw')} value={id?.hwVersion || '—'} />
              </div>
              <div>
                <KV label={t('field.modbusId')} value={id ? id.modbusId : '—'} />
                <KV label={t('field.imsi')} value={id?.imsi || '—'} />
                <KV label={t('field.swVersion')} value={id?.moduleSwVersion || '—'} />
                <KV label={t('field.lat')} value={id?.latitude || '—'} />
                <KV label={t('field.lon')} value={id?.longitude || '—'} />
              </div>
            </div>
          </DashboardCard>

          <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-slate-500">
            {ble.statusAt && <span>{t('ble.updated', { t: new Date(ble.statusAt).toLocaleTimeString() })}</span>}
            <span>{t('ble.counter', { n: s.counter })}</span>
            {connected && <span>{ble.notifying ? t('ble.notify.on') : t('ble.notify.off', { s: BLE_POLL_S })}</span>}
          </p>
        </>
      )}
    </div>
  );
};
