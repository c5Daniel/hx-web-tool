import React from 'react';
import { Translate } from '../../i18n';
import { RunResult } from '../../types';
import { Result, Tone } from '../controls';

export interface Outcome {
  tone: Tone;
  text: string;
}

/** The outcome of a failed or cancelled run, or null when it succeeded. */
export function failure<T>(r: RunResult<T>, t: Translate): Outcome | null {
  if (r.ok) return null;
  if (r.cancelled) return { tone: 'info', text: r.error };
  return { tone: 'error', text: t('common.failed', { e: r.error }) };
}

export const OutcomeView: React.FC<{ outcome: Outcome | null; mono?: boolean }> = ({ outcome, mono }) =>
  outcome ? (
    <Result tone={outcome.tone} mono={mono}>
      {outcome.text}
    </Result>
  ) : null;
