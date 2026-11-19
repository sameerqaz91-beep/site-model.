// Data files are either embedded by the standalone build (<script id="..." type="application/json">)
// or served next to the page. Both are generated locally and kept out of git.
export async function loadJson<T>(id: string, url: string): Promise<T | null> {
  const inline = document.getElementById(id)?.textContent;
  if (inline) return JSON.parse(inline) as T;
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

// Browser storage can be missing or blocked (private windows, previews); the viewer works without it.
export function readStore<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStore(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the change lasts for this visit only */
  }
}

// A building that is not in the DXF and is placed on the site by the user, e.g. a pump room.
// See facility.example.json for the format.
export interface FacilitySpec {
  name: string;
  source?: string;
  footprint: [number, number]; // metres, width × depth
  height: number;
  sizeNote?: string;
  annex?: { name: string; footprint: [number, number]; height: number };
  equipment: [label: string, value: string][];
  summary?: [label: string, value: string, status?: "ok" | "check" | "fail"][];
  warnings?: string[];
}

export interface Placement {
  x: number; // scene coordinates (metres from the site centre)
  z: number;
  rot: number; // degrees
}
