import { BlePanel } from './components/panels/BlePanel';
import { useBleStatus } from './hooks/useBleStatus';

/** The Bluetooth status page (./ble/): nothing of the Modbus tool, which lives at ./ on its own. */
export default function BleApp() {
  const ble = useBleStatus();
  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <BlePanel ble={ble} />
      </div>
    </div>
  );
}
