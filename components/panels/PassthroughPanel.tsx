import React, { useEffect, useRef, useState } from 'react';
import { Gateway } from '../../hooks/useGateway';
import { useI18n } from '../../i18n';
import { asciiBytes } from '../../utils/ntnCodec';
import { PassthroughTarget } from '../../utils/ops/context';
import { enterPassthrough, exitPassthrough, passthroughFwver } from '../../utils/ops/passthrough';
import { DashboardCard } from '../DashboardCard';
import { Button, Hint, TextInput } from '../controls';
import { failure, Outcome, OutcomeView } from './outcome';

const TERM_MAX_CHARS = 64 * 1024;

/** Raw view of the bridged peer: everything the host port receives while the bridge is live. */
const Terminal: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [line, setLine] = useState('');
  const boxRef = useRef<HTMLPreElement>(null);
  const live = gw.connected && !!gw.passthrough;
  const { subscribeRx } = gw;

  useEffect(() => {
    if (!live) return;
    const decoder = new TextDecoder();
    return subscribeRx((chunk) => {
      const s = decoder.decode(chunk, { stream: true });
      setText((prev) => (prev + s).slice(-TERM_MAX_CHARS));
    });
  }, [live, subscribeRx]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [text]);

  const send = async () => {
    if (!line) return;
    try {
      await gw.sendRaw(asciiBytes(`${line}\r\n`));
      setText((prev) => `${prev}> ${line}\n`);
      setLine('');
    } catch (e) {
      gw.addLog('SYS', `terminal: ${(e as Error).message}`, true);
    }
  };

  return (
    <DashboardCard
      title={t('pt.term.title')}
      accent="green"
      actions={
        <Button variant="ghost" onClick={() => setText('')}>
          {t('pt.term.clear')}
        </Button>
      }
    >
      <pre ref={boxRef} className="h-72 overflow-y-auto bg-slate-950 border border-slate-800 rounded-md p-3 font-mono text-xs text-green-300 whitespace-pre-wrap break-all">
        {text || (live ? '' : t('pt.term.inactive'))}
      </pre>
      <div className="mt-3 flex gap-2">
        <TextInput
          value={line}
          disabled={!live}
          placeholder={t('pt.term.placeholder')}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
          spellCheck={false}
        />
        <Button onClick={() => void send()} disabled={!live || !line}>
          {t('pt.term.send')}
        </Button>
      </div>
      {gw.passthrough === 'lora' && <Hint>{t('pt.term.loraHint')}</Hint>}
    </DashboardCard>
  );
};

export const PassthroughPanel: React.FC<{ gw: Gateway }> = ({ gw }) => {
  const { t } = useI18n();
  const idle = gw.connected && !gw.busy;
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const enter = async (target: PassthroughTarget) => {
    const r = await gw.run(target === 'lora' ? t('pt.enterLora') : t('pt.enterNtn'), (ctx) => enterPassthrough(ctx, target));
    setOutcome(r.ok ? { tone: 'ok', text: t('common.done') } : failure(r, t));
  };

  const exit = async () => {
    const r = await gw.run(t('pt.exit'), exitPassthrough, { passthroughOk: true });
    setOutcome(r.ok ? { tone: 'ok', text: t('common.done') } : failure(r, t));
  };

  const fwver = async () => {
    const r = await gw.run(t('pt.fwver'), passthroughFwver, { passthroughOk: true });
    setOutcome(r.ok ? { tone: 'ok', text: t('pt.fwverResult', { v: r.value }) } : failure(r, t));
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <DashboardCard title={t('pt.title')} accent="amber">
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void enter('ntn')} disabled={!idle || !!gw.passthrough}>
            {t('pt.enterNtn')}
          </Button>
          <Button onClick={() => void enter('lora')} disabled={!idle || !!gw.passthrough}>
            {t('pt.enterLora')}
          </Button>
          <Button variant="secondary" onClick={() => void fwver()} disabled={!idle}>
            {t('pt.fwver')}
          </Button>
          <Button variant="danger" onClick={() => void exit()} disabled={!idle}>
            {t('pt.exit')}
          </Button>
        </div>
        <OutcomeView outcome={outcome} />
        <Hint>{t('pt.hint')}</Hint>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {t('pt.manual')}
          <Button variant="ghost" onClick={() => gw.setPassthroughManual('ntn')} disabled={!!gw.busy}>
            {t('pt.markNtn')}
          </Button>
          <Button variant="ghost" onClick={() => gw.setPassthroughManual('lora')} disabled={!!gw.busy}>
            {t('pt.markLora')}
          </Button>
          <Button variant="ghost" onClick={() => gw.setPassthroughManual(null)} disabled={!!gw.busy}>
            {t('pt.markNone')}
          </Button>
        </div>
      </DashboardCard>
      <Terminal gw={gw} />
    </div>
  );
};
