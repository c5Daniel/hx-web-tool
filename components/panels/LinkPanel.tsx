import React, { useState } from 'react';
import { Gateway } from '../../hooks/useGateway';
import { useI18n } from '../../i18n';
import { asciiPreview, DownlinkResult, hexToBytes, LoraReply, UPLINK_MAX_PAYLOAD_BYTES } from '../../utils/ntnCodec';
import { hexDump } from '../../utils/modbusRtu';
import { fetchDownlink, sendUplink, waitUplinkResult, watchDownlink } from '../../utils/ops/link';
import { ntnAtPayload, ntnAtPoll, ntnAtReplyOk, ntnAtSend } from '../../utils/ops/ntnAt';
import { NTN_AT_DEFAULT_WAIT_S } from '../../utils/registers';
import { DashboardCard } from '../DashboardCard';
import { Button, Checkbox, Field, Hint, Result, Select, TextArea, TextInput } from '../controls';
import { failure, Outcome, OutcomeView } from './outcome';

type PayloadMode = 'text' | 'hex' | 'file';

// Read-only queries that end on an OK. Not AT+CIMI: older RMM-T1 software
// sends no OK after the IMSI, so there it runs the firmware's full 30 s.
const NTN_QUICK = ['AT', 'ATI', 'AT!CSQSTA=0', 'AT!CNWSTA?'];

function NtnAtReplyView({ reply }: { reply: LoraReply }) {
  const { t } = useI18n();
  if (!reply.lengthWords) return <Result tone="warn">{t('ntnat.empty')}</Result>;
  return (
    <Result tone={ntnAtReplyOk(reply) ? 'ok' : 'warn'} mono>
      {t('ntnat.reply', { n: reply.raw.length })}
      {'\n'}
      {reply.text.replace(/\r\n|\r/g, '\n').trimEnd()}
    </Result>
  );
}

function DownlinkView({ d }: { d: DownlinkResult }) {
  const { t } = useI18n();
  return (
    <Result tone="ok" mono>
      {d.payload ? (
        <>
          {t('dl.decoded')} ({d.payload.length} B): {asciiPreview(d.payload)}
          {'\n'}
          {hexDump(d.payload)}
        </>
      ) : (
        t('dl.decodeFailed')
      )}
      {'\n'}
      {t('dl.stored')}: {asciiPreview(d.storedHex)}
    </Result>
  );
}

export const LinkPanel: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const { t } = useI18n();
  const idle = gw.connected && !gw.busy;

  const [mode, setMode] = useState<PayloadMode>('text');
  const [text, setText] = useState('hello');
  const [file, setFile] = useState<Uint8Array | null>(null);
  const [raw, setRaw] = useState(false);
  const [ulOutcome, setUlOutcome] = useState<Outcome | null>(null);

  const [waitS, setWaitS] = useState(660);
  const [resOutcome, setResOutcome] = useState<Outcome | null>(null);

  const [interval, setIntervalS] = useState(1);
  const [downlinks, setDownlinks] = useState<DownlinkResult[]>([]);
  const [dlOutcome, setDlOutcome] = useState<Outcome | null>(null);

  const [atCmd, setAtCmd] = useState('AT');
  const [atRead, setAtRead] = useState(true);
  const [atWaitS, setAtWaitS] = useState(NTN_AT_DEFAULT_WAIT_S);
  const [atCrlf, setAtCrlf] = useState(true);
  const [atReply, setAtReply] = useState<LoraReply | null>(null);
  const [atOutcome, setAtOutcome] = useState<Outcome | null>(null);

  let atCmdError: string | null = null;
  try {
    ntnAtPayload(atCmd, atCrlf);
  } catch (e) {
    atCmdError = (e as Error).message;
  }

  let payload: Uint8Array | null = null;
  let payloadError: string | null = null;
  try {
    if (mode === 'text') payload = new TextEncoder().encode(text);
    else if (mode === 'hex') payload = hexToBytes(text);
    else payload = file;
  } catch (e) {
    payloadError = (e as Error).message;
  }
  const tooLong = !!payload && payload.length > UPLINK_MAX_PAYLOAD_BYTES;

  const onFile = async (f: File | undefined) => {
    if (!f) return setFile(null);
    let bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3); // UTF-8 BOM
    setFile(bytes);
  };

  const doUplink = async () => {
    if (!payload) return;
    const r = await gw.run(t('ul.send'), (ctx) => sendUplink(ctx, payload!, raw));
    setUlOutcome(r.ok ? { tone: 'ok', text: t('ul.sent', { n: r.value.length }) } : failure(r, t));
  };

  const doResult = async () => {
    const r = await gw.run(t('ulres.check'), (ctx) => waitUplinkResult(ctx, waitS));
    if (!r.ok) return setResOutcome(failure(r, t));
    const msg = r.value;
    setResOutcome(
      msg === null ? { tone: 'warn', text: t('ulres.none') } : { tone: /Completed/.test(msg) ? 'ok' : 'error', text: msg.trim() },
    );
  };

  const doDownlink = async () => {
    const r = await gw.run(t('dl.read'), fetchDownlink);
    if (!r.ok) return setDlOutcome(failure(r, t));
    if (!r.value.lengthWords) return setDlOutcome({ tone: 'info', text: t('dl.empty') });
    setDlOutcome(null);
    setDownlinks((prev) => [r.value, ...prev].slice(0, 20));
  };

  const doWatch = async () => {
    setDlOutcome(null);
    const r = await gw.run(t('dl.watch'), (ctx) =>
      watchDownlink(ctx, interval, (d) => setDownlinks((prev) => [d, ...prev].slice(0, 20))),
    );
    setDlOutcome(failure(r, t));
  };

  const doNtnAt = async () => {
    setAtReply(null);
    const r = await gw.run(`NTN ${atCmd}`, (ctx) => ntnAtSend(ctx, atCmd, { read: atRead, waitS: atWaitS, crlf: atCrlf }));
    if (!r.ok) return setAtOutcome(failure(r, t));
    if (r.value) {
      setAtOutcome(null);
      setAtReply(r.value);
    } else setAtOutcome({ tone: atRead ? 'warn' : 'info', text: t(atRead ? 'ntnat.noReply' : 'ntnat.queued') });
  };

  const doNtnAtPoll = async () => {
    setAtReply(null);
    const r = await gw.run(t('ntnat.poll'), ntnAtPoll);
    if (!r.ok) return setAtOutcome(failure(r, t));
    setAtOutcome(null);
    setAtReply(r.value);
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <DashboardCard title={t('ul.title')} accent="blue" className="lg:row-span-2">
        <div className="space-y-3">
          <Field label={t('ul.payload')}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as PayloadMode)}>
              <option value="text">{t('ul.mode.text')}</option>
              <option value="hex">{t('ul.mode.hex')}</option>
              <option value="file">{t('ul.mode.file')}</option>
            </Select>
          </Field>
          {mode === 'file' ? (
            <input
              type="file"
              className="block w-full text-sm text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-slate-700 file:text-slate-100"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          ) : (
            <TextArea rows={5} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          )}
          <div className={`text-xs ${tooLong || payloadError ? 'text-red-400' : 'text-slate-500'}`}>
            {payloadError ?? t('ul.bytes', { n: payload?.length ?? 0 })}
          </div>
          <Checkbox label={t('ul.raw')} checked={raw} onChange={setRaw} />
          <Button onClick={() => void doUplink()} disabled={!idle || !payload || !payload.length || tooLong}>
            {t('ul.send')}
          </Button>
          <OutcomeView outcome={ulOutcome} />
          <Hint>{t('ul.hint')}</Hint>
        </div>
      </DashboardCard>

      <DashboardCard title={t('ulres.title')} accent="green">
        <div className="flex items-end gap-3">
          <Field label={t('ulres.wait')} className="w-32">
            <TextInput type="number" min={0} value={waitS} onChange={(e) => setWaitS(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Button onClick={() => void doResult()} disabled={!idle}>
            {t('ulres.check')}
          </Button>
        </div>
        <OutcomeView outcome={resOutcome} />
        <Hint>{t('ulres.hint')}</Hint>
      </DashboardCard>

      <DashboardCard title={t('dl.title')} accent="purple">
        <div className="flex flex-wrap items-end gap-3">
          <Button onClick={() => void doDownlink()} disabled={!idle}>
            {t('dl.read')}
          </Button>
          <Field label={t('dl.interval')} className="w-24">
            <TextInput type="number" min={1} value={interval} onChange={(e) => setIntervalS(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Button variant="secondary" onClick={() => void doWatch()} disabled={!idle}>
            {t('dl.watch')}
          </Button>
        </div>
        <OutcomeView outcome={dlOutcome} />
        {downlinks.map((d, i) => (
          <DownlinkView key={downlinks.length - i} d={d} />
        ))}
        <Hint>{t('dl.hint')}</Hint>
      </DashboardCard>

      <DashboardCard title={t('ntnat.title')} accent="cyan" className="lg:col-span-2">
        <Field label={t('ntnat.cmd')} error={atCmdError}>
          <TextInput
            value={atCmd}
            onChange={(e) => setAtCmd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && idle && !atCmdError && !!atCmd && void doNtnAt()}
            spellCheck={false}
          />
        </Field>
        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-slate-500 mr-1">{t('ntnat.quick')}</span>
          {NTN_QUICK.map((q) => (
            <button key={q} onClick={() => setAtCmd(q)} className="px-2 py-0.5 rounded bg-slate-700/60 hover:bg-slate-600 text-xs font-mono text-slate-200">
              {q}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <Checkbox label={t('ntnat.read')} checked={atRead} onChange={setAtRead} />
          <Field label={t('ntnat.wait')} className="w-28">
            <TextInput type="number" min={1} value={atWaitS} disabled={!atRead} onChange={(e) => setAtWaitS(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Checkbox label={t('ntnat.crlf')} checked={atCrlf} onChange={setAtCrlf} />
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <Button onClick={() => void doNtnAt()} disabled={!idle || !!atCmdError || !atCmd}>
            {t('ntnat.send')}
          </Button>
          <Button variant="secondary" onClick={() => void doNtnAtPoll()} disabled={!idle}>
            {t('ntnat.poll')}
          </Button>
        </div>
        <OutcomeView outcome={atOutcome} />
        {atReply && <NtnAtReplyView reply={atReply} />}
        <Hint>{t('ntnat.hint')}</Hint>
      </DashboardCard>
    </div>
  );
};
