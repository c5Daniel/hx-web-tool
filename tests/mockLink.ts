import { expect } from 'vitest';
import { hexDump, ModbusClient } from '../utils/modbusRtu';
import type { OpContext, SessionPatch } from '../utils/ops/context';
import type { ByteLink } from '../utils/serialTransport';

export function h(text: string): Uint8Array {
  return new Uint8Array(text.trim().split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16)));
}

type Bytes = string | Uint8Array;

export interface Step {
  /** What the next write() must be. */
  expect: Bytes;
  /** Reply bytes; an array delivers them as separate chunks; null = silence. */
  reply: Bytes | Bytes[] | null;
}

const asBytes = (b: Bytes) => (typeof b === 'string' ? h(b) : b);

/** A scripted device: every write must match the next step, whose reply is then delivered. */
export class MockLink implements ByteLink {
  private buffer = new Uint8Array(0);
  private waiters: Array<() => void> = [];
  readonly written: string[] = [];

  constructor(private steps: Step[]) {}

  async write(data: Uint8Array): Promise<void> {
    this.written.push(hexDump(data));
    const step = this.steps.shift();
    if (!step) throw new Error(`unexpected write ${hexDump(data)}`);
    expect(hexDump(data)).toBe(hexDump(asBytes(step.expect)));
    if (step.reply === null) return;
    const chunks = Array.isArray(step.reply) ? step.reply : [step.reply];
    chunks.forEach((c, i) => setTimeout(() => this.push(asBytes(c)), 1 + i * 5));
  }

  flushInput(): void {
    this.buffer = new Uint8Array(0);
  }

  takeAvailable(): Uint8Array {
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    return out;
  }

  waitForData(timeoutMs: number): Promise<boolean> {
    if (this.buffer.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(this.buffer.length > 0);
      }, Math.max(0, timeoutMs));
      const wake = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }

  done(): void {
    expect(this.steps).toEqual([]);
  }

  private push(b: Uint8Array): void {
    const m = new Uint8Array(this.buffer.length + b.length);
    m.set(this.buffer);
    m.set(b, this.buffer.length);
    this.buffer = m;
    const ws = this.waiters;
    this.waiters = [];
    ws.forEach((w) => w());
  }
}

/** An OpContext over a scripted link, the way useGateway builds one; session patches and log lines are collected. */
export function opContext(link: ByteLink, sessions: SessionPatch[] = [], logs: string[] = []): OpContext {
  return {
    client: new ModbusClient(link),
    setLocalBaud: async () => {},
    localBaud: () => 115200,
    password: new Uint8Array(8),
    log: (msg) => logs.push(msg),
    signal: new AbortController().signal,
    confirm: async () => true,
    session: (patch) => sessions.push(patch),
  };
}
