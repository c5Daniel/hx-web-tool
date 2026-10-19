import React, { useState } from 'react';
import { Gateway } from '../../hooks/useGateway';
import { MessageKey, useI18n } from '../../i18n';
import {
  Actmode,
  Bauds,
  Netcfg,
  parseIntervalArg,
  readActmode,
  readBauds,
  readNetcfg,
  setBauds,
  setDebugConsole,
  setPassword,
  validateNetcfgValue,
  verifyActmodeRejects,
  writeActmode,
  writeNetcfg,
} from '../../utils/ops/config';
import { parsePasswordHex } from '../../utils/ntnCodec';
import { ACTMODE_IVL_DISABLED, ACTMODE_MODES, BAUD_RATES, BaudPort, NETCFG_FIELDS, NetcfgKey } from '../../utils/registers';
import { DashboardCard } from '../DashboardCard';
import { Button, Checkbox, Field, Hint, Select, TextInput } from '../controls';
import { failure, Outcome, OutcomeView } from './outcome';

const EMPTY_NETCFG: Netcfg = { remote_port: '', apn: '', remote_ip: '', pdp_type: '', local_port: '' };

function intervalText(v: number): string {
  return v === ACTMODE_IVL_DISABLED ? 'off' : String(v);
}

// ---- UDP network config --------------------------------------------------------------

const NetcfgCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<Netcfg | null>(null);
  const [form, setForm] = useState<Netcfg>(EMPTY_NETCFG);
  const [resetAfter, setResetAfter] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const changed = NETCFG_FIELDS.filter((f) => form[f.key] !== (loaded?.[f.key] ?? ''));
  const errors: Partial<Record<NetcfgKey, string | null>> = {};
  for (const f of changed) errors[f.key] = validateNetcfgValue(f.kind, form[f.key], f.words * 2);
  const valid = changed.every((f) => !errors[f.key]);

  const load = (v: Netcfg) => {
    setLoaded(v);
    setForm(v);
  };

  const doRead = async () => {
    const r = await gw.run(t('net.title'), readNetcfg);
    if (r.ok) {
      load(r.value);
      setOutcome(null);
    } else setOutcome(failure(r, t));
  };

  const doWrite = async () => {
    if (!changed.length) return setOutcome({ tone: 'info', text: t('net.nochange') });
    const values: Partial<Netcfg> = {};
    for (const f of changed) values[f.key] = form[f.key];
    const r = await gw.run(t('net.title'), (ctx) => writeNetcfg(ctx, values, resetAfter));
    if (!r.ok) return setOutcome(failure(r, t));
    load(r.value.values);
    setOutcome(
      r.value.mismatches.length
        ? { tone: 'error', text: `${t('common.mismatch')}\n${r.value.mismatches.join('\n')}` }
        : { tone: 'ok', text: `${t('common.verified')}: ${changed.map((f) => t(`net.${f.key}` as MessageKey)).join(', ')}` },
    );
  };

  return (
    <DashboardCard title={t('net.title')} accent="blue">
      <div className="grid sm:grid-cols-2 gap-3">
        {NETCFG_FIELDS.map((f) => (
          <Field key={f.key} label={t(`net.${f.key}` as MessageKey)} error={errors[f.key]}>
            {f.kind === 'pdp' ? (
              <Select value={form.pdp_type} onChange={(e) => setForm({ ...form, pdp_type: e.target.value })}>
                {!form.pdp_type && <option value="">—</option>}
                <option value="IP">IP</option>
                <option value="Non-IP">Non-IP</option>
              </Select>
            ) : (
              <TextInput
                value={form[f.key]}
                maxLength={f.words * 2}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className={loaded && form[f.key] !== loaded[f.key] ? 'border-amber-500' : ''}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void doRead()} disabled={!idle}>
          {t('common.read')}
        </Button>
        <Button onClick={() => void doWrite()} disabled={!idle || !valid || !changed.length}>
          {t('common.write')}
        </Button>
        <Checkbox label={t('net.resetAfter')} checked={resetAfter} onChange={setResetAfter} />
      </div>
      <OutcomeView outcome={outcome} />
      <Hint>{t('net.hint')}</Hint>
    </DashboardCard>
  );
};

// ---- active mode ---------------------------------------------------------------------------

const ActmodeCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [state, setState] = useState<Actmode | null>(null);
  const [mode, setMode] = useState('');
  const [csq, setCsq] = useState('');
  const [lora, setLora] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const parse = (text: string): { v?: number; err: string | null } => {
    if (text.trim() === '') return { err: null };
    try {
      return { v: parseIntervalArg(text), err: null };
    } catch (e) {
      return { err: (e as Error).message };
    }
  };
  const csqP = parse(csq);
  const loraP = parse(lora);

  const show = (s: Actmode) => {
    setState(s);
    setMode(String(s.mode));
    setCsq(intervalText(s.csq));
    setLora(intervalText(s.lora));
  };

  const doRead = async () => {
    const r = await gw.run(t('act.title'), readActmode);
    if (r.ok) {
      show(r.value);
      setOutcome(null);
    } else setOutcome(failure(r, t));
  };

  const doWrite = async () => {
    const want: { mode?: number; csq?: number; lora?: number } = {};
    if (mode !== '' && (!state || Number(mode) !== state.mode)) want.mode = Number(mode);
    if (csqP.v !== undefined && (!state || csqP.v !== state.csq)) want.csq = csqP.v;
    if (loraP.v !== undefined && (!state || loraP.v !== state.lora)) want.lora = loraP.v;
    const r = await gw.run(t('act.title'), (ctx) => writeActmode(ctx, want));
    if (!r.ok) return setOutcome(failure(r, t));
    show(r.value.state);
    setOutcome(
      r.value.mismatches.length
        ? { tone: 'error', text: `${t('common.mismatch')}\n${r.value.mismatches.join('\n')}` }
        : { tone: 'ok', text: t('common.verified') },
    );
  };

  const doVerify = async () => {
    const r = await gw.run(t('act.verifyReject'), verifyActmodeRejects);
    if (!r.ok) return setOutcome(failure(r, t));
    const lines = r.value.map(
      (c) => `${c.ok ? '✔' : '✘'} ${c.label}: ${c.got === 'accepted' ? 'ACCEPTED' : `0x${c.got.toString(16).padStart(2, '0')}`} (want 0x${c.want.toString(16).padStart(2, '0')})`,
    );
    setOutcome({ tone: r.value.every((c) => c.ok) ? 'ok' : 'error', text: lines.join('\n') });
  };

  return (
    <DashboardCard title={t('act.title')} accent="green">
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={t('act.mode')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {mode === '' && <option value="">—</option>}
            {ACTMODE_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`act.mode${m}` as MessageKey)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('act.csq')} hint={t('act.ivlHint')} error={csqP.err}>
          <TextInput value={csq} onChange={(e) => setCsq(e.target.value)} />
        </Field>
        <Field label={t('act.lora')} hint={t('act.ivlHint')} error={loraP.err}>
          <TextInput value={lora} onChange={(e) => setLora(e.target.value)} />
        </Field>
      </div>
      {state && (
        <p className="mt-2 text-xs text-slate-400">
          {t('act.workmode')}: {state.workmode} — {t(`wm.${state.workmode}` as MessageKey)}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => void doRead()} disabled={!idle}>
          {t('common.read')}
        </Button>
        <Button onClick={() => void doWrite()} disabled={!idle || !!csqP.err || !!loraP.err || mode === ''}>
          {t('common.write')}
        </Button>
        <Button variant="ghost" onClick={() => void doVerify()} disabled={!idle}>
          {t('act.verifyReject')}
        </Button>
      </div>
      <OutcomeView outcome={outcome} mono />
    </DashboardCard>
  );
};

// ---- UART baud -------------------------------------------------------------------------------

const BaudCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [current, setCurrent] = useState<Bauds | null>(null);
  const [want, setWant] = useState<Record<BaudPort, string>>({ host: '', ntn: '', lora: '' });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const ports: BaudPort[] = ['host', 'ntn', 'lora'];

  const doRead = async () => {
    const r = await gw.run(t('baud.title'), readBauds);
    if (r.ok) {
      setCurrent(r.value);
      setOutcome(null);
    } else setOutcome(failure(r, t));
  };

  const doWrite = async () => {
    const req: Partial<Bauds> = {};
    for (const p of ports) if (want[p]) req[p] = Number(want[p]);
    const r = await gw.run(t('baud.title'), (ctx) => setBauds(ctx, req));
    if (!r.ok) return setOutcome(failure(r, t));
    setCurrent(r.value.bauds);
    setWant({ host: '', ntn: '', lora: '' });
    setOutcome(
      r.value.mismatches.length
        ? { tone: 'error', text: r.value.mismatches.join('\n') }
        : { tone: 'ok', text: ports.map((p) => `${p}: ${r.value.bauds[p]}`).join('   ') },
    );
  };

  return (
    <DashboardCard title={t('baud.title')} accent="amber">
      <div className="grid sm:grid-cols-3 gap-3">
        {ports.map((p) => (
          <Field key={p} label={t(`baud.${p}` as MessageKey)} hint={current ? String(current[p]) : undefined}>
            <Select value={want[p]} onChange={(e) => setWant({ ...want, [p]: e.target.value })}>
              <option value="">{t('baud.keep')}</option>
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      <div className="mt-3 flex gap-3">
        <Button variant="secondary" onClick={() => void doRead()} disabled={!idle}>
          {t('common.read')}
        </Button>
        <Button onClick={() => void doWrite()} disabled={!idle || ports.every((p) => !want[p])}>
          {t('common.apply')}
        </Button>
      </div>
      <OutcomeView outcome={outcome} mono />
      <Hint>{t('baud.hint')}</Hint>
    </DashboardCard>
  );
};

// ---- debug console + password ------------------------------------------------------------------

const DebugConsoleCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const set = async (on: boolean) => {
    const r = await gw.run(t('dbg.title'), (ctx) => setDebugConsole(ctx, on));
    setOutcome(r.ok ? { tone: 'ok', text: on ? t('dbg.on') : t('dbg.off') } : failure(r, t));
  };
  return (
    <DashboardCard title={t('dbg.title')} accent="purple">
      <div className="flex gap-3">
        <Button onClick={() => void set(true)} disabled={!idle}>
          {t('dbg.on')}
        </Button>
        <Button variant="secondary" onClick={() => void set(false)} disabled={!idle}>
          {t('dbg.off')}
        </Button>
      </div>
      <OutcomeView outcome={outcome} />
      <Hint>{t('dbg.hint')}</Hint>
    </DashboardCard>
  );
};

const PasswordCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  let err: string | null = null;
  if (next) {
    try {
      parsePasswordHex(next);
    } catch (e) {
      err = (e as Error).message;
    }
  }
  const differs = repeat !== '' && repeat.replace(/\s+/g, '') !== next.replace(/\s+/g, '');

  const doChange = async () => {
    const r = await gw.run(t('pwd.title'), (ctx) => setPassword(ctx, next));
    if (r.ok) {
      setOutcome({ tone: 'ok', text: t('common.done') });
      setNext('');
      setRepeat('');
    } else setOutcome(failure(r, t));
  };

  return (
    <DashboardCard title={t('pwd.title')} accent="red">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label={t('pwd.new')} error={err}>
          <TextInput value={next} onChange={(e) => setNext(e.target.value)} spellCheck={false} />
        </Field>
        <Field label={t('pwd.repeat')} error={differs ? t('pwd.mismatch') : null}>
          <TextInput value={repeat} onChange={(e) => setRepeat(e.target.value)} spellCheck={false} />
        </Field>
      </div>
      <Button className="mt-3" variant="danger" onClick={() => void doChange()} disabled={!idle || !next || !!err || differs || !repeat}>
        {t('pwd.change')}
      </Button>
      <OutcomeView outcome={outcome} />
      <Hint>{t('pwd.hint')}</Hint>
    </DashboardCard>
  );
};

export const ConfigPanel: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const idle = gw.connected && !gw.busy;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <NetcfgCard gw={gw} idle={idle} />
      <ActmodeCard gw={gw} idle={idle} />
      <BaudCard gw={gw} idle={idle} />
      <div className="space-y-4">
        <DebugConsoleCard gw={gw} idle={idle} />
        <PasswordCard gw={gw} idle={idle} />
      </div>
    </div>
  );
};
