import React, { useState } from 'react';
import { Gateway } from '../../hooks/useGateway';
import { useI18n } from '../../i18n';
import { hex4, hexDump } from '../../utils/modbusRtu';
import { asciiPreview, dlcmdEncode, DlcmdFrame, dlcmdSelfTest, DlcmdValue, validateXmr, wordsHex } from '../../utils/ntnCodec';
import { parseIntervalArg } from '../../utils/ops/config';
import { RawRead, rawRead } from '../../utils/ops/info';
import { DashboardCard } from '../DashboardCard';
import { Button, Checkbox, Field, Hint, Result, Select, TextInput } from '../controls';
import { failure, Outcome, OutcomeView } from './outcome';

function parseAddr(text: string): number | null {
  const s = text.trim().toLowerCase();
  const n = s.startsWith('0x') ? parseInt(s.slice(2), 16) : /^\d+$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 0xffff ? n : null;
}

const RawReadCard: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const { t } = useI18n();
  const idle = gw.connected && !gw.busy;
  const [addr, setAddr] = useState('0xEA60');
  const [count, setCount] = useState(30);
  const [fc, setFc] = useState<3 | 4>(4);
  const [doLogin, setDoLogin] = useState(true);
  const [res, setRes] = useState<RawRead | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const a = parseAddr(addr);

  const doRead = async () => {
    if (a === null) return;
    const r = await gw.run(`${t('tools.read.title')} 0x${hex4(a)}`, (ctx) => rawRead(ctx, a, count, fc, doLogin));
    if (r.ok) {
      setRes(r.value);
      setOutcome(null);
    } else {
      setRes(null);
      setOutcome(failure(r, t));
    }
  };

  return (
    <DashboardCard title={t('tools.read.title')} accent="blue">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
        <Field label={t('tools.read.addr')} error={a === null ? '0x0000–0xFFFF' : null}>
          <TextInput value={addr} onChange={(e) => setAddr(e.target.value)} />
        </Field>
        <Field label={t('tools.read.count')}>
          <TextInput type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={t('tools.read.fc')}>
          <Select value={fc} onChange={(e) => setFc(Number(e.target.value) as 3 | 4)}>
            <option value={4}>FC 0x04 Input</option>
            <option value={3}>FC 0x03 Holding</option>
          </Select>
        </Field>
        <Button onClick={() => void doRead()} disabled={!idle || a === null}>
          {t('tools.read.run')}
        </Button>
      </div>
      <div className="mt-2">
        <Checkbox label={t('tools.read.login')} checked={doLogin} onChange={setDoLogin} />
      </div>
      <OutcomeView outcome={outcome} />
      {res && (
        <Result tone="info" mono>
          {`words: ${wordsHex(res.words)}\nbytes: ${hexDump(res.bytes)}\nascii: ${asciiPreview(res.bytes)}`}
        </Result>
      )}
    </DashboardCard>
  );
};

const DlcmdCard: React.FC<{ imsi: string }> = ({ imsi: deviceImsi }) => {
  const { t } = useI18n();
  const [imsi, setImsi] = useState('');
  const [socket, setSocket] = useState(1);
  const [active, setActive] = useState('');
  const [csq, setCsq] = useState('');
  const [lora, setLora] = useState('');
  const [xmr, setXmr] = useState('');
  const [frame, setFrame] = useState<DlcmdFrame | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const encode = () => {
    setFrame(null);
    try {
      const fields: Record<string, DlcmdValue> = {};
      if (active !== '') {
        if (!/^-?\d+$/.test(active)) throw new Error('active must be an integer');
        fields.active = Number(active);
      }
      // ttool sends 'off' as -1, the wire dialect for 0xFFFFFFFF.
      const ivl = (text: string) => (parseIntervalArg(text) === 0xffffffff ? -1 : parseIntervalArg(text));
      if (csq !== '') fields.timeperiods = ivl(csq);
      if (lora !== '') fields.lrtimeperiods = ivl(lora);
      if (xmr !== '') {
        const err = validateXmr(xmr);
        if (err) throw new Error(`xmr ${err}`);
        fields.xmr = xmr;
      }
      if (!Object.keys(fields).length) throw new Error(t('tools.dl.nothing'));
      setFrame(dlcmdEncode(imsi.trim(), fields, socket));
      setOutcome(null);
    } catch (e) {
      setOutcome({ tone: 'error', text: (e as Error).message });
    }
  };

  const selfTest = () => {
    setFrame(null);
    const results = dlcmdSelfTest();
    const ok = results.every((r) => r.ok);
    const lines = results.map((r) => `${r.ok ? 'OK ' : 'BAD'} ${JSON.stringify(r.fields)}`);
    setOutcome({
      tone: ok ? 'ok' : 'error',
      text: `${ok ? t('tools.dl.selfTestOk', { n: results.length }) : t('tools.dl.selfTestFail')}\n${lines.join('\n')}`,
    });
  };

  return (
    <DashboardCard title={t('tools.dl.title')} accent="purple">
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={t('tools.dl.imsi')} className="sm:col-span-2">
          <div className="flex gap-2">
            <TextInput value={imsi} onChange={(e) => setImsi(e.target.value)} maxLength={15} />
            <Button variant="ghost" disabled={!deviceImsi} onClick={() => setImsi(deviceImsi)} title={t('tools.dl.useImsi')}>
              ⤵
            </Button>
          </div>
        </Field>
        <Field label={t('tools.dl.socket')}>
          <TextInput type="number" min={0} value={socket} onChange={(e) => setSocket(Math.max(0, Number(e.target.value) || 0))} />
        </Field>
        <Field label={t('tools.dl.active')}>
          <TextInput value={active} onChange={(e) => setActive(e.target.value)} />
        </Field>
        <Field label={t('tools.dl.csq')}>
          <TextInput value={csq} onChange={(e) => setCsq(e.target.value)} />
        </Field>
        <Field label={t('tools.dl.lora')}>
          <TextInput value={lora} onChange={(e) => setLora(e.target.value)} />
        </Field>
        <Field label={t('tools.dl.xmr')} className="sm:col-span-3">
          <TextInput value={xmr} placeholder="AT+BISCSENDWR=3:0106…" onChange={(e) => setXmr(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex gap-3">
        <Button onClick={encode}>{t('tools.dl.encode')}</Button>
        <Button variant="ghost" onClick={selfTest}>
          {t('tools.dl.selfTest')}
        </Button>
      </div>
      <OutcomeView outcome={outcome} mono />
      {frame && (
        <>
          <Result tone="ok" mono>
            {`text : ${frame.text}\ncrc  : ${frame.crcHex}\nlen  : ${frame.dataLen}\nurc  : ${frame.urc}`}
          </Result>
          <Button variant="ghost" className="mt-2" onClick={() => void navigator.clipboard?.writeText(frame.urc)}>
            {t('common.copy')} URC
          </Button>
        </>
      )}
      <Hint>{t('tools.dl.hint')}</Hint>
    </DashboardCard>
  );
};

// The downlink generator is hidden from the page for now; the card, the codec
// and their tests stay so it can come back by flipping this flag.
const SHOW_DLCMD_CARD = false;

export const ToolsPanel: React.FC<{ gw: Gateway; imsi: string }> = ({ gw, imsi }) => (
  <div className="grid lg:grid-cols-2 gap-4">
    <RawReadCard gw={gw} />
    {SHOW_DLCMD_CARD && <DlcmdCard imsi={imsi} />}
  </div>
);
