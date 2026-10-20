import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { Gateway } from '../../hooks/useGateway';
import { MessageKey, useI18n } from '../../i18n';
import { hex4 } from '../../utils/modbusRtu';
import { Dashboard, readDashboard } from '../../utils/ops/info';
import { LINK_ONLINE, LINK_STATUS_BITS, PCIE_STATUS_LORA_READY } from '../../utils/registers';
import { DashboardCard } from '../DashboardCard';
import { Button, Checkbox, KV, Pill } from '../controls';
import { formatResetCause } from '../format';
import { failure, Outcome, OutcomeView } from './outcome';

const AUTO_REFRESH_S = 5;

interface Props {
  gw: Gateway;
  dashboard: Dashboard | null;
  setDashboard: (d: Dashboard) => void;
}

export const DashboardPanel: React.FC<Props> = ({ gw, dashboard, setDashboard }) => {
  const { t } = useI18n();
  const [auto, setAuto] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const refresh = useCallback(
    async (background: boolean) => {
      const r = await gw.run(t('common.refresh'), readDashboard, { background });
      if (r.ok) {
        setDashboard(r.value);
        setOutcome(null);
      } else if (!background) setOutcome(failure(r, t));
    },
    [gw, setDashboard, t],
  );

  useEffect(() => {
    if (!auto || !gw.connected) return;
    const id = setInterval(() => void refresh(true), AUTO_REFRESH_S * 1000);
    return () => clearInterval(id);
  }, [auto, gw.connected, refresh]);

  const s = dashboard?.sys;
  const n = dashboard?.ntn;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={() => void refresh(false)} disabled={!gw.connected || !!gw.busy} className="inline-flex items-center gap-1">
          <ArrowPathIcon className="w-4 h-4" />
          {t('common.refresh')}
        </Button>
        <Checkbox label={t('dash.autoRefresh', { s: AUTO_REFRESH_S })} checked={auto} onChange={setAuto} disabled={!gw.connected} />
        <span className="text-xs text-slate-500">
          {dashboard ? t('dash.lastRead', { t: new Date(dashboard.readAt).toLocaleTimeString() }) : t('dash.never')}
        </span>
      </div>
      <OutcomeView outcome={outcome} />

      <DashboardCard
        title={t('dash.link')}
        accent="cyan"
        actions={
          s && (
            <span className="font-mono text-xs text-slate-400">
              0x{hex4(s.linkStatus)} <Pill on={s.linkStatus === LINK_ONLINE}>{s.linkStatus === LINK_ONLINE ? t('dash.online') : t('dash.offline')}</Pill>
            </span>
          )
        }
      >
        <div className="flex flex-wrap gap-2">
          {LINK_STATUS_BITS.map((bit) => (
            <Pill key={bit} on={!!s && (s.linkStatus & (1 << bit)) !== 0}>
              {bit} · {t(`link.bit${bit}` as MessageKey)}
            </Pill>
          ))}
        </div>
      </DashboardCard>

      <div className="grid md:grid-cols-2 gap-4">
        <DashboardCard title={t('dash.sys')} accent="blue">
          <KV label={t('field.sn')} value={s?.sn ?? '—'} />
          <KV label={t('field.model')} value={s?.model ?? '—'} />
          <KV label={t('field.sku')} value={s?.sku ?? '—'} />
          <KV label={t('field.fw')} value={s?.fwVersion ?? '—'} />
          <KV label={t('field.hw')} value={s?.hwVersion ?? '—'} />
          <KV label={t('field.modbusId')} value={s?.modbusId ?? '—'} />
          <KV label={t('field.resetCause')} value={s ? formatResetCause(s.resetCause, t) : '—'} mono={false} />
          <KV
            label={t('field.loraReady')}
            value={s ? <Pill on={(s.pcieStatus & PCIE_STATUS_LORA_READY) !== 0}>{s.pcieStatus & PCIE_STATUS_LORA_READY ? t('val.ready') : t('val.notReady')}</Pill> : '—'}
          />
          <KV
            label={t('field.uplinkChannel')}
            value={s ? <Pill on={!s.uplinkBusy}>{s.uplinkBusy ? t('val.busy') : t('val.free')}</Pill> : '—'}
          />
        </DashboardCard>

        <DashboardCard title={t('dash.ntn')} accent="green">
          <KV label={t('field.imsi')} value={n?.imsi || '—'} />
          <KV label={t('field.swVersion')} value={n?.swVersion || '—'} />
          <KV label={t('field.sinr')} value={n?.sinr || '—'} />
          <KV label={t('field.rsrp')} value={n?.rsrp || '—'} />
          <KV label={t('field.grade')} value={n?.grade || '—'} />
          <KV label={t('field.time')} value={n?.time || '—'} />
          <KV label={t('field.lat')} value={n?.latitude || '—'} />
          <KV label={t('field.lon')} value={n?.longitude || '—'} />
          <KV label={t('field.netMode')} value={n ? n.netMode : '—'} />
          <KV label={t('field.ip')} value={n?.ip || '—'} />
          <KV label={t('field.socket')} value={n ? (n.socket === 0xffff ? t('val.none') : n.socket) : '—'} />
        </DashboardCard>
      </div>
    </div>
  );
};
