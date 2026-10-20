// Register values as UI text, shared by the serial dashboard and the BLE page
// so both say the same thing for the same value.

import { MessageKey, Translate } from '../i18n';
import { hex4 } from '../utils/modbusRtu';
import { RESET_CAUSE_BITS } from '../utils/registers';

/** 0xEA70: "Power-on", or the names of the set bits plus the raw value. */
export function formatResetCause(v: number, t: Translate): string {
  if (v === 0) return t('reset.0000');
  const names = RESET_CAUSE_BITS.filter((b) => v & b).map((b) => t(`reset.${hex4(b)}` as MessageKey));
  return `${names.join(' + ') || '?'} (0x${hex4(v)})`;
}
