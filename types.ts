export interface LogEntry {
  id: number;
  timestamp: string;
  direction: 'TX' | 'RX' | 'SYS';
  message: string;
  isError?: boolean;
}

export type Tab = 'dashboard' | 'link' | 'config' | 'lora' | 'passthrough' | 'factory' | 'tools';

/** Top-level page: the serial Modbus tool, or the Web Bluetooth status page (independent links). */
export type AppMode = 'serial' | 'ble';

/** What run() hands back: the operation's value, or why it did not finish. */
export type RunResult<T> = { ok: true; value: T } | { ok: false; error: string; cancelled?: boolean };
