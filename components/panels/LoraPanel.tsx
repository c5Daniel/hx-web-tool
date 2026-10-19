import React, { useState } from 'react';
import { Gateway } from '../../hooks/useGateway';
import { useI18n } from '../../i18n';
import { hex4 } from '../../utils/modbusRtu';
import { LoraReply } from '../../utils/ntnCodec';
import { LORA_INTERVAL_BISGET_MAX_S, loraInterval, loraPayload, loraPoll, loraSend, loraStatus } from '../../utils/ops/lora';
import { DashboardCard } from '../DashboardCard';
import { Button, Checkbox, Field, Hint, Result, TextInput } from '../controls';
import { failure, Outcome, OutcomeView } from './outcome';

// Read-only queries whose reply fits a 512-byte mailbox. Not the bare
// AT+BISDEV=? (a ~2.6 KB dump) and not AT+BISGET (it consumes the record).
const QUICK = ['AT', 'AT+VER=?', 'AT+BISFMT=?', 'AT+BISDEV=0?'];

function ReplyView({ reply, box }: { reply: LoraReply; box: number }) {
  const { t } = useI18n();
  if (!reply.lengthWords) return <Result tone="warn">{t('lora.replyEmpty')}</Result>;
  return (
    <Result tone="ok" mono>
      {t('lora.reply', { box: `0x${hex4(box)}, ${reply.raw.length} B` })}
      {'\n'}
      {reply.text.replace(/\r\n|\r/g, '\n').trimEnd()}
    </Result>
  );
}

export const LoraPanel: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const { t } = useI18n();
  const idle = gw.connected && !gw.busy;

  const [cmd, setCmd] = useState('AT');
  const [read, setRead] = useState(true);
  const [waitS, setWaitS] = useState(3);
  const [crlf, setCrlf] = useState(true);
  const [atReply, setAtReply] = useState<{ reply: LoraReply; box: number } | null>(null);
  const [atOutcome, setAtOutcome] = useState<Outcome | null>(null);

  const [pollReply, setPollReply] = useState<{ reply: LoraReply; box: number } | null>(null);
  const [pollOutcome, setPollOutcome] = useState<Outcome | null>(null);

  const [statusOutcome, setStatusOutcome] = useState<Outcome | null>(null);

  const [index, setIndex] = useState(0);
  const [nodeWait, setNodeWait] = useState(2);
  const [intOutcome, setIntOutcome] = useState<Outcome | null>(null);

  let cmdError: string | null = null;
  try {
    loraPayload(cmd, crlf);
  } catch (e) {
    cmdError = (e as Error).message;
  }

  const doSend = async () => {
    setAtReply(null);
    const r = await gw.run(`LoRa ${cmd}`, (ctx) => loraSend(ctx, cmd, { read, waitS, crlf }));
    if (!r.ok) return setAtOutcome(failure(r, t));
    if (r.value.reply && r.value.mailbox) {
      setAtOutcome(null);
      setAtReply({ reply: r.value.reply, box: r.value.mailbox });
    } else setAtOutcome({ tone: 'info', text: t('lora.at.sentNoRead') });
  };

  const doPoll = async (bisget: boolean) => {
    const r = await gw.run(bisget ? t('lora.poll.bisget') : t('lora.poll.reply'), (ctx) => loraPoll(ctx, bisget));
    if (!r.ok) {
      setPollReply(null);
      return setPollOutcome(failure(r, t));
    }
    setPollOutcome(null);
    setPollReply({ reply: r.value, box: bisget ? 0xf460 : 0xf860 });
  };

  const doStatus = async () => {
    const r = await gw.run(t('lora.status.title'), loraStatus);
    if (!r.ok) return setStatusOutcome(failure(r, t));
    setStatusOutcome(
      r.value.ready
        ? { tone: 'ok', text: `0x${hex4(r.value.value)} — ${t('lora.status.ready')}` }
        : { tone: 'error', text: `0x${hex4(r.value.value)} — ${t('lora.status.notReady')}` },
    );
  };

  const doInterval = async () => {
    const r = await gw.run(t('lora.int.title'), (ctx) => loraInterval(ctx, index, nodeWait));
    if (!r.ok) return setIntOutcome(failure(r, t));
    const v = r.value;
    if (v.kind === 'seconds') setIntOutcome({ tone: 'ok', text: t('lora.int.result', { i: index, s: v.seconds }) });
    else setIntOutcome({ tone: 'warn', text: `${t(v.kind === 'overwritten' ? 'lora.int.overwritten' : 'lora.int.none')}\n${v.reply.trim()}` });
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <DashboardCard title={t('lora.at.title')} accent="purple" className="lg:row-span-2">
        <Field label={t('lora.at.cmd')} error={cmdError}>
          <TextInput
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && idle && !cmdError && void doSend()}
            spellCheck={false}
          />
        </Field>
        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-slate-500 mr-1">{t('lora.quick')}</span>
          {QUICK.map((q) => (
            <button key={q} onClick={() => setCmd(q)} className="px-2 py-0.5 rounded bg-slate-700/60 hover:bg-slate-600 text-xs font-mono text-slate-200">
              {q}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <Checkbox label={t('lora.at.read')} checked={read} onChange={setRead} />
          <Field label={t('lora.at.wait')} className="w-24">
            <TextInput type="number" min={0} step={0.5} value={waitS} disabled={!read} onChange={(e) => setWaitS(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Checkbox label={t('lora.at.crlf')} checked={crlf} onChange={setCrlf} />
        </div>
        <Button className="mt-3" onClick={() => void doSend()} disabled={!idle || !!cmdError || !cmd}>
          {t('lora.at.send')}
        </Button>
        <OutcomeView outcome={atOutcome} />
        {atReply && <ReplyView reply={atReply.reply} box={atReply.box} />}
      </DashboardCard>

      <DashboardCard title={t('lora.mailbox.title')} accent="cyan">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => void doPoll(true)} disabled={!idle}>
            {t('lora.poll.bisget')}
          </Button>
          <Button variant="secondary" onClick={() => void doPoll(false)} disabled={!idle}>
            {t('lora.poll.reply')}
          </Button>
        </div>
        <OutcomeView outcome={pollOutcome} />
        {pollReply && <ReplyView reply={pollReply.reply} box={pollReply.box} />}
        <Hint>{t('lora.mailbox.hint')}</Hint>
      </DashboardCard>

      <DashboardCard title={t('lora.status.title')} accent="green">
        <Button variant="secondary" onClick={() => void doStatus()} disabled={!idle}>
          {t('lora.status.check')}
        </Button>
        <OutcomeView outcome={statusOutcome} />
      </DashboardCard>

      <DashboardCard title={t('lora.int.title')} accent="amber">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('lora.int.index')} className="w-32">
            <TextInput type="number" min={0} max={30} value={index} onChange={(e) => setIndex(Math.min(30, Math.max(0, Number(e.target.value) || 0)))} />
          </Field>
          <Field label={t('lora.int.wait')} className="w-32" error={1 + nodeWait > LORA_INTERVAL_BISGET_MAX_S ? t('lora.int.hint') : null}>
            <TextInput type="number" min={0} step={0.5} value={nodeWait} onChange={(e) => setNodeWait(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Button onClick={() => void doInterval()} disabled={!idle}>
            {t('lora.int.read')}
          </Button>
        </div>
        <OutcomeView outcome={intOutcome} mono />
        <Hint>{t('lora.int.hint')}</Hint>
      </DashboardCard>
    </div>
  );
};
