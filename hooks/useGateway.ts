// The one connection hook: owns the serial transport, the Modbus client, the
// log and the session state, and runs operations one at a time. Panels never
// touch the port; they call run() with an operation from utils/ops.

import { useCallback, useEffect, useRef, useState } from 'react';
import { LogEntry, RunResult } from '../types';
import { EXCEPTION_NAMES, hexDump, ModbusClient, ModbusException } from '../utils/modbusRtu';
import { DEFAULT_PASSWORD_HEX, parsePasswordHex } from '../utils/ntnCodec';
import { ConfirmRequest, OpCancelled, OpContext, PassthroughTarget, SessionPatch } from '../utils/ops/context';
import { DriverMode, SerialTransport } from '../utils/serialTransport';

const LOG_KEY = 'hx-serial-log';
const SETTINGS_KEY = 'hx-settings';
const LOG_MAX = 500;

export interface GatewaySettings {
  driver: DriverMode;
  baud: number;
  unit: number;
  timeoutMs: number;
}

const DEFAULT_SETTINGS: GatewaySettings = { driver: DriverMode.AUTO, baud: 115200, unit: 1, timeoutMs: 1000 };

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch {
    /* storage blocked or corrupt */
  }
  return fallback;
}

function loadLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (raw) return (JSON.parse(raw) as LogEntry[]).slice(-LOG_MAX);
  } catch {
    /* ignore */
  }
  return [];
}

function timestamp(): string {
  const d = new Date();
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Error text for the log and result boxes; exceptions get their code's name. */
export function describeError(e: unknown): string {
  if (e instanceof ModbusException) return `exception 0x${e.code.toString(16).toUpperCase().padStart(2, '0')} (${EXCEPTION_NAMES[e.code] ?? 'Unknown'})`;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface RunOptions {
  /** Allowed while a passthrough bridge is live (exit / fwver / terminal). */
  passthroughOk?: boolean;
  /** Background poll: skip silently when something else is running. */
  background?: boolean;
}

export function useGateway() {
  const [settings, setSettingsState] = useState<GatewaySettings>(() => loadJson(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [engmodeAt, setEngmodeAt] = useState<number | null>(null);
  const [passthrough, setPassthrough] = useState<PassthroughTarget | null>(null);
  const [passwordHex, setPasswordHex] = useState(DEFAULT_PASSWORD_HEX);
  const [logs, setLogs] = useState<LogEntry[]>(loadLogs);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);

  const logId = useRef(Date.now());
  const transportRef = useRef(new SerialTransport());
  const busyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const passthroughRef = useRef<PassthroughTarget | null>(null);
  const passwordRef = useRef(passwordHex);
  const settingsRef = useRef(settings);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addLog = useCallback((direction: LogEntry['direction'], message: string, isError = false) => {
    const entry: LogEntry = { id: ++logId.current, timestamp: timestamp(), direction, message, isError };
    setLogs((prev) => {
      const next = [...prev.slice(-(LOG_MAX - 1)), entry];
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        try {
          localStorage.setItem(LOG_KEY, JSON.stringify(next));
        } catch {
          /* quota or blocked */
        }
      }, 500);
      return next;
    });
  }, []);

  const clientRef = useRef<ModbusClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new ModbusClient(transportRef.current, (dir, frame, note) =>
      addLog(dir, `[${String(frame.length).padStart(3)}] ${hexDump(frame)}${note ? `  (${note})` : ''}`),
    );
  }

  const setSettings = useCallback((patch: Partial<GatewaySettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      settingsRef.current = next;
      const c = clientRef.current!;
      c.unit = next.unit;
      c.timeoutMs = next.timeoutMs;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    clientRef.current!.unit = settings.unit;
    clientRef.current!.timeoutMs = settings.timeoutMs;
    // Mount only: later changes go through setSettings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySession = useCallback(
    (p: SessionPatch) => {
      if (p.unit !== undefined) setSettings({ unit: p.unit });
      if (p.baud !== undefined) setSettings({ baud: p.baud });
      if (p.unlocked !== undefined) setUnlocked(p.unlocked);
      if (p.engmodeAt !== undefined) setEngmodeAt(p.engmodeAt);
      if (p.passthrough !== undefined) {
        passthroughRef.current = p.passthrough;
        setPassthrough(p.passthrough);
      }
      if (p.passwordHex !== undefined) {
        passwordRef.current = p.passwordHex;
        setPasswordHex(p.passwordHex);
      }
    },
    [setSettings],
  );

  const resetSession = useCallback(() => {
    setUnlocked(false);
    setEngmodeAt(null);
  }, []);

  const confirm = useCallback(
    (req: ConfirmRequest) => new Promise<boolean>((resolve) => setConfirmReq({ ...req, resolve })),
    [],
  );

  const answerConfirm = useCallback((ok: boolean) => {
    setConfirmReq((cur) => {
      cur?.resolve(ok);
      return null;
    });
  }, []);

  const run = useCallback(
    async <T>(label: string, op: (ctx: OpContext) => Promise<T>, opts: RunOptions = {}): Promise<RunResult<T>> => {
      const fail = (error: string): RunResult<T> => ({ ok: false, error });
      if (!transportRef.current.isOpen) {
        if (!opts.background) addLog('SYS', `${label}: not connected`, true);
        return fail('not connected');
      }
      if (busyRef.current) {
        if (!opts.background) addLog('SYS', `${label}: busy with "${busyRef.current}"`, true);
        return fail(`busy with ${busyRef.current}`);
      }
      if (passthroughRef.current && !opts.passthroughOk) {
        if (!opts.background) addLog('SYS', `${label}: passthrough bridge is live -- exit it first`, true);
        return fail('passthrough active');
      }
      let password: Uint8Array;
      try {
        password = parsePasswordHex(passwordRef.current);
      } catch (e) {
        addLog('SYS', `${label}: ${describeError(e)}`, true);
        return fail(describeError(e));
      }

      const abort = new AbortController();
      abortRef.current = abort;
      busyRef.current = label;
      setBusy(label);
      if (!opts.background) addLog('SYS', `▶ ${label}`);
      const ctx: OpContext = {
        client: clientRef.current!,
        setLocalBaud: (b) => transportRef.current.setBaud(b),
        localBaud: () => transportRef.current.baud,
        password,
        log: (msg, isError) => addLog('SYS', msg, isError),
        signal: abort.signal,
        confirm,
        session: applySession,
      };
      try {
        const value = await op(ctx);
        if (!opts.background) addLog('SYS', `✔ ${label}`);
        return { ok: true, value };
      } catch (e) {
        if (e instanceof OpCancelled) {
          addLog('SYS', `■ ${label}: cancelled`);
          return { ok: false, error: 'cancelled', cancelled: true };
        }
        const msg = describeError(e);
        addLog('SYS', `✘ ${label}: ${msg}`, true);
        return fail(msg);
      } finally {
        busyRef.current = null;
        abortRef.current = null;
        setBusy(null);
      }
    },
    [addLog, applySession, confirm],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const connect = useCallback(async () => {
    const tr = transportRef.current;
    setConnecting(true);
    try {
      await tr.open(settingsRef.current.driver, settingsRef.current.baud);
      tr.onLost = (err) => {
        setConnected(false);
        resetSession();
        abortRef.current?.abort();
        addLog('SYS', `serial port lost: ${describeError(err)}`, true);
      };
      setConnected(true);
      addLog('SYS', `port open at ${settingsRef.current.baud} 8N1, unit ${settingsRef.current.unit}`);
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NotFoundError') addLog('SYS', 'no port selected');
      else if (name === 'NetworkError' || name === 'InvalidStateError') {
        addLog('SYS', `port busy: close ttool, a terminal or another tab using it (${describeError(e)})`, true);
      } else addLog('SYS', `open failed: ${describeError(e)}`, true);
    } finally {
      setConnecting(false);
    }
  }, [addLog, resetSession]);

  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    await transportRef.current.close();
    setConnected(false);
    resetSession();
    addLog('SYS', 'port closed');
  }, [addLog, resetSession]);

  useEffect(() => {
    const tr = transportRef.current;
    return () => {
      void tr.close();
    };
  }, []);

  /** Raw bytes onto the wire (passthrough terminal). Does not go through run(). */
  const sendRaw = useCallback(
    async (data: Uint8Array) => {
      await transportRef.current.write(data);
      addLog('TX', `[${String(data.length).padStart(3)}] ${hexDump(data)}  (terminal)`);
    },
    [addLog],
  );

  const subscribeRx = useCallback((fn: (chunk: Uint8Array) => void) => transportRef.current.subscribe(fn), []);

  /** Mark the bridge state by hand: the device keeps passthrough across a page reload, this page does not. */
  const setPassthroughManual = useCallback((t: PassthroughTarget | null) => applySession({ passthrough: t }), [applySession]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    try {
      localStorage.removeItem(LOG_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const setPassword = useCallback((hex: string) => {
    passwordRef.current = hex;
    setPasswordHex(hex);
  }, []);

  return {
    settings,
    setSettings,
    connected,
    connecting,
    busy,
    unlocked,
    engmodeAt,
    passthrough,
    passwordHex,
    setPassword,
    logs,
    clearLogs,
    addLog,
    connect,
    disconnect,
    run,
    cancel,
    sendRaw,
    subscribeRx,
    setPassthroughManual,
    confirmReq,
    answerConfirm,
  };
}

export type Gateway = ReturnType<typeof useGateway>;
