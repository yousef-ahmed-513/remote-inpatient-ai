// Modular device-integration layer.
//
//   SimulatedDeviceAdapter  — fully operational (drives this demo; all data labelled SIMULATED)
//   BluetoothDeviceAdapter  — capability detection + integration scaffold ONLY. It has not
//                             been tested against any physical device.
//   ExternalAPIAdapter      — documented interface for future vendor cloud APIs. Not connected.
//
// Note: a browser cannot read proprietary smartwatch health stores (Apple HealthKit,
// Health Connect, Wear OS). Those require an authorised companion app, which would feed
// this system through ExternalAPIAdapter.

export type DeviceStatus = { connected: boolean; battery?: number; lastSeenAt?: string | null; detail?: string };
export type VitalReading = { type: string; value: number; value2?: number | null; unit: string; takenAt: string; source: string; quality?: string };

export interface DeviceAdapter {
  id: string;
  name: string;
  deviceType: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<DeviceStatus>;
  getReadings(): Promise<VitalReading[]>;
}

async function call(path: string, body?: unknown) {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

/** Operational adapter backed by the server-side simulator. */
export class SimulatedDeviceAdapter implements DeviceAdapter {
  constructor(
    public id: string,
    public name: string,
    public deviceType: string,
    private patientId: string,
  ) {}
  connect() {
    return call(`/api/patients/${this.patientId}/device`, { deviceId: this.id, status: "CONNECTED" });
  }
  disconnect() {
    return call(`/api/patients/${this.patientId}/device`, { deviceId: this.id, status: "DISCONNECTED" });
  }
  async getStatus(): Promise<DeviceStatus> {
    const view = await call(`/api/patients/${this.patientId}`);
    const d = (view.devices as { id: string; status: string; battery: number; lastSeenAt: string | null }[]).find((x) => x.id === this.id);
    return { connected: d?.status === "CONNECTED", battery: d?.battery, lastSeenAt: d?.lastSeenAt, detail: "SIMULATED" };
  }
  async getReadings(): Promise<VitalReading[]> {
    const view = await call(`/api/patients/${this.patientId}?window=15`);
    const out: VitalReading[] = [];
    for (const [type, pts] of Object.entries((view.series ?? {}) as Record<string, { t: string; v: number; v2: number | null; src: string }[]>)) {
      for (const p of pts) if (p.src === "SIMULATED_DEVICE") out.push({ type, value: p.v, value2: p.v2, unit: "", takenAt: p.t, source: "SIMULATED_DEVICE" });
    }
    return out;
  }
}

type BluetoothNav = { bluetooth?: { getAvailability?: () => Promise<boolean>; requestDevice?: (o: unknown) => Promise<{ id: string; name?: string; gatt?: { connect: () => Promise<unknown>; disconnect: () => void; connected: boolean } }> } };

/** Human-readable Web Bluetooth capability check for the current browser. */
export async function checkBluetooth(): Promise<string> {
  const bt = (navigator as unknown as BluetoothNav).bluetooth;
  if (!bt) return "Web Bluetooth is not available in this browser.";
  try {
    const ok = bt.getAvailability ? await bt.getAvailability() : true;
    return ok ? "Web Bluetooth is available here. Pairing with real devices is scaffolded but untested." : "Web Bluetooth is supported, but no Bluetooth radio is available.";
  } catch {
    return "Web Bluetooth is present but blocked by browser policy.";
  }
}

/**
 * SCAFFOLD — untested against physical hardware. Shows where a standard BLE GATT device
 * (Heart Rate 0x180D, Pulse Oximeter 0x1822, Blood Pressure 0x1810, Health Thermometer
 * 0x1809) would be paired and read. getReadings() intentionally returns nothing until a
 * real device profile has been implemented and verified.
 */
export class BluetoothDeviceAdapter implements DeviceAdapter {
  id = "bluetooth-unpaired";
  name = "Bluetooth device (unpaired)";
  private device: Awaited<ReturnType<NonNullable<NonNullable<BluetoothNav["bluetooth"]>["requestDevice"]>>> | null = null;
  constructor(
    public deviceType: string,
    private services: (number | string)[] = [0x180d, 0x1822, 0x1810, 0x1809],
  ) {}
  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!(navigator as unknown as BluetoothNav).bluetooth?.requestDevice;
  }
  async connect() {
    const bt = (navigator as unknown as BluetoothNav).bluetooth;
    if (!bt?.requestDevice) throw new Error("Web Bluetooth is not available in this browser");
    this.device = await bt.requestDevice({ filters: this.services.map((s) => ({ services: [s] })) });
    this.id = this.device.id;
    this.name = this.device.name ?? "Bluetooth device";
    await this.device.gatt?.connect();
  }
  async disconnect() {
    this.device?.gatt?.disconnect();
  }
  async getStatus(): Promise<DeviceStatus> {
    return { connected: !!this.device?.gatt?.connected, detail: "UNVERIFIED — scaffold only" };
  }
  async getReadings(): Promise<VitalReading[]> {
    // TODO(hardware): subscribe to characteristic notifications and parse per the GATT spec.
    return [];
  }
}

/** Contract for future vendor / companion-app integrations. Not connected to anything. */
export class ExternalAPIAdapter implements DeviceAdapter {
  constructor(
    public id: string,
    public name: string,
    public deviceType: string,
    private config: { baseUrl: string; getAccessToken: () => Promise<string> },
  ) {}
  async connect(): Promise<void> {
    throw new Error(`ExternalAPIAdapter is not configured (${this.config.baseUrl || "no vendor API"})`);
  }
  async disconnect(): Promise<void> {}
  async getStatus(): Promise<DeviceStatus> {
    return { connected: false, detail: "Not configured" };
  }
  async getReadings(): Promise<VitalReading[]> {
    return [];
  }
}
