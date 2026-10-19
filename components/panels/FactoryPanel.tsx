import React, { useState } from 'react';
import { Gateway } from '../../hooks/useGateway';
import { useI18n } from '../../i18n';
import { assignId, factoryReset, provision, resetMcu, setId } from '../../utils/ops/factory';
import { IdentityKey, MODBUS_ID_MAX, MODBUS_ID_MIN } from '../../utils/registers';
import { DashboardCard } from '../DashboardCard';
import { Button, Checkbox, Field, Hint, Select, TextInput } from '../controls';
import { failure, Outcome, OutcomeView } from './outcome';

const validId = (n: number) => Number.isInteger(n) && n >= MODBUS_ID_MIN && n <= MODBUS_ID_MAX;

const ProvisionCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [form, setForm] = useState<Record<IdentityKey, string>>({ sn: '', model: '', sku: '' });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [record, setRecord] = useState<string | null>(null);
  const filled = (Object.keys(form) as IdentityKey[]).filter((k) => form[k] !== '');

  const doRun = async () => {
    const values: Partial<Record<IdentityKey, string>> = {};
    for (const k of filled) values[k] = form[k];
    const r = await gw.run(t('fac.prov.title'), (ctx) => provision(ctx, values));
    if (!r.ok) {
      setRecord(null);
      return setOutcome(failure(r, t));
    }
    setRecord(r.value.record);
    setOutcome(r.value.ok ? { tone: 'ok', text: t('common.verified') } : { tone: 'error', text: r.value.mismatches.join('\n') });
  };

  return (
    <DashboardCard title={t('fac.prov.title')} accent="blue">
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={t('fac.prov.sn')}>
          <TextInput maxLength={12} value={form.sn} onChange={(e) => setForm({ ...form, sn: e.target.value })} />
        </Field>
        <Field label={t('fac.prov.model')}>
          <TextInput maxLength={10} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </Field>
        <Field label={t('fac.prov.sku')}>
          <TextInput maxLength={20} value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
        </Field>
      </div>
      <Button className="mt-3" onClick={() => void doRun()} disabled={!idle || !filled.length}>
        {t('fac.prov.run')}
      </Button>
      <OutcomeView outcome={outcome} />
      {record && (
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded px-2 py-1.5 break-all">{record}</code>
          <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(record)}>
            {t('common.copy')}
          </Button>
        </div>
      )}
      <Hint>{t('fac.prov.hint')}</Hint>
    </DashboardCard>
  );
};

const SetIdCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [newId, setNewId] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const id = Number(newId);

  const doRun = async () => {
    const r = await gw.run(t('fac.setid.title'), (ctx) => setId(ctx, id));
    setOutcome(r.ok ? { tone: 'ok', text: t('fac.setid.done', { id }) } : failure(r, t));
  };

  return (
    <DashboardCard title={t('fac.setid.title')} accent="cyan">
      <div className="flex items-end gap-3">
        <Field label={t('fac.setid.new')} className="w-36">
          <TextInput type="number" min={MODBUS_ID_MIN} max={MODBUS_ID_MAX} value={newId} onChange={(e) => setNewId(e.target.value)} />
        </Field>
        <Button onClick={() => void doRun()} disabled={!idle || !validId(id)}>
          {t('fac.setid.run')}
        </Button>
      </div>
      <OutcomeView outcome={outcome} />
    </DashboardCard>
  );
};

const AssignIdCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [mode, setMode] = useState<'sn' | 'imsi'>('imsi');
  const [value, setValue] = useState('');
  const [newId, setNewId] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const id = Number(newId);
  const valueOk = mode === 'sn' ? /^[\x20-\x7e]{1,12}$/.test(value) : /^\d{15}$/.test(value);

  const doRun = async () => {
    const r = await gw.run(t('fac.assign.title'), (ctx) => assignId(ctx, mode, value, id));
    if (!r.ok) return setOutcome(failure(r, t));
    setOutcome({ tone: 'ok', text: t(r.value === 'already' ? 'fac.assign.already' : 'fac.assign.assigned', { id }) });
  };

  return (
    <DashboardCard title={t('fac.assign.title')} accent="purple">
      <div className="grid sm:grid-cols-4 gap-3 items-end">
        <Field label={t('fac.assign.by')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'sn' | 'imsi')}>
            <option value="imsi">IMSI</option>
            <option value="sn">SN</option>
          </Select>
        </Field>
        <Field label={t('fac.assign.value')} className="sm:col-span-2">
          <TextInput value={value} maxLength={mode === 'sn' ? 12 : 15} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label={t('fac.assign.newId')}>
          <TextInput type="number" min={MODBUS_ID_MIN} max={MODBUS_ID_MAX} value={newId} onChange={(e) => setNewId(e.target.value)} />
        </Field>
      </div>
      <Button className="mt-3" onClick={() => void doRun()} disabled={!idle || !valueOk || !validId(id)}>
        {t('fac.assign.run')}
      </Button>
      <OutcomeView outcome={outcome} />
      <Hint>{t('fac.assign.hint')}</Hint>
    </DashboardCard>
  );
};

const ResetCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [waitS, setWaitS] = useState(3);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const doRun = async () => {
    const r = await gw.run(t('fac.reset.title'), (ctx) => resetMcu(ctx, waitS));
    setOutcome(r.ok ? { tone: 'ok', text: t('fac.reset.back', { v: r.value ?? '?' }) } : failure(r, t));
  };

  return (
    <DashboardCard title={t('fac.reset.title')} accent="amber">
      <div className="flex items-end gap-3">
        <Field label={t('fac.reset.wait')} className="w-28">
          <TextInput type="number" min={1} value={waitS} onChange={(e) => setWaitS(Math.max(1, Number(e.target.value) || 3))} />
        </Field>
        <Button variant="secondary" onClick={() => void doRun()} disabled={!idle}>
          {t('fac.reset.run')}
        </Button>
      </div>
      <OutcomeView outcome={outcome} />
    </DashboardCard>
  );
};

const FactoryResetCard: React.FC<{ gw: Gateway; idle: boolean }> = ({ gw, idle }) => {
  const { t } = useI18n();
  const [level2, setLevel2] = useState(false);
  const [force, setForce] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const doRun = async () => {
    const r = await gw.run(t('fac.fr.title'), (ctx) => factoryReset(ctx, level2, { force }));
    if (!r.ok) return setOutcome(failure(r, t));
    setOutcome(r.value.verified ? { tone: 'ok', text: t('fac.fr.ok') } : { tone: 'error', text: r.value.mismatches.join('\n') });
  };

  return (
    <DashboardCard title={t('fac.fr.title')} accent="red">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="radio" className="accent-red-500" checked={!level2} onChange={() => setLevel2(false)} />
          {t('fac.fr.lv1')}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="radio" className="accent-red-500" checked={level2} onChange={() => setLevel2(true)} />
          {t('fac.fr.lv2')}
        </label>
        <Checkbox label={t('fac.fr.force')} checked={force} onChange={setForce} />
      </div>
      <Button className="mt-3" variant="danger" onClick={() => void doRun()} disabled={!idle}>
        {t('fac.fr.run')}
      </Button>
      <OutcomeView outcome={outcome} />
      <Hint>{t('fac.fr.hint')}</Hint>
    </DashboardCard>
  );
};

export const FactoryPanel: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const idle = gw.connected && !gw.busy;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <ProvisionCard gw={gw} idle={idle} />
      <AssignIdCard gw={gw} idle={idle} />
      <SetIdCard gw={gw} idle={idle} />
      <ResetCard gw={gw} idle={idle} />
      <FactoryResetCard gw={gw} idle={idle} />
    </div>
  );
};
