// The BLE status connection: owns the Web Bluetooth transport and the last
// decoded snapshot. Independent of useGateway -- BLE and serial are separate
// links, and the BLE page has to work on a phone with no serial port.
//
// Refresh rules (docs/BLE_STATUS_SERVICE.md §4.2): every notification
// re-reads status and identity; a timer re-reads status, because uptime,
// module time and CSQ age move without bumping the change counter.

import { useCallback, useEffect, useRef, useState } from 'react';
import { BleFormatError, BleIdentity, BleStatus, decodeBleCounter, decodeBleIdentity, decodeBleStatus } from '../utils/bleStatus';
import { BleError, BleErrorKind, bleErrorText, BleTransport, isBleSupported } from '../utils/bleTransport';

export const BLE_POLL_S = 5;

/** choosing: browser chooser open; pairing: first protected read (the OS may ask for the passkey). */
export type BlePhase = 'idle' | 'choosing' | 'connecting' | 'pairing' | 'connected';

export interface BleFailure {
  kind: BleErrorKind | 'format';
  /** The browser's own text, shown small under the advice. */
  detail: string;
}

function asFailure(e: unknown): BleFailure {
  if (e instanceof BleFormatError) return { kind: 'format', detail: e.message };
  if (e instanceof BleError) return { kind: e.kind, detail: e.message };
  return { kind: 'read', detail: bleErrorText(e) };
}

export function useBleStatus() {
  const [phase, setPhaseState] = useState<BlePhase>('idle');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [status, setStatus] = useState<BleStatus | null>(null);
  const [statusAt, setStatusAt] = useState<number | null>(null);
  const [identity, setIdentity] = useState<BleIdentity | null>(null);
  const [notifying, setNotifying] = useState(false);
  const [error, setError] = useState<BleFailure | null>(null);
  const [canReconnect, setCanReconnect] = useState(false);

  const trRef = useRef(new BleTransport());
  const phaseRef = useRef<BlePhase>('idle');
  /** Bumped by every connect and disconnect, so an attempt the user abandoned goes quiet. */
  const attemptRef = useRef(0);
  const refreshing = useRef(false);
  const pending = useRef<{ identity: boolean } | null>(null);

  const setPhase = useCallback((p: BlePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const readSnapshot = useCallback(async (withIdentity: boolean) => {
    const tr = trRef.current;
    const s = decodeBleStatus(await tr.readStatus());
    const id = withIdentity ? decodeBleIdentity(await tr.readIdentity()) : null;
    setStatus(s);
    setStatusAt(Date.now());
    if (id) setIdentity(id);
  }, []);

  /** Coalesces: a request while a read is in flight runs once more afterwards, not once per request. */
  const refresh = useCallback(
    async (withIdentity: boolean) => {
      if (refreshing.current) {
        pending.current = { identity: withIdentity || !!pending.current?.identity };
        return;
      }
      refreshing.current = true;
      try {
        let next: { identity: boolean } | null = { identity: withIdentity };
        while (next && phaseRef.current === 'connected') {
          pending.current = null;
          await readSnapshot(next.identity);
          setError((cur) => (cur?.kind === 'read' ? null : cur));
          next = pending.current;
        }
      } catch (e) {
        // A drop is reported by onLost; a one-off read failure keeps the link and the timer retries.
        if (phaseRef.current === 'connected' && trRef.current.connected) setError(asFailure(e));
      } finally {
        refreshing.current = false;
        pending.current = null;
      }
    },
    [readSnapshot],
  );

  const connect = useCallback(
    async (reuseDevice = false) => {
      const tr = trRef.current;
      const attempt = ++attemptRef.current;
      setError(null);
      try {
        if (!reuseDevice || !tr.hasDevice) {
          setPhase('choosing');
          await tr.request();
          setDeviceName(tr.deviceName);
          setStatus(null);
          setStatusAt(null);
          setIdentity(null);
        }
        setPhase('connecting');
        await tr.connect();
        setPhase('pairing');
        // Both characteristics need an authenticated link: this read is what
        // makes the phone show its pairing dialog the first time.
        let first: DataView;
        try {
          first = await tr.readStatus();
        } catch (e) {
          throw new BleError('pairing', e instanceof Error ? e.message : String(e));
        }
        const s = decodeBleStatus(first);
        const id = decodeBleIdentity(await tr.readIdentity());
        setStatus(s);
        setStatusAt(Date.now());
        setIdentity(id);
        let notify = true;
        try {
          await tr.startNotifications();
        } catch {
          notify = false; // the 5 s poll still runs; changes just show up later
        }
        if (attempt !== attemptRef.current) return;
        setNotifying(notify);
        setCanReconnect(true);
        setPhase('connected');
      } catch (e) {
        if (attempt !== attemptRef.current) return;
        tr.disconnect();
        setNotifying(false);
        setCanReconnect(tr.hasDevice);
        setPhase('idle');
        const failure = asFailure(e);
        // Past pairing, a failed read during connect means the link went; no timer will retry it.
        if (failure.kind === 'read' || failure.kind === 'lost') failure.kind = 'connect';
        setError(failure);
      }
    },
    [setPhase],
  );

  const disconnect = useCallback(() => {
    attemptRef.current++;
    trRef.current.disconnect();
    setNotifying(false);
    setError(null);
    setPhase('idle');
  }, [setPhase]);

  useEffect(() => {
    const tr = trRef.current;
    tr.onNotify = (value) => {
      // The payload is only the new change counter; the values come from re-reading.
      try {
        decodeBleCounter(value);
      } catch {
        return;
      }
      void refresh(true);
    };
    tr.onLost = () => {
      // During connect the failing operation reports; only a live link is "lost".
      if (phaseRef.current !== 'connected') return;
      setNotifying(false);
      setPhase('idle');
      setError({ kind: 'lost', detail: 'gattserverdisconnected' });
    };
    return () => {
      tr.onNotify = null;
      tr.onLost = null;
      tr.disconnect();
    };
  }, [refresh, setPhase]);

  useEffect(() => {
    if (phase !== 'connected') return;
    const id = setInterval(() => void refresh(false), BLE_POLL_S * 1000);
    return () => clearInterval(id);
  }, [phase, refresh]);

  return {
    supported: isBleSupported(),
    phase,
    deviceName,
    status,
    statusAt,
    identity,
    notifying,
    error,
    canReconnect,
    connect,
    disconnect,
    refresh,
  };
}

export type BleLink = ReturnType<typeof useBleStatus>;
