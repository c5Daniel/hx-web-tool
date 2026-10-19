import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { LogEntry } from '../types';

interface LogViewerProps {
  logs: LogEntry[];
  onClear?: () => void;
}

export const LogViewer: React.FC<LogViewerProps> = ({ logs, onClear }) => {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
  };

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs, autoScroll]);

  return (
    <div className="flex flex-col h-full bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs overflow-hidden">
      <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 font-semibold flex justify-between items-center">
        <span className="text-blue-400">{t('log.title')}</span>
        <div className="flex items-center gap-4">
          <span className={`text-[10px] uppercase tracking-wider ${autoScroll ? 'text-blue-400/50' : 'text-slate-600'}`}>
            {t('log.autoscroll')} {autoScroll ? 'ON' : 'OFF'}
          </span>
          {onClear && (
            <button
              onClick={onClear}
              className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white px-2 py-1 rounded transition-colors border border-slate-700 hover:border-slate-600"
            >
              {t('log.clear')}
            </button>
          )}
        </div>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-3">
        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <span className="text-slate-600 italic">{t('log.empty')}</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {logs.map((log) => (
              <div key={log.id} className="flex gap-2">
                <span className="text-slate-600 shrink-0">[{log.timestamp}]</span>
                <span
                  className={`font-bold w-8 shrink-0 ${
                    log.direction === 'TX' ? 'text-blue-400' : log.direction === 'RX' ? 'text-green-400' : 'text-yellow-400'
                  }`}
                >
                  {log.direction}
                </span>
                <span className={`break-all ${log.isError ? 'text-red-400' : 'text-slate-300'}`}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
