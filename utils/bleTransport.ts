// Web Bluetooth link to the firmware's read-only BLE status service.
//
// The second transport next to serialTransport.ts and independent of it: the
// BLE page has to work on a phone with no serial port at all. This is the
// only code that touches navigator.bluetooth; it hands raw characteristic
// values to the caller and leaves decoding to utils/bleStatus.ts.

import { BLE_IDENTITY_UUID, BLE_SERVICE_UUID, BLE_STATUS_LEN, BLE_STATUS_UUID } from './bleStatus';

/** Where an attempt failed; the page turns each kind into advice. */
export type BleErrorKind =
  | 'unsupported' // no navigator.bluetooth
  | 'cancelled' // chooser closed without a pick (or nothing to pick)
  | 'adapter' // Bluetooth off / no adapter
  | 'security' // insecure context, permission blocked or policy
  | 'connect' // GATT connect failed
  | 'service' // connected, but no status service on it
  | 'pairing' // the first protected read failed
  | 'read' // a later read failed
  | 'lost'; // the link dropped

export class BleError extends Error {
  constructor(
    readonly kind: BleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BleError';
  }
}

export function isBleSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && !!navigator.bluetooth;
}

/** The browser's DOMException as "Name: message" -- the name is what tells cases apart. */
export function bleErrorText(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  return String(e);
}

function classifyRequestError(e: unknown): BleError {
  const name = (e as { name?: string }).name;
  const text = bleErrorText(e);
  if (name === 'NotFoundError') {
    // Chrome uses NotFoundError for a cancelled chooser and for a missing adapter alike.
    if (/cancel/i.test(text)) return new BleError('cancelled', text);
    if (/adapter|turned off|powered off/i.test(text)) return new BleError('adapter', text);
    if (/blocked|disabled|permission/i.test(text)) return new BleError('security', text);
    return new BleError('cancelled', text);
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') return new BleError('security', text);
  return new BleError('connect', text);
}

export class BleTransport {
  private device: BluetoothDevice | null = null;
  private status: BluetoothRemoteGATTCharacteristic | null = null;
  private identity: BluetoothRemoteGATTCharacteristic | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closing = false;

  /** Called when the link drops without disconnect() (out of range, device reboot, bond rejected). */
  onLost: (() => void) | null = null;
  /** A status notification: the value is only the 2-byte change counter. */
  onNotify: ((value: DataView) => void) | null = null;

  get deviceName(): string | null {
    return this.device ? this.device.name || this.device.id : null;
  }

  /** A device was picked earlier, so connect() can run again without the chooser. */
  get hasDevice(): boolean {
    return this.device !== null;
  }

  get connected(): boolean {
    return this.status !== null && !!this.device?.gatt?.connected;
  }

  /** Show the browser's chooser, filtered to devices advertising the status service. Needs a user gesture. */
  async request(): Promise<void> {
    if (!isBleSupported()) throw new BleError('unsupported', 'Web Bluetooth is not available in this browser');
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE_UUID] }] });
    } catch (e) {
      throw classifyRequestError(e);
    }
    this.disconnect();
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.handleDisconnect);
  }

  /**
   * GATT connect and service discovery on the picked device. Nothing here is
   * protected, so pairing does not start yet: the first read does that.
   */
  async connect(): Promise<void> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new BleError('connect', 'no device selected');
    this.closing = false;
    let server: BluetoothRemoteGATTServer;
    try {
      server = await gatt.connect();
    } catch (e) {
      throw new BleError('connect', bleErrorText(e));
    }
    try {
      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      const status = await service.getCharacteristic(BLE_STATUS_UUID);
      const identity = await service.getCharacteristic(BLE_IDENTITY_UUID);
      status.addEventListener('characteristicvaluechanged', this.handleValue);
      this.status = status;
      this.identity = identity;
    } catch (e) {
      this.disconnect();
      throw new BleError('service', bleErrorText(e));
    }
  }

  readStatus(): Promise<DataView> {
    return this.read(() => this.status, 'status');
  }

  readIdentity(): Promise<DataView> {
    return this.read(() => this.identity, 'identity');
  }

  /** Writes the CCC, which is protected too. */
  startNotifications(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.status) throw new BleError('lost', 'not connected');
      try {
        await this.status.startNotifications();
      } catch (e) {
        throw new BleError('read', `notifications: ${bleErrorText(e)}`);
      }
    });
  }

  /** User-initiated: never reported through onLost. The picked device is kept for a reconnect. */
  disconnect(): void {
    this.closing = true;
    this.status?.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.status = null;
    this.identity = null;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  // Android's stack (and Chrome on top of it) refuses a GATT operation while
  // another is in flight, so the poll timer and a notification must queue.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private read(pick: () => BluetoothRemoteGATTCharacteristic | null, what: string): Promise<DataView> {
    return this.exclusive(async () => {
      const ch = pick();
      if (!ch) throw new BleError('lost', 'not connected');
      try {
        return await ch.readValue();
      } catch (e) {
        throw new BleError(this.connected ? 'read' : 'lost', `${what}: ${bleErrorText(e)}`);
      }
    });
  }

  // readValue() also fires characteristicvaluechanged (Web Bluetooth spec), so
  // a status read would look like a notification and trigger another read.
  // A notification is the 2-byte counter; a read is the whole snapshot.
  private handleValue = (ev: Event): void => {
    const value = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (value && value.byteLength < BLE_STATUS_LEN) this.onNotify?.(value);
  };

  private handleDisconnect = (): void => {
    const expected = this.closing;
    this.status?.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.status = null;
    this.identity = null;
    if (!expected) this.onLost?.();
  };
}
