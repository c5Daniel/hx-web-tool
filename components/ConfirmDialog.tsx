import React, { useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useI18n } from '../i18n';
import { ConfirmRequest } from '../utils/ops/context';
import { Button, TextInput } from './controls';

interface ConfirmDialogProps {
  request: ConfirmRequest;
  onAnswer: (ok: boolean) => void;
}

/** Stands in for ttool's input() prompts; with expectText the user must type it back. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ request, onAnswer }) => {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  const title = request.key ? t(`confirm.${request.key}.title`, request.vars) : request.title;
  const message = request.key ? t(`confirm.${request.key}.body`, request.vars) : request.message;
  const canConfirm = request.expectText === undefined || typed === request.expectText;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md bg-slate-800 border border-slate-600 rounded-xl p-5 shadow-2xl">
        <div className="flex items-center gap-2 mb-3 text-amber-400">
          <ExclamationTriangleIcon className="w-6 h-6" />
          <h2 className="font-semibold">{title}</h2>
        </div>
        <p className="text-sm text-slate-300 whitespace-pre-wrap">{message}</p>
        {request.expectText !== undefined && (
          <div className="mt-4">
            <p className="text-xs text-slate-400 mb-1">{t('confirm.type', { text: request.expectText })}</p>
            <TextInput autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onAnswer(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={!canConfirm} onClick={() => onAnswer(true)}>
            {t('common.ok')}
          </Button>
        </div>
      </div>
    </div>
  );
};
