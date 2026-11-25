import proj4 from 'proj4';
import polygonClipping from 'polygon-clipping';

export const FED = 4200.833;
export const SAH = FED / 576;

export const UTM36N_PRJ =
  'PROJCS["WGS_1984_UTM_Zone_36N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",33.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

proj4.defs('U36', '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs');

export function toLL(x: number, y: number): [number, number] {
  const res = proj4('U36', 'EPSG:4326', [x, y]);
  return [res[0], res[1]];
}

export interface SurveyPoint {
  key: string;
  id: string;
  x: number;
  y: number;
  z: number;
  sourceGroup: string;
  deleted: boolean;
  autoDeleted: boolean;
}

export interface UserPart {
  id: string;
  name: string;
  pointKeys: string[];
}

export interface ComputedPart {
  id: string;
  name: string;
  pts: SurveyPoint[];
  area: number;
  lp: { x: number; y: number };
  ccw: boolean;
  hasCrossings: boolean;
}

export interface AppliedGISModel {
  parts: ComputedPart[];
  totalArea: number;
  boundaryXY: [number, number][];
  boundaryMeasure: { area: number; lp: { x: number; y: number }; ccw: boolean };
  centerLL: [number, number]; // [lon, lat]
  merged: boolean;
  boundaryLL: [number, number][]; // [lat, lon]
  partsLL: { id: string; name: string; ring: [number, number][]; lp: [number, number] }[];
  usedTH: number;
}

export interface CadExportSettings {
  textHeight: number;
  includePoints: boolean;
  includeDims: boolean;
  includeNorth: boolean;
  includePartNames: boolean;
}

export function letterName(index: number): string {
  let t = '';
  let i = index + 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    t = String.fromCharCode(65 + r) + t;
    i = Math.floor((i - 1) / 26);
  }
  return t;
}

export function hullOf<T extends { x: number; y: number }>(pts: T[]): T[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o: T, a: T, b: T) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: T[] = [];
  const up: T[] = [];
  for (const q of p) {
    while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of [...p].reverse()) {
    while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export function crosses(p: { x: number; y: number }[]): boolean {
  const n = p.length;
  const orient = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = p[i];
      const b = p[(i + 1) % n];
      const c = p[j];
      const d = p[(j + 1) % n];
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return true;
    }
  }
  return false;
}

export function measure(p: { x: number; y: number }[]): { area: number; lp: { x: number; y: number }; ccw: boolean } {
  let A = 0;
  let cx = 0;
  let cy = 0;
  const n = p.length;
  if (!n) return { area: 0, lp: { x: 0, y: 0 }, ccw: true };
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const w = a.x * b.y - b.x * a.y;
    A += w;
    cx += (a.x + b.x) * w;
    cy += (a.y + b.y) * w;
  }
  const area = Math.abs(A / 2);
  const c =
    area > 1e-9
      ? { x: cx / (3 * A), y: cy / (3 * A) }
      : { x: p.reduce((s, q) => s + q.x, 0) / n, y: p.reduce((s, q) => s + q.y, 0) / n };

  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    if ((a.y > c.y) !== (b.y > c.y)) {
      xs.push(a.x + ((c.y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
  }
  xs.sort((a, b) => a - b);
  let best: number | null = null;
  let bw = -1;
  let lp = c;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k] <= c.x && c.x <= xs[k + 1]) {
      best = null;
      break;
    }
    if (xs[k + 1] - xs[k] > bw) {
      bw = xs[k + 1] - xs[k];
      best = (xs[k] + xs[k + 1]) / 2;
    }
  }
  if (best !== null) lp = { x: best, y: c.y };
  return { area, lp, ccw: A > 0 };
}

export function fqs(areaM2: number): string {
  const S = Math.round((areaM2 / SAH) * 100);
  const f = Math.floor(S / 57600);
  const r = S % 57600;
  return `${f}F-${Math.floor(r / 2400)}Q-${((r % 2400) / 100).toFixed(2)}S`;
}

export function detectNearPairs(points: SurveyPoint[], tolerance: number) {
  const active = points.filter((p) => !p.deleted);
  const nearKeys = new Set<string>();
  const pairs: [SurveyPoint, SurveyPoint][] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (Math.hypot(active[i].x - active[j].x, active[i].y - active[j].y) < tolerance) {
        nearKeys.add(active[i].key);
        nearKeys.add(active[j].key);
        pairs.push([active[i], active[j]]);
      }
    }
  }
  return { nearKeys, pairs };
}

export function computeAutoTextHeight(parts: ComputedPart[], overrideTH: number): number {
  if (overrideTH > 0) return overrideTH;
  const all = parts.flatMap((p) => p.pts);
  if (!all.length) return 1;
  const mnx = Math.min(...all.map((q) => q.x));
  const mxx = Math.max(...all.map((q) => q.x));
  const mny = Math.min(...all.map((q) => q.y));
  const mxy = Math.max(...all.map((q) => q.y));
  const raw = Math.max(mxx - mnx, mxy - mny) / 120;
  const nice = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 25, 50];
  return nice.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
}

export function computeAppliedModel(
  points: SurveyPoint[],
  userParts: UserPart[],
  overrideTH = 0,
  useConvexHullPerPart = false
): AppliedGISModel | null {
  const ptMap = new Map(points.map((p) => [p.key, p]));
  const computedParts: ComputedPart[] = [];

  for (const up of userParts) {
    const rawPts = up.pointKeys
      .map((k) => ptMap.get(k))
      .filter((p): p is SurveyPoint => Boolean(p && !p.deleted));
    if (rawPts.length < 3) continue;
    const pts = useConvexHullPerPart ? hullOf(rawPts) : rawPts;
    const m = measure(pts);
    computedParts.push({
      id: up.id,
      name: up.name.trim() || 'Part',
      pts,
      area: m.area,
      lp: m.lp,
      ccw: m.ccw,
      hasCrossings: !useConvexHullPerPart && crosses(pts),
    });
  }

  if (!computedParts.length) return null;

  let boundaryXY: [number, number][] | null = null;
  let merged = false;
  try {
    const clipFn = (polygonClipping as unknown as { union: typeof polygonClipping.union }).union;
    const geoms = computedParts.map((p) => [
      [...p.pts.map((q) => [q.x, q.y] as [number, number]), [p.pts[0].x, p.pts[0].y] as [number, number]],
    ]);
    const u = clipFn(geoms[0], ...geoms.slice(1));
    if (u && u.length === 1 && u[0][0].length >= 4) {
      boundaryXY = u[0][0].slice(0, -1).map(([x, y]) => [x, y]);
      merged = true;
    }
  } catch {
    // fallback below
  }

  if (!boundaryXY) {
    boundaryXY = hullOf(computedParts.flatMap((p) => p.pts)).map((q) => [q.x, q.y]);
  }

  const boundaryMeasure = measure(boundaryXY.map(([x, y]) => ({ x, y })));
  const centerLL = toLL(boundaryMeasure.lp.x, boundaryMeasure.lp.y);
  const toLatLngRing = (ring: [number, number][]): [number, number][] =>
    ring.map(([x, y]) => {
      const q = toLL(x, y);
      return [q[1], q[0]];
    });

  const boundaryLL = toLatLngRing(boundaryXY);
  const partsLL = computedParts.map((p) => {
    const lpLL = toLL(p.lp.x, p.lp.y);
    return {
      id: p.id,
      name: p.name,
      ring: toLatLngRing(p.pts.map((q) => [q.x, q.y])),
      lp: [lpLL[1], lpLL[0]] as [number, number],
    };
  });

  const totalArea = computedParts.reduce((s, p) => s + p.area, 0);
  const usedTH = computeAutoTextHeight(computedParts, overrideTH);

  return {
    parts: computedParts,
    totalArea,
    boundaryXY,
    boundaryMeasure,
    centerLL,
    merged,
    boundaryLL,
    partsLL,
    usedTH,
  };
}

export const SAMPLE_SURVEY_ROWS: (string | number)[][] = [
  ['ID', 'Easting', 'Northing', 'Elevation', 'Code'],
  [1, 300072.5, 3357305.0, 41.52, ''],
  [2, 300084.0, 3357305.0, 41.48, ''],
  [3, 300095.5, 3357305.0, 41.44, ''],
  [4, 300095.5, 3357317.0, 41.46, ''],
  [5, 300084.0, 3357317.0, 41.5, ''],
  [6, 300072.5, 3357317.0, 41.55, ''],
  [7, 300084.08, 3357317.06, 41.51, ''], // intentional near point (within 0.20m of pt 5)
  [8, 300072.5, 3357327.5, 41.58, ''],
  [9, 300084.0, 3357327.5, 41.53, ''],
  [10, 300084.05, 3357305.07, 41.49, ''], // intentional near point (within 0.20m of pt 2)
];
