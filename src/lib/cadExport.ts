import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  AppliedGISModel,
  CadExportSettings,
  FED,
  UTM36N_PRJ,
  fqs,
  measure,
} from './cadastral';

export function downloadBlob(filename: string, blob: Blob) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const escCad = (t: string) =>
  String(t)
    .replace(/[\\"]/g, '')
    .replace(/[^\x20-\x7e]/g, (c) => '\\\\U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));

const escDxf = (t: string) =>
  String(t)
    .replace(/\\/g, '')
    .replace(/[^\x20-\x7e]/g, (c) => '\\U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));

export function buildScrScript(model: AppliedGISModel, cfg: CadExportSettings): string {
  const { parts, totalArea: tot, usedTH: th } = model;
  const all = parts.flatMap((p) => p.pts);
  if (!all.length) return '';

  const mnx = Math.min(...all.map((q) => q.x));
  const mxx = Math.max(...all.map((q) => q.x));
  const mxy = Math.max(...all.map((q) => q.y));
  const f = (n: number) => n.toFixed(3);
  const o: string[] = [];

  const DV = ['DIMTXT', 'DIMASZ', 'DIMEXO', 'DIMEXE', 'DIMGAP', 'DIMTAD', 'DIMDEC', 'DIMSCALE', 'DIMTIH', 'DIMTOH'];
  const T = (s: string, x: number, y: number, h: number, c: boolean) =>
    o.push(`(gct "${escCad(s)}" ${f(x)} ${f(y)} ${f(h)} ${c ? 'T' : 'nil'})`);
  const L = (n: string, c: number) => ['_M', n, '_C', String(c), n];

  o.push(
    '(setvar "CMDECHO" 0)',
    '(setq gc_os (getvar "OSMODE") gc_ly (getvar "CLAYER") gc_cc (getvar "CECOLOR"))',
    '(setvar "OSMODE" 0)',
    '(defun gct (s x y h c / p) (setq p (list x y 0.0)) (entmake (if c (list (cons 0 "TEXT") (cons 1 s) (cons 10 p) (cons 11 p) (cons 40 h) (cons 72 1) (cons 73 2)) (list (cons 0 "TEXT") (cons 1 s) (cons 10 p) (cons 40 h)))) (princ))',
    '-LAYER',
    ...L('PARCEL_BOUNDARY', 7),
    ...L('PARCEL_POINTS', 7),
    ...L('PARCEL_LABELS', 7),
    ...L('PARCEL_DIMS', 7),
    ...L('NORTH_ARROW', 7),
    ...L('AREA_TABLE', 7),
    '',
    `(setq gc_dv (mapcar 'getvar '(${DV.map((v) => `"${v}"`).join(' ')})))`,
    `(setvar "DIMTXT" ${th})`,
    `(setvar "DIMASZ" ${f(th * 0.8)})`,
    `(setvar "DIMEXO" ${f(th * 0.3)})`,
    `(setvar "DIMEXE" ${f(th * 0.6)})`,
    `(setvar "DIMGAP" ${f(th * 0.3)})`,
    '(setvar "DIMTAD" 1)',
    '(setvar "DIMDEC" 2)',
    '(setvar "DIMSCALE" 1)',
    '(setvar "DIMTIH" 0)',
    '(setvar "DIMTOH" 0)',
    '(setvar "CECOLOR" "BYLAYER")',
    '(setvar "PDMODE" 35)',
    '(setvar "PDSIZE" 1.5)'
  );

  if (cfg.includePoints) {
    o.push('(setvar "CLAYER" "PARCEL_POINTS")');
    const seen = new Set<string>();
    parts.forEach((p) =>
      p.pts.forEach((q) => {
        const k = f(q.x) + f(q.y);
        if (seen.has(k)) return;
        seen.add(k);
        o.push(`_POINT ${f(q.x)},${f(q.y)},${f(q.z)}`);
        T(q.id, q.x + th * 0.4, q.y + th * 0.4, th * 0.8, false);
      })
    );
  }

  o.push('(setvar "CLAYER" "PARCEL_BOUNDARY")');
  parts.forEach((p) => {
    o.push('_PLINE');
    p.pts.forEach((q) => o.push(`${f(q.x)},${f(q.y)}`));
    o.push('C');
  });

  if (cfg.includeDims) {
    o.push('(setvar "CLAYER" "PARCEL_DIMS")');
    const done = new Set<string>();
    parts.forEach((p) =>
      p.pts.forEach((a, i) => {
        const b = p.pts[(i + 1) % p.pts.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const k = [f(a.x) + f(a.y), f(b.x) + f(b.y)].sort().join('|');
        if (len < 0.05 || done.has(k)) return;
        done.add(k);
        const s = p.ccw ? 1 : -1;
        const nx = (s * (b.y - a.y)) / len;
        const ny = (-s * (b.x - a.x)) / len;
        o.push(
          '_DIMALIGNED',
          `${f(a.x)},${f(a.y)}`,
          `${f(b.x)},${f(b.y)}`,
          `${f((a.x + b.x) / 2 + nx * 2 * th)},${f((a.y + b.y) / 2 + ny * 2 * th)}`
        );
      })
    );
  }

  o.push('(setvar "CLAYER" "PARCEL_LABELS")');
  parts.forEach((p) => {
    if (cfg.includePartNames) T(p.name, p.lp.x, p.lp.y + th * 1.5, th * 1.3, true);
    T(`${p.area.toFixed(2)} m2`, p.lp.x, p.lp.y, th, true);
    T(`${(p.area / FED).toFixed(5)} Fed`, p.lp.x, p.lp.y - th * 1.5, th, true);
  });

  o.push('(setvar "CLAYER" "AREA_TABLE")');
  const data: string[][] = [['No.', 'Part code', 'Area (m2)', 'Area (Feddan)', 'F-Q-S']];
  parts.forEach((p, i) =>
    data.push([String(i + 1), p.name, p.area.toFixed(2), (p.area / FED).toFixed(5), fqs(p.area)])
  );
  data.push(['', 'TOTAL', tot.toFixed(2), (tot / FED).toFixed(5), fqs(tot)]);
  const w = data[0].map((_, c) => Math.max(...data.map((r) => r[c].length)) * 0.9 * th + 2 * th);
  const rh = 2.4 * th;
  const x0 = mxx + 10 * th;
  const y0 = mxy;
  const W = w.reduce((a, b) => a + b, 0);
  const H = rh * data.length;
  const xs = [x0];
  w.forEach((v) => xs.push(xs[xs.length - 1] + v));
  T('AREA STATEMENT', x0, y0 + th * 1.5, th * 1.5, false);
  o.push('_RECTANG', `${f(x0)},${f(y0)}`, `${f(x0 + W)},${f(y0 - H)}`);
  for (let r = 1; r < data.length; r++) o.push('_LINE', `${f(x0)},${f(y0 - r * rh)}`, `${f(x0 + W)},${f(y0 - r * rh)}`, '');
  for (let c = 1; c < w.length; c++) o.push('_LINE', `${f(xs[c])},${f(y0)}`, `${f(xs[c])},${f(y0 - H)}`, '');
  data.forEach((r, i) =>
    r.forEach((t, c) => {
      if (t) T(t, (xs[c] + xs[c + 1]) / 2, y0 - (i + 0.5) * rh, th, true);
    })
  );

  if (cfg.includeNorth) {
    o.push('(setvar "CLAYER" "NORTH_ARROW")');
    const S = 8 * th;
    const bx = mnx - 10 * th;
    const by = mxy - S;
    const P = (x: number, y: number) => `${f(x)},${f(y)}`;
    o.push(
      '_PLINE',
      P(bx, by + S),
      P(bx - S * 0.25, by),
      P(bx, by + S * 0.25),
      P(bx + S * 0.25, by),
      'C',
      '_SOLID',
      P(bx, by + S),
      P(bx - S * 0.25, by),
      P(bx, by + S * 0.25),
      '',
      ''
    );
    T('N', bx, by + S + 1.5 * th, 1.5 * th, true);
  }

  o.push(
    `(mapcar 'setvar '(${DV.map((v) => `"${v}"`).join(' ')}) gc_dv)`,
    '(setvar "CLAYER" gc_ly)',
    '(setvar "CECOLOR" gc_cc)',
    '(setvar "OSMODE" gc_os)',
    '(setvar "CMDECHO" 1)',
    '_ZOOM',
    '_E'
  );
  return o.join('\n') + '\n';
}

export function buildDxfContent(model: AppliedGISModel, cfg: CadExportSettings): string {
  const { parts, totalArea: tot, usedTH: th } = model;
  const all = parts.flatMap((p) => p.pts);
  if (!all.length) return '';

  const f = (n: number) => n.toFixed(3);
  const o: (string | number)[] = [];
  const BL: (string | number)[] = [];
  let nd = 0;
  const g = (c: number, v: string | number) => o.push(c, v);
  const LY = ['PARCEL_BOUNDARY', 'PARCEL_POINTS', 'PARCEL_LABELS', 'PARCEL_DIMS', 'NORTH_ARROW', 'AREA_TABLE'];

  const TXT = (s: string, x: number, y: number, h: number, l: string, ctr?: boolean, rot?: number) => {
    g(0, 'TEXT');
    g(8, l);
    g(10, f(x));
    g(20, f(y));
    g(30, 0);
    g(40, f(h));
    g(1, escDxf(s));
    if (rot) g(50, rot.toFixed(3));
    if (ctr) {
      g(72, 1);
      g(11, f(x));
      g(21, f(y));
      g(31, 0);
      g(73, 2);
    }
  };
  const LINE = (a: number, b: number, c: number, d: number, l: string) => {
    g(0, 'LINE');
    g(8, l);
    g(10, f(a));
    g(20, f(b));
    g(30, 0);
    g(11, f(c));
    g(21, f(d));
    g(31, 0);
  };
  const PL = (pts: [number, number][], l: string) => {
    g(0, 'POLYLINE');
    g(8, l);
    g(66, 1);
    g(70, 1);
    pts.forEach(([x, y]) => {
      g(0, 'VERTEX');
      g(8, l);
      g(10, f(x));
      g(20, f(y));
      g(30, 0);
    });
    g(0, 'SEQEND');
    g(8, l);
  };

  if (cfg.includePoints) {
    const seen = new Set<string>();
    parts.forEach((p) =>
      p.pts.forEach((q) => {
        const k = f(q.x) + f(q.y);
        if (seen.has(k)) return;
        seen.add(k);
        g(0, 'POINT');
        g(8, 'PARCEL_POINTS');
        g(10, f(q.x));
        g(20, f(q.y));
        g(30, f(q.z));
        TXT(q.id, q.x + th * 0.4, q.y + th * 0.4, th * 0.8, 'PARCEL_POINTS');
      })
    );
  }

  parts.forEach((p) => PL(p.pts.map((q) => [q.x, q.y]), 'PARCEL_BOUNDARY'));

  if (cfg.includeDims) {
    const done = new Set<string>();
    const asz = 0.8 * th;
    parts.forEach((p) =>
      p.pts.forEach((a, i) => {
        const b = p.pts[(i + 1) % p.pts.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const k = [f(a.x) + f(a.y), f(b.x) + f(b.y)].sort().join('|');
        if (L < 0.05 || done.has(k)) return;
        done.add(k);
        const sg = p.ccw ? 1 : -1;
        const nx = (sg * (b.y - a.y)) / L;
        const ny = (-sg * (b.x - a.x)) / L;
        const ux = (b.x - a.x) / L;
        const uy = (b.y - a.y) / L;
        const off = 2 * th;
        const A: [number, number] = [a.x + nx * off, a.y + ny * off];
        const B: [number, number] = [b.x + nx * off, b.y + ny * off];
        const nm = '*D' + ++nd;
        const s0 = o.length;
        LINE(a.x + nx * 0.3 * th, a.y + ny * 0.3 * th, A[0] + nx * 0.6 * th, A[1] + ny * 0.6 * th, 'PARCEL_DIMS');
        LINE(b.x + nx * 0.3 * th, b.y + ny * 0.3 * th, B[0] + nx * 0.6 * th, B[1] + ny * 0.6 * th, 'PARCEL_DIMS');
        LINE(A[0], A[1], B[0], B[1], 'PARCEL_DIMS');
        (
          [
            [A, 1],
            [B, -1],
          ] as const
        ).forEach(([T, d]) => {
          const cx = T[0] + ux * d * asz;
          const cy = T[1] + uy * d * asz;
          const w = asz / 6;
          const v: [number, number][] = [
            [T[0], T[1]],
            [cx + nx * w, cy + ny * w],
            [cx - nx * w, cy - ny * w],
            [cx - nx * w, cy - ny * w],
          ];
          g(0, 'SOLID');
          g(8, 'PARCEL_DIMS');
          v.forEach(([x, y], q) => {
            g(10 + q, f(x));
            g(20 + q, f(y));
            g(30 + q, 0);
          });
        });
        let r = Math.atan2(b.y - a.y, b.x - a.x);
        if (r > Math.PI / 2 || r <= -Math.PI / 2) r += Math.PI;
        const tx = (A[0] + B[0]) / 2 - Math.sin(r) * (0.3 * th + th / 2);
        const ty = (A[1] + B[1]) / 2 + Math.cos(r) * (0.3 * th + th / 2);
        TXT(L.toFixed(2), tx, ty, th, 'PARCEL_DIMS', true, (r * 180) / Math.PI);
        const blk = o.splice(s0);
        BL.push(0, 'BLOCK', 8, 'PARCEL_DIMS', 2, nm, 70, 1, 10, 0, 20, 0, 30, 0, 3, nm, ...blk, 0, 'ENDBLK', 8, 'PARCEL_DIMS');
        g(0, 'DIMENSION');
        g(8, 'PARCEL_DIMS');
        g(2, nm);
        g(10, f(B[0]));
        g(20, f(B[1]));
        g(30, 0);
        g(11, f(tx));
        g(21, f(ty));
        g(31, 0);
        g(70, 1);
        g(3, 'STANDARD');
        g(13, f(a.x));
        g(23, f(a.y));
        g(33, 0);
        g(14, f(b.x));
        g(24, f(b.y));
        g(34, 0);
      })
    );
  }

  parts.forEach((p) => {
    if (cfg.includePartNames) TXT(p.name, p.lp.x, p.lp.y + th * 1.5, th * 1.3, 'PARCEL_LABELS', true);
    TXT(`${p.area.toFixed(2)} m2`, p.lp.x, p.lp.y, th, 'PARCEL_LABELS', true);
    TXT(`${(p.area / FED).toFixed(5)} Fed`, p.lp.x, p.lp.y - th * 1.5, th, 'PARCEL_LABELS', true);
  });

  const data: string[][] = [['No.', 'Part code', 'Area (m2)', 'Area (Feddan)', 'F-Q-S']];
  parts.forEach((p, i) =>
    data.push([String(i + 1), p.name, p.area.toFixed(2), (p.area / FED).toFixed(5), fqs(p.area)])
  );
  data.push(['', 'TOTAL', tot.toFixed(2), (tot / FED).toFixed(5), fqs(tot)]);
  const w = data[0].map((_, c) => Math.max(...data.map((r) => r[c].length)) * 0.9 * th + 2 * th);
  const rh = 2.4 * th;
  const x0 = Math.max(...all.map((q) => q.x)) + 10 * th;
  const y0 = Math.max(...all.map((q) => q.y));
  const W = w.reduce((a, b) => a + b, 0);
  const H = rh * data.length;
  const xs = [x0];
  w.forEach((v) => xs.push(xs[xs.length - 1] + v));
  TXT('AREA STATEMENT', x0, y0 + th * 1.5, th * 1.5, 'AREA_TABLE');
  PL(
    [
      [x0, y0],
      [x0 + W, y0],
      [x0 + W, y0 - H],
      [x0, y0 - H],
    ],
    'AREA_TABLE'
  );
  for (let r = 1; r < data.length; r++) LINE(x0, y0 - r * rh, x0 + W, y0 - r * rh, 'AREA_TABLE');
  for (let c = 1; c < w.length; c++) LINE(xs[c], y0, xs[c], y0 - H, 'AREA_TABLE');
  data.forEach((r, i) =>
    r.forEach((t, c) => {
      if (t) TXT(t, (xs[c] + xs[c + 1]) / 2, y0 - (i + 0.5) * rh, th, 'AREA_TABLE', true);
    })
  );

  if (cfg.includeNorth) {
    const S = 8 * th;
    const bx = Math.min(...all.map((q) => q.x)) - 10 * th;
    const by = Math.max(...all.map((q) => q.y)) - S;
    PL(
      [
        [bx, by + S],
        [bx - S * 0.25, by],
        [bx, by + S * 0.25],
        [bx + S * 0.25, by],
      ],
      'NORTH_ARROW'
    );
    TXT('N', bx, by + S + 1.5 * th, 1.5 * th, 'NORTH_ARROW', true);
  }

  const hd: (string | number)[] = [
    0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$PDMODE', 70, 35, 9, '$PDSIZE', 40, 1.5,
    9, '$DIMTXT', 40, f(th), 9, '$DIMASZ', 40, f(th * 0.8), 9, '$DIMEXO', 40, f(th * 0.3),
    9, '$DIMEXE', 40, f(th * 0.6), 9, '$DIMGAP', 40, f(th * 0.3), 9, '$DIMTAD', 70, 1,
    9, '$DIMDEC', 70, 2, 9, '$DIMSCALE', 40, 1, 9, '$DIMTIH', 70, 0, 9, '$DIMTOH', 70, 0,
    0, 'ENDSEC', 0, 'SECTION', 2, 'TABLES',
    0, 'TABLE', 2, 'LTYPE', 70, 1, 0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0, 0, 'ENDTAB',
    0, 'TABLE', 2, 'LAYER', 70, LY.length, ...LY.flatMap((n) => [0, 'LAYER', 2, n, 70, 0, 62, 7, 6, 'CONTINUOUS']), 0, 'ENDTAB',
    0, 'TABLE', 2, 'STYLE', 70, 1, 0, 'STYLE', 2, 'STANDARD', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, th, 3, 'arial.ttf', 4, '', 0, 'ENDTAB',
    0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS', ...BL, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  ];
  return [...hd, ...o, 0, 'ENDSEC', 0, 'EOF'].join('\n') + '\n';
}

const xmlEsc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildKmlContent(model: AppliedGISModel): string {
  const ring = model.boundaryLL
    .concat([model.boundaryLL[0]])
    .map(([la, lo]) => `${lo.toFixed(8)},${la.toFixed(8)},0`)
    .join(' ');
  const nm = `${model.centerLL[1].toFixed(6)}, ${model.centerLL[0].toFixed(6)}`;
  const partPlacemarks = model.partsLL
    .map((p) => {
      const pr = p.ring
        .concat([p.ring[0]])
        .map(([la, lo]) => `${lo.toFixed(8)},${la.toFixed(8)},0`)
        .join(' ');
      return `<Placemark><name>${xmlEsc(p.name)}</name><styleUrl>#p</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${pr}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Boundary &amp; Parts</name>
<Style id="b"><LineStyle><color>ff00ffff</color><width>3</width></LineStyle><PolyStyle><color>3300ffff</color></PolyStyle></Style>
<Style id="p"><LineStyle><color>ffffee22</color><width>2</width></LineStyle><PolyStyle><color>22ffee22</color></PolyStyle></Style>
<Placemark><name>Boundary</name><styleUrl>#b</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
${partPlacemarks}
<Placemark><name>${nm}</name><Point><coordinates>${model.centerLL[0].toFixed(6)},${model.centerLL[1].toFixed(6)},0</coordinates></Point></Placemark></Document></kml>`;
}

// ---- Minimal shapefile writer (type 1 = point, 5 = polygon) ----
const utf8Enc = new TextEncoder();
interface ShpField {
  n: string;
  t: 'C' | 'N';
  l: number;
  d?: number;
}

function buildShapefileBuffers(
  type: 1 | 5,
  geoms: ([number, number] | [number, number][][])[],
  fields: ShpField[],
  rows: (string | number)[][]
) {
  const recs = geoms.map((g) => {
    if (type === 1) {
      const pt = g as [number, number];
      const b = new DataView(new ArrayBuffer(20));
      b.setInt32(0, 1, true);
      b.setFloat64(4, pt[0], true);
      b.setFloat64(12, pt[1], true);
      return b;
    }
    const rings = g as [number, number][][];
    const pts = rings.flat();
    const n = pts.length;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const b = new DataView(new ArrayBuffer(44 + 4 * rings.length + 16 * n));
    b.setInt32(0, 5, true);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) =>
      b.setFloat64(4 + 8 * i, v, true)
    );
    b.setInt32(36, rings.length, true);
    b.setInt32(40, n, true);
    let off = 0;
    rings.forEach((r, i) => {
      b.setInt32(44 + 4 * i, off, true);
      off += r.length;
    });
    pts.forEach((q, i) => {
      b.setFloat64(44 + 4 * rings.length + 16 * i, q[0], true);
      b.setFloat64(52 + 4 * rings.length + 16 * i, q[1], true);
    });
    return b;
  });

  const pp = geoms.flatMap((g) => (type === 1 ? [g as [number, number]] : (g as [number, number][][]).flat()));
  const bx = [
    Math.min(...pp.map((q) => q[0])),
    Math.min(...pp.map((q) => q[1])),
    Math.max(...pp.map((q) => q[0])),
    Math.max(...pp.map((q) => q[1])),
  ];
  const mk = (len: number) => {
    const a = new Uint8Array(len);
    const d = new DataView(a.buffer);
    d.setInt32(0, 9994);
    d.setInt32(24, len / 2);
    d.setInt32(28, 1000, true);
    d.setInt32(32, type, true);
    bx.forEach((v, i) => d.setFloat64(36 + 8 * i, v, true));
    return a;
  };
  const shp = mk(100 + recs.reduce((a, r) => a + 8 + r.byteLength, 0));
  const shx = mk(100 + 8 * recs.length);
  let off = 100;
  recs.forEach((r, i) => {
    const h = new DataView(shp.buffer, off, 8);
    h.setInt32(0, i + 1);
    h.setInt32(4, r.byteLength / 2);
    shp.set(new Uint8Array(r.buffer), off + 8);
    const x = new DataView(shx.buffer, 100 + 8 * i, 8);
    x.setInt32(0, off / 2);
    x.setInt32(4, r.byteLength / 2);
    off += 8 + r.byteLength;
  });

  const rl = 1 + fields.reduce((a, f) => a + f.l, 0);
  const hl = 33 + 32 * fields.length;
  const dbf = new Uint8Array(hl + rl * rows.length + 1);
  const dv = new DataView(dbf.buffer);
  const d = new Date();
  dbf[0] = 3;
  dbf[1] = d.getFullYear() - 1900;
  dbf[2] = d.getMonth() + 1;
  dbf[3] = d.getDate();
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, hl, true);
  dv.setUint16(10, rl, true);
  fields.forEach((f, i) => {
    dbf.set(utf8Enc.encode(f.n).slice(0, 10), 32 + 32 * i);
    dbf[43 + 32 * i] = f.t.charCodeAt(0);
    dbf[48 + 32 * i] = f.l;
    dbf[49 + 32 * i] = f.d || 0;
  });
  dbf[32 + 32 * fields.length] = 13;
  rows.forEach((r, j) => {
    let o = hl + rl * j;
    dbf[o++] = 32;
    fields.forEach((f, i) => {
      const b = utf8Enc
        .encode(f.t === 'N' ? Number(r[i]).toFixed(f.d || 0).padStart(f.l) : String(r[i]))
        .slice(0, f.l);
      dbf.fill(32, o, o + f.l);
      dbf.set(b, o);
      o += f.l;
    });
  });
  dbf[dbf.length - 1] = 26;
  return { shp, shx, dbf };
}

const cwRing = (ring: [number, number][]) => {
  const r = ring.slice();
  if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0]);
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a > 0 ? r.reverse() : r;
};

export async function exportShapefileZip(model: AppliedGISModel, which: 'all' | 'rasm') {
  const z = new JSZip();
  const add = (n: string, o: { shp: Uint8Array; shx: Uint8Array; dbf: Uint8Array }) => {
    z.file(n + '.shp', o.shp);
    z.file(n + '.shx', o.shx);
    z.file(n + '.dbf', o.dbf);
    z.file(n + '.prj', UTM36N_PRJ);
    z.file(n + '.cpg', 'UTF-8');
  };
  const polyF: ShpField[] = [
    { n: 'Name', t: 'C', l: 40 },
    { n: 'Type', t: 'C', l: 10 },
    { n: 'Area_m2', t: 'N', l: 18, d: 3 },
    { n: 'Area_Fed', t: 'N', l: 14, d: 5 },
  ];
  const bRow: (string | number)[] = ['Total boundary', 'Boundary', model.boundaryMeasure.area, model.boundaryMeasure.area / FED];

  if (which === 'rasm') {
    add('export rasm elkhareta', buildShapefileBuffers(5, [[cwRing(model.boundaryXY)]], polyF, [bRow]));
    downloadBlob('export rasm elkhareta.zip', await z.generateAsync({ type: 'blob' }));
    return;
  }

  const seen = new Set<string>();
  const pr: [string, number, number, string][] = [];
  model.parts.forEach((p) =>
    p.pts.forEach((q) => {
      const k = q.x + ',' + q.y;
      if (!seen.has(k)) {
        seen.add(k);
        pr.push([q.id || '', q.x, q.y, p.name]);
      }
    })
  );

  add(
    'coordinates',
    buildShapefileBuffers(
      1,
      pr.map((r) => [r[1], r[2]]),
      [
        { n: 'Point_ID', t: 'C', l: 20 },
        { n: 'X_UTM36N', t: 'N', l: 18, d: 3 },
        { n: 'Y_UTM36N', t: 'N', l: 18, d: 3 },
        { n: 'Part', t: 'C', l: 40 },
      ],
      pr
    )
  );

  add(
    'building_or_land',
    buildShapefileBuffers(
      5,
      model.parts.map((p) => [cwRing(p.pts.map((q) => [q.x, q.y]))]).concat([[cwRing(model.boundaryXY)]]),
      polyF,
      model.parts.map((p) => [p.name, 'Part', p.area, p.area / FED] as (string | number)[]).concat([bRow])
    )
  );

  downloadBlob('shapefile_coordinates_building_or_land.zip', await z.generateAsync({ type: 'blob' }));
}

export function drawNorthArrow(c: CanvasRenderingContext2D, x: number, y: number, s: number, col: string) {
  c.strokeStyle = c.fillStyle = col;
  c.lineWidth = Math.max(1.5, s / 25);
  c.beginPath();
  c.moveTo(x, y - s);
  c.lineTo(x - s * 0.25, y);
  c.lineTo(x, y - s * 0.25);
  c.lineTo(x + s * 0.25, y);
  c.closePath();
  c.stroke();
  c.beginPath();
  c.moveTo(x, y - s);
  c.lineTo(x - s * 0.25, y);
  c.lineTo(x, y - s * 0.25);
  c.closePath();
  c.fill();
  c.font = `bold ${s * 0.32}px Arial`;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.fillText('N', x, y - s - s * 0.08);
}

export interface CanvasPaintOptions {
  names: boolean;
  dims: boolean;
  pts: boolean;
  areas: boolean;
  north: boolean;
  dark: boolean;
  scale?: boolean;
  k: number;
  m: number;
  lw: number;
  dot: number;
  nf: number;
  idf: number;
  af: number;
  df: number;
  off: number;
  arrow: [number, number, number];
}

export interface CanvasView {
  s: number;
  ox: number;
  oy: number;
}

export function paintCadCanvas(
  cv: HTMLCanvasElement,
  model: AppliedGISModel,
  W: number,
  H: number,
  o: CanvasPaintOptions,
  view: CanvasView | null
): CanvasView | null {
  const { parts } = model;
  if (!parts.length) return null;
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return null;

  const fg = o.dark ? '#e5e7eb' : '#000000';
  const bg = o.dark ? '#0b0f17' : '#ffffff';
  const dc = o.dark ? '#4ade80' : '#0e7490';
  const k = o.k;

  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);

  const all = parts.flatMap((p) => p.pts);
  const mnx = Math.min(...all.map((q) => q.x));
  const mxx = Math.max(...all.map((q) => q.x));
  const mny = Math.min(...all.map((q) => q.y));
  const mxy = Math.max(...all.map((q) => q.y));

  if (!view) {
    const sc = Math.min((W - 2 * o.m) / (mxx - mnx || 1), (H - 2 * o.m) / (mxy - mny || 1));
    view = { s: sc, ox: (W - (mxx - mnx) * sc) / 2, oy: H - (H - (mxy - mny) * sc) / 2 };
  }

  const s = view.s;
  const X = (x: number) => view!.ox + (x - mnx) * s;
  const Y = (y: number) => view!.oy - (y - mny) * s;

  c.strokeStyle = c.fillStyle = fg;
  c.lineWidth = o.lw;
  c.lineJoin = 'round';
  parts.forEach((p) => {
    c.beginPath();
    p.pts.forEach((q, i) => (i ? c.lineTo(X(q.x), Y(q.y)) : c.moveTo(X(q.x), Y(q.y))));
    c.closePath();
    c.stroke();
  });

  if (o.dims) {
    const done = new Set<string>();
    c.strokeStyle = c.fillStyle = dc;
    c.lineWidth = Math.max(1, o.lw * 0.5);
    c.font = `${o.df}px Arial`;
    c.textAlign = 'center';
    parts.forEach((p) =>
      p.pts.forEach((a, i) => {
        const b = p.pts[(i + 1) % p.pts.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const key = [a.x + ',' + a.y, b.x + ',' + b.y].sort().join('|');
        if (L < 0.05 || done.has(key)) return;
        const txt = L.toFixed(2);
        const pl = L * s;
        if (pl < c.measureText(txt).width + 12 * k) return;
        done.add(key);

        const sg = p.ccw ? 1 : -1;
        const nx = (sg * (b.y - a.y)) / L;
        const ny = (sg * (b.x - a.x)) / L;
        const A: [number, number] = [X(a.x), Y(a.y)];
        const B: [number, number] = [X(b.x), Y(b.y)];
        const ux = (B[0] - A[0]) / pl;
        const uy = (B[1] - A[1]) / pl;
        const px = -uy;
        const py = ux;
        const A2: [number, number] = [A[0] + nx * o.off, A[1] + ny * o.off];
        const B2: [number, number] = [B[0] + nx * o.off, B[1] + ny * o.off];
        const g = 3 * k;
        const e = 5 * k;
        const ar = Math.max(9 * k, o.df * 0.7);

        c.beginPath();
        [
          [A, A2],
          [B, B2],
        ].forEach(([P, Q]) => {
          c.moveTo(P[0] + nx * g, P[1] + ny * g);
          c.lineTo(Q[0] + nx * e, Q[1] + ny * e);
        });
        c.moveTo(A2[0], A2[1]);
        c.lineTo(B2[0], B2[1]);
        c.stroke();

        (
          [
            [A2, 1],
            [B2, -1],
          ] as const
        ).forEach(([T, d]) => {
          c.beginPath();
          c.moveTo(T[0], T[1]);
          c.lineTo(T[0] + ux * d * ar + (px * ar) / 3, T[1] + uy * d * ar + (py * ar) / 3);
          c.lineTo(T[0] + ux * d * ar - (px * ar) / 3, T[1] + uy * d * ar - (py * ar) / 3);
          c.closePath();
          c.fill();
        });

        let ang = Math.atan2(uy, ux);
        if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI;
        const up = [Math.sin(ang), -Math.cos(ang)];
        const out = up[0] * nx + up[1] * ny > 0;
        c.save();
        c.translate((A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2);
        c.rotate(ang);
        c.textBaseline = out ? 'bottom' : 'top';
        c.fillText(txt, 0, out ? -3 * k : 3 * k);
        c.restore();
      })
    );
    c.strokeStyle = c.fillStyle = fg;
    c.lineWidth = o.lw;
  }

  c.textAlign = 'center';
  c.textBaseline = 'middle';
  parts.forEach((p) => {
    const x = X(p.lp.x);
    const y = Y(p.lp.y);
    if (o.names) {
      c.font = `bold ${o.nf}px Arial`;
      c.fillText(p.name, x, y);
    }
    if (o.areas) {
      c.font = `${o.af}px Arial`;
      c.fillText(p.area.toFixed(2) + ' m²', x, y + (o.names ? o.nf * 1.1 : 0));
    }
  });

  if (o.pts) {
    c.font = `${o.idf}px Arial`;
    c.textAlign = 'left';
    c.textBaseline = 'bottom';
    const seen = new Set<string>();
    parts.forEach((p) =>
      p.pts.forEach((q) => {
        const kk = q.x + ',' + q.y;
        if (seen.has(kk)) return;
        seen.add(kk);
        c.beginPath();
        c.arc(X(q.x), Y(q.y), o.dot, 0, 7);
        c.fill();
        c.fillText(q.id, X(q.x) + 8 * k, Y(q.y) - 6 * k);
      })
    );
  }

  if (o.north) drawNorthArrow(c, o.arrow[0], o.arrow[1], o.arrow[2], fg);
  if (o.scale) {
    const d = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((v) => v * s >= 110 * k) || 5000;
    const bl = d * s;
    const x0 = 24 * k;
    const y0 = H - 34 * k;
    c.strokeStyle = c.fillStyle = fg;
    c.lineWidth = 2 * k;
    c.beginPath();
    c.moveTo(x0, y0 - 6 * k);
    c.lineTo(x0, y0);
    c.lineTo(x0 + bl, y0);
    c.lineTo(x0 + bl, y0 - 6 * k);
    c.stroke();
    c.font = `${12 * k}px Arial`;
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillText(d + ' m', x0 + bl / 2, y0 - 6 * k);
    c.textAlign = 'right';
    c.textBaseline = 'alphabetic';
    c.fillText('UTM WGS84 zone 36N · dimensions in m', W - 14 * k, H - 12 * k);
  }

  return view;
}

const loadTile = (urls: string[]) =>
  new Promise<{ im: HTMLImageElement; src: number } | null>((res) => {
    let i = 0;
    const nx = () => {
      if (i >= urls.length) return res(null);
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res({ im, src: i });
      im.onerror = () => {
        i++;
        nx();
      };
      im.src = urls[i];
    };
    nx();
  });

export async function renderSatelliteCanvas(
  cv: HTMLCanvasElement,
  model: AppliedGISModel,
  zoomOverride: number,
  showIds: boolean,
  isCancelled: () => boolean
): Promise<string> {
  const W = 800;
  const H = 600;
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return '';

  const all = [...model.boundaryLL, ...model.partsLL.flatMap((p) => p.ring)];
  const WP = (la: number, lo: number, z: number): [number, number] => {
    const s = 256 * 2 ** z;
    const sn = Math.sin((la * Math.PI) / 180);
    return [((lo + 180) / 360) * s, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * s];
  };
  const ext = (z: number) => {
    const p = all.map(([la, lo]) => WP(la, lo, z));
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };

  let z = zoomOverride || 0;
  if (!z) {
    for (z = 20; z > 1; z--) {
      const e = ext(z);
      if (e[2] - e[0] <= W * 0.8 && e[3] - e[1] <= H * 0.8) break;
    }
  }
  const e = ext(z);
  const left = Math.round((e[0] + e[2]) / 2 - W / 2);
  const top = Math.round((e[1] + e[3]) / 2 - H / 2);
  const n = 2 ** z;
  c.fillStyle = '#182030';
  c.fillRect(0, 0, W, H);

  let fb = 0;
  let miss = 0;
  const jobs: Promise<void>[] = [];
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + W - 1) / 256); tx++) {
    for (let ty = Math.floor(top / 256); ty <= Math.floor((top + H - 1) / 256); ty++) {
      const X = ((tx % n) + n) % n;
      if (ty < 0 || ty >= n) continue;
      jobs.push(
        loadTile([
          `https://mt${(X + ty) & 3}.google.com/vt/lyrs=s&x=${X}&y=${ty}&z=${z}`,
          `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${X}`,
        ]).then((r) => {
          if (isCancelled()) return;
          if (!r) {
            miss++;
            return;
          }
          if (r.src) fb++;
          c.drawImage(r.im, tx * 256 - left, ty * 256 - top);
        })
      );
    }
  }
  await Promise.all(jobs);
  if (isCancelled()) return '';

  const P = ([la, lo]: [number, number]): [number, number] => {
    const q = WP(la, lo, z);
    return [q[0] - left, q[1] - top];
  };
  const poly = (r: [number, number][], col: string, w: number) => {
    c.beginPath();
    r.map(P).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.strokeStyle = col;
    c.lineWidth = w;
    c.stroke();
  };
  const txt = (t: string, x: number, y: number, f: string, al: CanvasTextAlign = 'center') => {
    c.font = f;
    c.textAlign = al;
    c.lineWidth = 3;
    c.strokeStyle = '#000';
    c.strokeText(t, x, y);
    c.fillStyle = '#fff';
    c.fillText(t, x, y);
  };

  model.partsLL.forEach((p) => {
    poly(p.ring, '#22d3ee', 2);
    const [x, y] = P(p.lp);
    txt(p.name, x, y, 'bold 14px Arial');
  });
  poly(model.boundaryLL, '#fbbf24', 3.5);
  model.partsLL.forEach((p, i) =>
    p.ring.forEach((r, j) => {
      const [x, y] = P(r);
      c.beginPath();
      c.arc(x, y, 3, 0, 7);
      c.fillStyle = '#fff';
      c.fill();
      if (showIds) txt(model.parts[i].pts[j].id, x + 5, y - 5, '11px Arial', 'left');
    })
  );

  const mpp = (156543.03392 * Math.cos((model.centerLL[1] * Math.PI) / 180)) / n;
  const d = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((v) => v / mpp >= 90) || 5000;
  const bl = d / mpp;
  c.fillStyle = '#fff';
  c.strokeStyle = '#000';
  c.lineWidth = 1;
  c.fillRect(14, H - 30, bl, 6);
  c.strokeRect(14, H - 30, bl, 6);
  txt(d + ' m', 14 + bl / 2, H - 36, 'bold 12px Arial');
  c.shadowColor = '#000';
  c.shadowBlur = 5;
  drawNorthArrow(c, 45, 95, 60, '#fff');
  c.shadowBlur = 0;
  txt(fb ? 'Imagery © Google / Esri' : 'Imagery © Google', W - 6, H - 6, '11px Arial', 'right');

  return (
    `Zoom ${z} · 800×600 px · ≈${mpp.toFixed(2)} m/pixel` +
    (fb ? ` · Esri fallback used for ${fb} tiles` : '') +
    (miss ? ` · ${miss} tiles failed to load` : '')
  );
}

// ---- Excel/CSV Coordinate Table Extractor (shared by Coordinates tab & Excel->AutoCAD tab) ----
export type CoordRow = [string | number, number, number, number | null, string];

export function extractCoordTable(wb: XLSX.WorkBook): {
  rows: CoordRow[];
  sheet: string;
  zone: string;
  datum: string;
} | null {
  const num = (v: unknown): number | null => {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v === null || v === undefined) return null;
    const s = String(v).trim().replace(/,/g, '');
    if (s === '') return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  };
  const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  const findCol = (row: unknown[], re: RegExp) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== null && row[i] !== undefined && re.test(String(row[i]).trim())) return i;
    }
    return -1;
  };
  const cellAfter = (row: unknown[], re: RegExp) => {
    const i = findCol(row, re);
    if (i < 0) return '';
    for (let j = i + 1; j < row.length; j++) {
      if (row[j] !== null && row[j] !== undefined && String(row[j]).trim() !== '') return String(row[j]).trim();
    }
    return '';
  };

  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    for (let h = 0; h < aoa.length; h++) {
      const hdr = aoa[h] || [];
      const e = findCol(hdr, /east|^x$/i);
      const n = findCol(hdr, /north|^y$/i);
      if (e < 0 || n < 0 || e === n) continue;
      const id = findCol(hdr, /^(id|name|point|point id|point name|pt|no\.?|#)$/i);
      const z = findCol(hdr, /elev|height|^z$|^h$/i);
      const code = findCol(hdr, /code|feature|desc/i);
      const out: CoordRow[] = [];
      for (let k = h + 1; k < aoa.length; k++) {
        const row = aoa[k] || [];
        const E = num(row[e]);
        const N = num(row[n]);
        if (E === null || N === null) break;
        const rawId = id >= 0 && row[id] !== null && row[id] !== undefined ? row[id] : null;
        const parsedId = rawId !== null ? (num(rawId) !== null ? (num(rawId) as number) : String(rawId)) : out.length + 1;
        out.push([
          parsedId,
          r3(E) as number,
          r3(N) as number,
          z >= 0 ? r3(num(row[z])) : null,
          code >= 0 && row[code] !== null && row[code] !== undefined ? String(row[code]) : '',
        ]);
      }
      if (!out.length) continue;
      let zone = '';
      let datum = '';
      for (let m = 0; m < h; m++) {
        if (!zone) zone = cellAfter(aoa[m] || [], /^zone:?$/i);
        if (!datum) datum = cellAfter(aoa[m] || [], /^datum:?$/i);
      }
      return { rows: out, sheet: name, zone, datum };
    }
  }
  return null;
}
