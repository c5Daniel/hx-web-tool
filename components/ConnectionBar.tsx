import React, { useEffect, useState } from 'react';
import { CpuChipIcon, LanguageIcon, LinkIcon, LinkSlashIcon, StopIcon } from '@heroicons/react/24/outline';
import { Gateway } from '../hooks/useGateway';
import { useI18n } from '../i18n';
import { parsePasswordHex } from '../utils/ntnCodec';
import { engmode } from '../utils/ops/config';
import { login } from '../utils/ops/context';
import { BAUD_RATES, ENGMODE_VALID_MS, MODBUS_ID_MAX, MODBUS_ID_MIN } from '../utils/registers';
import { DriverMode } from '../utils/serialTransport';
import { Button, Field, Select, TextInput } from './controls';

/** Seconds of engineering mode left, ticking once a second. */
function useEngmodeLeft(engmodeAt: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (engmodeAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [engmodeAt]);
  if (engmodeAt === null) return 0;
  return Math.max(0, Math.round((engmodeAt + ENGMODE_VALID_MS - now) / 1000));
}

export const ConnectionBar: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const { t, lang, setLang } = useI18n();
  const engLeft = useEngmodeLeft(gw.engmodeAt);
  const [unitText, setUnitText] = useState(String(gw.settings.unit));

  useEffect(() => setUnitText(String(gw.settings.unit)), [gw.settings.unit]);

  let pwdError: string | null = null;
  try {
    parsePasswordHex(gw.passwordHex);
  } catch (e) {
    pwdError = (e as Error).message;
  }

  const commitUnit = (text: string) => {
    setUnitText(text);
    const n = Number(text);
    if (Number.isInteger(n) && n >= MODBUS_ID_MIN && n <= MODBUS_ID_MAX) gw.setSettings({ unit: n });
  };

  return (
    <div className="bg-slate-800/50 p-5 rounded-2xl border border-slate-700 backdrop-blur-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-600/20 rounded-xl border border-blue-500/30">
            <CpuChipIcon className="w-7 h-7 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">{t('app.title')}</h1>
            <p className="text-xs text-slate-400">{t('app.subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
              gw.connected ? 'bg-green-900/40 text-green-300 border-green-700/60' : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
          >
            {gw.connected ? t('conn.connected') : t('conn.disconnected')}
          </span>
          {gw.connected && (
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                gw.unlocked ? 'bg-blue-900/40 text-blue-300 border-blue-700/60' : 'bg-slate-800 text-slate-500 border-slate-700'
              }`}
            >
              {gw.unlocked ? t('conn.unlocked') : t('conn.locked')}
            </span>
          )}
          {engLeft > 0 && (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold border bg-amber-900/40 text-amber-300 border-amber-700/60">
              {t('conn.engmodeLeft', { s: engLeft })}
            </span>
          )}
          <Button variant="ghost" onClick={() => setLang(lang === 'en' ? 'zh-TW' : 'en')} className="inline-flex items-center gap-1">
            <LanguageIcon className="w-4 h-4" />
            {t('lang.switch')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
        <Field label={t('conn.driver')}>
          <Select
            value={gw.settings.driver}
            disabled={gw.connected}
            onChange={(e) => gw.setSettings({ driver: e.target.value as DriverMode })}
          >
            <option value={DriverMode.AUTO}>{t('conn.driver.auto')}</option>
            <option value={DriverMode.NATIVE}>{t('conn.driver.native')}</option>
            <option value={DriverMode.POLYFILL}>{t('conn.driver.polyfill')}</option>
          </Select>
        </Field>
        <Field label={t('conn.baud')}>
          <Select value={gw.settings.baud} disabled={gw.connected} onChange={(e) => gw.setSettings({ baud: Number(e.target.value) })}>
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('conn.unit')}>
          <TextInput type="number" min={MODBUS_ID_MIN} max={MODBUS_ID_MAX} value={unitText} onChange={(e) => commitUnit(e.target.value)} />
        </Field>
        <Field label={t('conn.timeout')}>
          <TextInput
            type="number"
            min={100}
            step={100}
            value={gw.settings.timeoutMs}
            onChange={(e) => gw.setSettings({ timeoutMs: Math.max(100, Number(e.target.value) || 1000) })}
          />
        </Field>
        <Field label={t('conn.password')} error={pwdError} className="col-span-2 md:col-span-1">
          <TextInput value={gw.passwordHex} onChange={(e) => gw.setPassword(e.target.value)} spellCheck={false} />
        </Field>
        <div className="col-span-2 md:col-span-1 flex gap-2">
          {gw.connected ? (
            <Button variant="secondary" className="flex-1 inline-flex justify-center items-center gap-1" onClick={() => void gw.disconnect()}>
              <LinkSlashIcon className="w-4 h-4" />
              {t('conn.disconnect')}
            </Button>
          ) : (
            <Button
              className="flex-1 inline-flex justify-center items-center gap-1"
              disabled={gw.connecting}
              onClick={() => void gw.connect()}
            >
              <LinkIcon className="w-4 h-4" />
              {gw.connecting ? t('conn.connecting') : t('conn.connect')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={!gw.connected || !!gw.busy} onClick={() => void gw.run(t('conn.login'), (ctx) => login(ctx))}>
          {t('conn.login')}
        </Button>
        <Button variant="secondary" disabled={!gw.connected || !!gw.busy} onClick={() => void gw.run(t('conn.engmode'), engmode)}>
          {t('conn.engmode')}
        </Button>
        {gw.busy && (
          <span className="inline-flex items-center gap-2 text-sm text-blue-300">
            <span className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            {t('conn.busy', { label: gw.busy })}
            <Button variant="ghost" className="inline-flex items-center gap-1" onClick={gw.cancel}>
              <StopIcon className="w-4 h-4" />
              {t('conn.cancel')}
            </Button>
          </span>
        )}
        {!gw.connected && <span className="text-xs text-slate-500">{t('conn.hint')}</span>}
      </div>

      {gw.passthrough && (
        <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-300">
          {t('conn.ptActive', { target: gw.passthrough === 'lora' ? 'LoRa' : 'NTN' })}
        </div>
      )}
    </div>
  );
};
