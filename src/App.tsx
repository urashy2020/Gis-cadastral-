import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileCode2,
  FolderArchive,
  Globe2,
  Layers,
  Map as MapIcon,
  Ruler,
  Upload,
} from 'lucide-react';
import {
  AppliedGISModel,
  CadExportSettings,
  FED,
  SAMPLE_SURVEY_ROWS,
  SurveyPoint,
  UserPart,
  computeAppliedModel,
  detectNearPairs,
  fqs,
  letterName,
} from './lib/cadastral';
import {
  CoordRow,
  buildDxfContent,
  buildKmlContent,
  buildScrScript,
  downloadBlob,
  exportShapefileZip,
  paintCadCanvas,
  renderSatelliteCanvas,
} from './lib/cadExport';
import { CadEditorCanvas } from './components/CadEditorCanvas';
import { CadPreviewPanel } from './components/CadPreviewPanel';
import { SatelliteMap } from './components/SatelliteMap';
import { CoordinatesTableTab } from './components/CoordinatesTableTab';
import { ExcelToAutocadTab } from './components/ExcelToAutocadTab';

type TopTab = 'studio' | 'coords' | 'excel2cad';
type OutputViewTab = 'cad_preview' | 'sat_map' | 'images' | 'downloads';

interface EditorSnapshot {
  points: SurveyPoint[];
  userParts: UserPart[];
}

interface HistoryEntry extends EditorSnapshot {
  label: string;
  coalesceKey?: string;
}

interface EditorHistoryState {
  past: HistoryEntry[];
  present: EditorSnapshot;
  future: HistoryEntry[];
}

const MAX_HISTORY = 100;

const DEFAULT_COORD_ROWS: CoordRow[] = [
  [1, 300082.385, 3357311.443, 41.552, 'st.1'],
  [2, 300089.999, 3357314.523, 41.405, 'st.1'],
  [3, 300085.898, 3357322.796, 41.447, 'st.1'],
  [4, 300078.665, 3357319.85, 41.593, 'st.1'],
];

function parsePointsFromRows(
  rawRows: (string | number | null | undefined)[][],
  cols: { id: number; x: number; y: number; z: number; code: number },
  hasHdr: boolean
): { points: SurveyPoint[]; fileParts: UserPart[]; exactDropped: number } {
  const start = hasHdr ? 1 : 0;
  const points: SurveyPoint[] = [];
  const grouped = new Map<string, string[]>();
  let exactDropped = 0;
  let curAuto: string | null = null;
  let autoCount = 0;

  for (let i = start; i < rawRows.length; i++) {
    const r = rawRows[i] || [];
    const x = parseFloat(String(r[cols.x] ?? ''));
    const y = parseFloat(String(r[cols.y] ?? ''));
    if (isNaN(x) || isNaN(y)) {
      if (cols.code < 0) curAuto = null;
      continue;
    }

    let groupName = '';
    if (cols.code >= 0) {
      groupName = r[cols.code] === undefined || r[cols.code] === null ? '' : String(r[cols.code]).trim();
    } else {
      if (!curAuto) curAuto = 'P' + ++autoCount;
      groupName = curAuto;
    }

    // Drop exact identical coordinate duplicates (< 1 mm)
    if (points.some((e) => Math.hypot(x - e.x, y - e.y) < 0.001)) {
      exactDropped++;
      continue;
    }

    const ptId =
      r[cols.id] !== undefined && r[cols.id] !== null && String(r[cols.id]).trim() !== ''
        ? String(r[cols.id]).trim()
        : String(i + 1);
    const zVal = cols.z >= 0 ? parseFloat(String(r[cols.z] ?? '0')) || 0 : 0;
    const key = `pt_${i}_${points.length}`;

    points.push({
      key,
      id: ptId,
      x,
      y,
      z: zVal,
      sourceGroup: groupName || 'P1',
      deleted: false,
      autoDeleted: false,
    });

    const gKey = groupName || 'P1';
    if (!grouped.has(gKey)) grouped.set(gKey, []);
    grouped.get(gKey)!.push(key);
  }

  const fileParts: UserPart[] = [];
  let idx = 0;
  for (const [gName, keys] of grouped.entries()) {
    if (keys.length >= 3) {
      fileParts.push({
        id: `part_${Date.now()}_${idx}`,
        name: cols.code >= 0 ? gName : letterName(idx),
        pointKeys: keys,
      });
      idx++;
    }
  }

  return { points, fileParts, exactDropped };
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const layoutCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const satCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const satTokenRef = useRef(0);

  const [topTab, setTopTab] = useState<TopTab>('studio');
  const [outputTab, setOutputTab] = useState<OutputViewTab>('cad_preview');

  // Raw uploaded file state
  const [rawRows, setRawRows] = useState<(string | number | null | undefined)[][]>(SAMPLE_SURVEY_ROWS);
  const [fileName, setFileName] = useState('بيانات نموذجية (قطعتان + نقطتان متقاربتان)');
  const [mapperOpen, setMapperOpen] = useState(false);

  const [colID, setColID] = useState(0);
  const [colX, setColX] = useState(1);
  const [colY, setColY] = useState(2);
  const [colZ, setColZ] = useState(3);
  const [colCode, setColCode] = useState(-1);
  const [exactDropped, setExactDropped] = useState(0);

  // Studio working state (CAD editor with Undo/Redo history)
  const [history, setHistory] = useState<EditorHistoryState>({
    past: [],
    present: { points: [], userParts: [] },
    future: [],
  });
  const points = history.present.points;
  const userParts = history.present.userParts;
  const [tolerance, setTolerance] = useState(0.2);

  // Applied state (all outputs derive strictly from appliedModel)
  const [appliedPoints, setAppliedPoints] = useState<SurveyPoint[]>([]);
  const [appliedParts, setAppliedParts] = useState<UserPart[]>([]);
  const [cadSettings, setCadSettings] = useState<CadExportSettings>({
    textHeight: 0,
    includePoints: true,
    includeDims: true,
    includeNorth: true,
    includePartNames: true,
  });

  // Satellite 800x600 export options
  const [satZoom, setSatZoom] = useState(0);
  const [satShowIds, setSatShowIds] = useState(false);
  const [satStatus, setSatStatus] = useState('');
  const [scrCopied, setScrCopied] = useState(false);

  // Coordinates & Excel2CAD shared state
  const [coordRows, setCoordRows] = useState<CoordRow[]>(DEFAULT_COORD_ROWS);
  const [coordSourceName, setCoordSourceName] = useState('A-Q17-1708-01-00000222806');

  // Initialize with Sample Data on mount so user can immediately interact with the AutoCAD screen & outputs
  useEffect(() => {
    const parsed = parsePointsFromRows(
      SAMPLE_SURVEY_ROWS,
      { id: 0, x: 1, y: 2, z: 3, code: -1 },
      true
    );
    // Build 2 sample adjacent parts sharing middle edge (pt 2 & pt 5) so user sees multi-part CAD workflow right away
    const pts = parsed.points;
    const initialParts: UserPart[] =
      pts.length >= 9
        ? [
            {
              id: 'sample_a',
              name: 'A',
              pointKeys: [pts[0].key, pts[1].key, pts[4].key, pts[5].key],
            },
            {
              id: 'sample_b',
              name: 'B',
              pointKeys: [pts[1].key, pts[2].key, pts[3].key, pts[4].key],
            },
          ]
        : [];
    setHistory({
      past: [],
      present: { points: pts, userParts: initialParts },
      future: [],
    });
    setAppliedPoints(pts);
    setAppliedParts(initialParts);
    setExactDropped(parsed.exactDropped);
  }, []);

  const rawHasHeader = useMemo(
    () => (rawRows[0] || []).some((h) => typeof h === 'string' && h.trim() !== '' && isNaN(Number(h))),
    [rawRows]
  );

  const columnCount = useMemo(
    () => Math.max(1, ...rawRows.slice(0, 20).map((r) => (r ? r.length : 0))),
    [rawRows]
  );

  const loadWorkbookRows = useCallback(
    (rowsIn: (string | number | null | undefined)[][], label: string, autoSeedParts: boolean) => {
      setRawRows(rowsIn);
      setFileName(label);

      const hdr = (rowsIn[0] || []).some((h) => typeof h === 'string' && h.trim() !== '' && isNaN(Number(h)));
      const n = Math.max(1, ...rowsIn.slice(0, 20).map((r) => (r ? r.length : 0)));
      const s = hdr ? 1 : 0;
      const a = parseFloat(String(rowsIn[s]?.[1] ?? ''));
      const b = parseFloat(String(rowsIn[s]?.[2] ?? ''));

      const nextId = 0;
      const nextX = a > b && a > 1e6 ? 2 : 1;
      const nextY = a > b && a > 1e6 ? 1 : 2;
      const nextZ = n >= 4 ? 3 : -1;
      let nextCode = -1;
      if (hdr) {
        const k = (rowsIn[0] || []).findIndex((t) =>
          /code|part|parcel|plot|build|block|land|name|كود|قطعة|مبنى/i.test(String(t ?? ''))
        );
        if (k > -1) nextCode = k;
      }

      setColID(nextId);
      setColX(nextX);
      setColY(nextY);
      setColZ(nextZ);
      setColCode(nextCode);

      const parsed = parsePointsFromRows(
        rowsIn,
        { id: nextId, x: nextX, y: nextY, z: nextZ, code: nextCode },
        hdr
      );
      // If file has an explicit Part code column and autoSeedParts is true, seed them; otherwise let user connect points on CAD screen
      const seededParts = nextCode >= 0 && autoSeedParts ? parsed.fileParts : [];
      setHistory({
        past: [],
        present: { points: parsed.points, userParts: seededParts },
        future: [],
      });
      setExactDropped(parsed.exactDropped);
      if (seededParts.length > 0) {
        setAppliedPoints(parsed.points);
        setAppliedParts(seededParts);
      } else {
        setAppliedPoints([]);
        setAppliedParts([]);
      }
      setMapperOpen(true);
    },
    []
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const wb = XLSX.read(new Uint8Array(ev.target?.result as ArrayBuffer), { type: 'array' });
      const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(wb.Sheets[wb.SheetNames[0]], {
        header: 1,
        blankrows: true,
      });
      loadWorkbookRows(aoa, file.name, true);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const handleApplyColumnMapping = () => {
    const parsed = parsePointsFromRows(
      rawRows,
      { id: colID, x: colX, y: colY, z: colZ, code: colCode },
      rawHasHeader
    );
    const seeded = colCode >= 0 ? parsed.fileParts : [];
    setHistory({
      past: [],
      present: { points: parsed.points, userParts: seeded },
      future: [],
    });
    setExactDropped(parsed.exactDropped);
    if (seeded.length > 0) {
      setAppliedPoints(parsed.points);
      setAppliedParts(seeded);
    } else {
      setAppliedPoints([]);
      setAppliedParts([]);
    }
    setMapperOpen(false);
  };

  const commitEdit = useCallback(
    (label: string, updater: (prev: EditorSnapshot) => EditorSnapshot | null, coalesceKey?: string) => {
      setHistory((prev) => {
        const next = updater(prev.present);
        if (!next) return prev;
        const lastPast = prev.past[prev.past.length - 1];
        if (coalesceKey && lastPast && lastPast.coalesceKey === coalesceKey) {
          return {
            past: prev.past,
            present: next,
            future: [],
          };
        }
        const nextPast = [
          ...prev.past.slice(-(MAX_HISTORY - 1)),
          { points: prev.present.points, userParts: prev.present.userParts, label, coalesceKey },
        ];
        return {
          past: nextPast,
          present: next,
          future: [],
        };
      });
    },
    []
  );

  const handleUndo = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const previous = prev.past[prev.past.length - 1];
      return {
        past: prev.past.slice(0, -1),
        present: { points: previous.points, userParts: previous.userParts },
        future: [
          { points: prev.present.points, userParts: prev.present.userParts, label: previous.label },
          ...prev.future,
        ],
      };
    });
  }, []);

  const handleRedo = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const next = prev.future[0];
      return {
        past: [
          ...prev.past.slice(-(MAX_HISTORY - 1)),
          { points: prev.present.points, userParts: prev.present.userParts, label: next.label },
        ],
        present: { points: next.points, userParts: next.userParts },
        future: prev.future.slice(1),
      };
    });
  }, []);

  // CAD Editor actions
  const handleToggleDeletePoint = useCallback(
    (key: string) => {
      const target = points.find((p) => p.key === key);
      const actionLabel = target?.deleted ? `استعادة نقطة ${target.id}` : `حذف نقطة ${target?.id ?? ''}`;
      commitEdit(actionLabel, (prev) => ({
        ...prev,
        points: prev.points.map((p) =>
          p.key === key ? { ...p, deleted: !p.deleted, autoDeleted: false } : p
        ),
      }));
    },
    [commitEdit, points]
  );

  const handleDeletePointsBatch = useCallback(
    (keys: string[]) => {
      if (!keys.length) return;
      const set = new Set(keys);
      commitEdit(`حذف ${keys.length} نقاط`, (prev) => {
        const changed = prev.points.some((p) => set.has(p.key) && !p.deleted);
        if (!changed) return null;
        return {
          ...prev,
          points: prev.points.map((p) =>
            set.has(p.key) ? { ...p, deleted: true, autoDeleted: false } : p
          ),
        };
      });
    },
    [commitEdit]
  );

  const handleDeleteAllNear = useCallback(() => {
    commitEdit('حذف النقاط المتقاربة', (prev) => {
      const kept: SurveyPoint[] = [];
      let removedAny = false;
      const nextPoints = prev.points.map((p) => {
        if (p.deleted) return p;
        const isNearExisting = kept.some((k) => Math.hypot(p.x - k.x, p.y - k.y) < tolerance);
        if (isNearExisting) {
          removedAny = true;
          return { ...p, deleted: true, autoDeleted: true };
        }
        kept.push(p);
        return p;
      });
      return removedAny ? { ...prev, points: nextPoints } : null;
    });
  }, [commitEdit, tolerance]);

  const handleRestoreAllDeleted = useCallback(() => {
    commitEdit('استعادة جميع النقاط المحذوفة', (prev) => {
      if (!prev.points.some((p) => p.deleted)) return null;
      return {
        ...prev,
        points: prev.points.map((p) => ({ ...p, deleted: false, autoDeleted: false })),
      };
    });
  }, [commitEdit]);

  const handleAddPart = useCallback(
    (name: string, pointKeys: string[]) => {
      commitEdit(`إنشاء جزء ${name}`, (prev) => ({
        ...prev,
        userParts: [
          ...prev.userParts,
          { id: `part_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name, pointKeys },
        ],
      }));
    },
    [commitEdit]
  );

  const handleRenamePart = useCallback(
    (partId: string, newName: string) => {
      commitEdit(
        'تسمية جزء',
        (prev) => ({
          ...prev,
          userParts: prev.userParts.map((p) => (p.id === partId ? { ...p, name: newName } : p)),
        }),
        `rename:${partId}`
      );
    },
    [commitEdit]
  );

  const handleDeletePart = useCallback(
    (partId: string) => {
      commitEdit('حذف جزء', (prev) => ({
        ...prev,
        userParts: prev.userParts.filter((p) => p.id !== partId),
      }));
    },
    [commitEdit]
  );

  const handleClearAllParts = useCallback(() => {
    commitEdit('مسح جميع الأجزاء', (prev) => (prev.userParts.length ? { ...prev, userParts: [] } : null));
  }, [commitEdit]);

  const handleAutoConnectFromFile = useCallback(() => {
    commitEdit('توصيل تلقائي من ترتيب الملف', (prev) => {
      const parsed = parsePointsFromRows(
        rawRows,
        { id: colID, x: colX, y: colY, z: colZ, code: colCode },
        rawHasHeader
      );
      const activeByGroup = new Map<string, string[]>();
      prev.points.forEach((p) => {
        if (p.deleted) return;
        if (!activeByGroup.has(p.sourceGroup)) activeByGroup.set(p.sourceGroup, []);
        activeByGroup.get(p.sourceGroup)!.push(p.key);
      });
      const autoParts: UserPart[] = [];
      let idx = 0;
      for (const [gName, keys] of activeByGroup.entries()) {
        if (keys.length >= 3) {
          autoParts.push({
            id: `auto_${Date.now()}_${idx}`,
            name: colCode >= 0 ? gName : letterName(idx),
            pointKeys: keys,
          });
          idx++;
        }
      }
      const nextParts = autoParts.length ? autoParts : parsed.fileParts;
      if (!nextParts.length) return null;
      return { ...prev, userParts: nextParts };
    });
  }, [colCode, colID, colX, colY, colZ, commitEdit, rawHasHeader, rawRows]);

  const handleApplyToOutputs = useCallback(() => {
    setAppliedPoints(points.map((p) => ({ ...p })));
    setAppliedParts(userParts.map((up) => ({ ...up, pointKeys: [...up.pointKeys] })));
  }, [points, userParts]);

  const hasPendingChanges = useMemo(() => {
    if (points.length !== appliedPoints.length || userParts.length !== appliedParts.length) return true;
    for (let i = 0; i < points.length; i++) {
      if (points[i].key !== appliedPoints[i].key || points[i].deleted !== appliedPoints[i].deleted) return true;
    }
    for (let i = 0; i < userParts.length; i++) {
      const a = userParts[i];
      const b = appliedParts[i];
      if (a.id !== b.id || a.name !== b.name || a.pointKeys.length !== b.pointKeys.length) return true;
      for (let j = 0; j < a.pointKeys.length; j++) {
        if (a.pointKeys[j] !== b.pointKeys[j]) return true;
      }
    }
    return false;
  }, [appliedParts, appliedPoints, points, userParts]);

  const appliedModel: AppliedGISModel | null = useMemo(
    () => computeAppliedModel(appliedPoints, appliedParts, cadSettings.textHeight, false),
    [appliedParts, appliedPoints, cadSettings.textHeight]
  );

  const scrText = useMemo(
    () => (appliedModel ? buildScrScript(appliedModel, cadSettings) : ''),
    [appliedModel, cadSettings]
  );

  const crossingParts = useMemo(
    () => (appliedModel ? appliedModel.parts.filter((p) => p.hasCrossings).map((p) => p.name) : []),
    [appliedModel]
  );

  const appliedNearCount = useMemo(
    () => detectNearPairs(appliedPoints, tolerance).nearKeys.size,
    [appliedPoints, tolerance]
  );

  // Render B&W Site Layout Canvas whenever appliedModel or outputTab changes
  useEffect(() => {
    if (!appliedModel || outputTab !== 'images' || !layoutCanvasRef.current) return;
    paintCadCanvas(
      layoutCanvasRef.current,
      appliedModel,
      1400,
      1000,
      {
        names: cadSettings.includePartNames,
        dims: false,
        pts: true,
        areas: false,
        north: true,
        dark: false,
        k: 1,
        m: 130,
        lw: 2.5,
        dot: 4.5,
        nf: 28,
        idf: 17,
        af: 20,
        df: 16,
        off: 0,
        arrow: [80, 130, 80],
      },
      null
    );
  }, [appliedModel, cadSettings.includePartNames, outputTab]);

  // Render 800x600 Satellite Canvas whenever appliedModel / zoom / showIds / tab changes
  useEffect(() => {
    if (!appliedModel || outputTab !== 'images' || !satCanvasRef.current) return;
    const token = ++satTokenRef.current;
    setSatStatus('جاري تحميل صور القمر الصناعي...');
    renderSatelliteCanvas(
      satCanvasRef.current,
      appliedModel,
      satZoom,
      satShowIds,
      () => token !== satTokenRef.current
    ).then((msg) => {
      if (token === satTokenRef.current && msg) setSatStatus(msg);
    });
  }, [appliedModel, outputTab, satShowIds, satZoom]);

  const handleSaveLayout = (ext: 'jpg' | 'png') => {
    const cv = layoutCanvasRef.current;
    if (!cv) return;
    cv.toBlob(
      (b) =>
        b &&
        downloadBlob(
          `site_layout${cadSettings.includePartNames ? '' : '_no_part_names'}.${ext}`,
          b
        ),
      ext === 'jpg' ? 'image/jpeg' : 'image/png',
      0.95
    );
  };

  const handleSaveSat = (ext: 'jpg' | 'png') => {
    const cv = satCanvasRef.current;
    if (!cv) return;
    try {
      cv.toBlob(
        (b) => b && downloadBlob(`satellite_800x600.${ext}`, b),
        ext === 'jpg' ? 'image/jpeg' : 'image/png',
        0.95
      );
    } catch {
      setSatStatus('حظر المتصفح حفظ صور القمر الصناعي (CORS). يمكنك استخدام لقطة شاشة.');
    }
  };

  const handleUseFromCoordTab = (rowsFromTab: CoordRow[], srcName: string) => {
    const HEAD = ['ID', 'Easting (Meter)', 'Northing (Meter)', 'Elevation (Meter)', 'Feature Code'];
    const aoa: (string | number)[][] = [
      HEAD,
      ...rowsFromTab.map((r) => [r[0], r[1], r[2], r[3] === null ? '' : r[3], r[4]]),
    ];
    setTopTab('studio');
    loadWorkbookRows(aoa, `${srcName} (${rowsFromTab.length} نقطة)`, false);
    setMapperOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#0b0f17] text-slate-100 flex flex-col">
      {/* Three-Zone Top Bar */}
      <header className="border-b border-slate-800 bg-[#0d1320]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-6">
          {/* Zone 1: Wordmark */}
          <span className="text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
            Cadastral CAD Studio
          </span>

          {/* Zone 2: Navigation Tabs */}
          <nav className="flex items-center gap-2 sm:gap-5 overflow-x-auto">
            <button
              type="button"
              onClick={() => setTopTab('studio')}
              className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                topTab === 'studio'
                  ? 'bg-cyan-400/15 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              شاشة الأوتوكاد والمخرجات
            </button>
            <button
              type="button"
              onClick={() => setTopTab('coords')}
              className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                topTab === 'coords'
                  ? 'bg-cyan-400/15 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              جدول الإحداثيات
            </button>
            <button
              type="button"
              onClick={() => setTopTab('excel2cad')}
              className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                topTab === 'excel2cad'
                  ? 'bg-cyan-400/15 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Excel ← AutoCAD
            </button>
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => {
                setTopTab('studio');
                fileInputRef.current?.click();
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-cyan-400 text-slate-950 hover:bg-cyan-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              رفع ملف نقاط
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 flex-1 space-y-5">
        {topTab === 'studio' && (
          <>
            {/* Compact Source & Column Mapper Bar */}
            <section className="rounded-xl border border-slate-800 bg-[#101725] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="font-semibold text-slate-200">ملف النقاط:</span>
                  <span className="text-cyan-300 font-mono">{fileName}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400 font-mono tabular-nums">
                    {points.length} نقطة (UTM WGS84 Zone 36N)
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMapperOpen((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
                  >
                    إعدادات الأعمدة والخيارات
                    {mapperOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {mapperOpen && (
                <div className="mt-4 pt-4 border-t border-slate-800 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
                  <div>
                    <label className="block text-slate-400 mb-1">عمود رقم النقطة (ID)</label>
                    <select
                      value={colID}
                      onChange={(e) => setColID(Number(e.target.value))}
                      className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
                    >
                      {Array.from({ length: columnCount }, (_, i) => (
                        <option key={i} value={i}>
                          {rawHasHeader && rawRows[0]?.[i] ? String(rawRows[0][i]) : `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">عمود X (Easting)</label>
                    <select
                      value={colX}
                      onChange={(e) => setColX(Number(e.target.value))}
                      className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
                    >
                      {Array.from({ length: columnCount }, (_, i) => (
                        <option key={i} value={i}>
                          {rawHasHeader && rawRows[0]?.[i] ? String(rawRows[0][i]) : `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">عمود Y (Northing)</label>
                    <select
                      value={colY}
                      onChange={(e) => setColY(Number(e.target.value))}
                      className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
                    >
                      {Array.from({ length: columnCount }, (_, i) => (
                        <option key={i} value={i}>
                          {rawHasHeader && rawRows[0]?.[i] ? String(rawRows[0][i]) : `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">عمود Z (اختياري)</label>
                    <select
                      value={colZ}
                      onChange={(e) => setColZ(Number(e.target.value))}
                      className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
                    >
                      <option value={-1}>-- بدون --</option>
                      {Array.from({ length: columnCount }, (_, i) => (
                        <option key={i} value={i}>
                          {rawHasHeader && rawRows[0]?.[i] ? String(rawRows[0][i]) : `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">عمود كود الجزء (اختياري)</label>
                    <select
                      value={colCode}
                      onChange={(e) => setColCode(Number(e.target.value))}
                      className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
                    >
                      <option value={-1}>-- توصيل يدوي على الشاشة --</option>
                      {Array.from({ length: columnCount }, (_, i) => (
                        <option key={i} value={i}>
                          {rawHasHeader && rawRows[0]?.[i] ? String(rawRows[0][i]) : `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleApplyColumnMapping}
                      className="w-full py-2 px-3 rounded-lg font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
                    >
                      تحديث النقاط
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Primary Workspace: AutoCAD Display & Editing Screen */}
            <CadEditorCanvas
              points={points}
              userParts={userParts}
              tolerance={tolerance}
              hasPendingChanges={hasPendingChanges}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              undoLabel={history.past[history.past.length - 1]?.label}
              redoLabel={history.future[0]?.label}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onToleranceChange={setTolerance}
              onToggleDeletePoint={handleToggleDeletePoint}
              onDeletePointsBatch={handleDeletePointsBatch}
              onDeleteAllNear={handleDeleteAllNear}
              onRestoreAllDeleted={handleRestoreAllDeleted}
              onAddPart={handleAddPart}
              onRenamePart={handleRenamePart}
              onDeletePart={handleDeletePart}
              onClearAllParts={handleClearAllParts}
              onAutoConnectFromFile={handleAutoConnectFromFile}
              onApplyToOutputs={handleApplyToOutputs}
            />

            {/* Applied Outputs Section */}
            {!appliedModel ? (
              <section className="rounded-xl border border-slate-800 bg-[#101725] p-6 text-center">
                <p className="text-sm text-slate-300 mb-1">
                  قم بتوصيل النقاط في شاشة الأوتوكاد بالأعلى لتكوين الأجزاء وتسميتها، ثم اضغط{' '}
                  <strong className="text-cyan-300">«تطبيق على كافة المخرجات»</strong>.
                </p>
                <p className="text-xs text-slate-500">
                  ستظهر هنا تلقائياً جداول المساحات، المعاينة بالأبعاد، خريطة القمر الصناعي، وملفات DXF / SCR / KML / Shapefile.
                </p>
              </section>
            ) : (
              <section className="space-y-5">
                {/* Pending edit banner */}
                {hasPendingChanges && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                    <span>
                      المخرجات أدناه تعرض آخر نسخة مطبّقة. لديك تعديلات جديدة في شاشة الأوتوكاد — اضغط تطبيق لتحديث كافة المخرجات.
                    </span>
                    <button
                      type="button"
                      onClick={handleApplyToOutputs}
                      className="px-4 py-1.5 rounded-lg font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer whitespace-nowrap"
                    >
                      تطبيق التعديلات الآن
                    </button>
                  </div>
                )}

                {/* 5-KPI Summary Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <div className="rounded-xl border border-slate-800 bg-[#101725] p-3.5">
                    <div className="text-xs text-slate-400 mb-1">عدد الأجزاء</div>
                    <div className="text-lg font-bold text-amber-300 font-mono tabular-nums">
                      {appliedModel.parts.length}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-[#101725] p-3.5">
                    <div className="text-xs text-slate-400 mb-1">إجمالي مساحة الأجزاء</div>
                    <div className="text-lg font-bold text-amber-300 font-mono tabular-nums" dir="ltr">
                      {appliedModel.totalArea.toFixed(2)} m²
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-[#101725] p-3.5">
                    <div className="text-xs text-slate-400 mb-1">المساحة بالفدان</div>
                    <div className="text-lg font-bold text-amber-300 font-mono tabular-nums" dir="ltr">
                      {(appliedModel.totalArea / FED).toFixed(5)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-[#101725] p-3.5">
                    <div className="text-xs text-slate-400 mb-1">مساحة الحد الخارجي</div>
                    <div className="text-lg font-bold text-cyan-300 font-mono tabular-nums" dir="ltr">
                      {appliedModel.boundaryMeasure.area.toFixed(2)} m²
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-[#101725] p-3.5 col-span-2 sm:col-span-1">
                    <div className="text-xs text-slate-400 mb-1">مركز الموقع (Lat, Lon)</div>
                    <div className="text-sm font-bold text-slate-200 font-mono tabular-nums" dir="ltr">
                      {appliedModel.centerLL[1].toFixed(6)}, {appliedModel.centerLL[0].toFixed(6)}
                    </div>
                  </div>
                </div>

                {/* Diagnostics & Area Statement Table */}
                <div className="rounded-xl border border-slate-800 bg-[#101725] p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <h2 className="text-base font-bold text-cyan-300">بيان المساحات (Area Statement)</h2>
                    <span className="text-xs text-slate-400 font-mono">
                      ارتفاع النص التلقائي: {appliedModel.usedTH} · نقاط محذوفة: {appliedPoints.filter((p) => p.deleted).length}
                      {exactDropped > 0 ? ` · متطابقة مستبعدة: ${exactDropped}` : ''}
                    </span>
                  </div>

                  {(crossingParts.length > 0 || !appliedModel.merged || appliedNearCount > 0) && (
                    <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200 space-y-1">
                      {crossingParts.length > 0 && (
                        <p>تنبيه: توجد أضلاع متقاطعة في الأجزاء التالية: {crossingParts.join('، ')}.</p>
                      )}
                      {!appliedModel.merged && (
                        <p>ملاحظة: الأجزاء غير متلاصقة بالكامل، تم استخدام الغلاف الخارجي (Convex Hull) للحد الكلي.</p>
                      )}
                      {appliedNearCount > 0 && (
                        <p>
                          يوجد {appliedNearCount} نقاط متقاربة ضمن مسافة {tolerance}م ما زالت مفعّلة.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="overflow-x-auto rounded-lg border border-slate-800" dir="ltr">
                    <table className="w-full text-xs sm:text-sm text-center border-collapse">
                      <thead>
                        <tr className="bg-slate-900 text-cyan-300 border-b border-slate-800">
                          <th className="px-3 py-2.5">#</th>
                          <th className="px-3 py-2.5">Part Name</th>
                          <th className="px-3 py-2.5">Area (m²)</th>
                          <th className="px-3 py-2.5">Area (Feddan)</th>
                          <th className="px-3 py-2.5">F-Q-S</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 font-mono tabular-nums">
                        {appliedModel.parts.map((p, i) => (
                          <tr key={p.id} className="hover:bg-slate-800/40">
                            <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                            <td className="px-3 py-2 font-sans font-semibold text-white">{p.name}</td>
                            <td className="px-3 py-2">{p.area.toFixed(2)}</td>
                            <td className="px-3 py-2">{(p.area / FED).toFixed(5)}</td>
                            <td className="px-3 py-2">{fqs(p.area)}</td>
                          </tr>
                        ))}
                        <tr className="bg-slate-900/90 font-bold text-amber-300">
                          <td className="px-3 py-2.5"></td>
                          <td className="px-3 py-2.5 font-sans">TOTAL</td>
                          <td className="px-3 py-2.5">{appliedModel.totalArea.toFixed(2)}</td>
                          <td className="px-3 py-2.5">{(appliedModel.totalArea / FED).toFixed(5)}</td>
                          <td className="px-3 py-2.5">{fqs(appliedModel.totalArea)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Output Sub-Navigation */}
                <div className="flex flex-wrap items-center gap-2 p-1.5 rounded-xl bg-[#101725] border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setOutputTab('cad_preview')}
                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      outputTab === 'cad_preview'
                        ? 'bg-cyan-400 text-slate-950'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Ruler className="w-3.5 h-3.5" />
                    معاينة الأوتوكاد بالأبعاد
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutputTab('sat_map')}
                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      outputTab === 'sat_map'
                        ? 'bg-cyan-400 text-slate-950'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <MapIcon className="w-3.5 h-3.5" />
                    خريطة القمر الصناعي
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutputTab('images')}
                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      outputTab === 'images'
                        ? 'bg-cyan-400 text-slate-950'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    صور القمر الصناعي والمخطط
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutputTab('downloads')}
                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      outputTab === 'downloads'
                        ? 'bg-cyan-400 text-slate-950'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Download className="w-3.5 h-3.5" />
                    التحميلات (DXF / SCR / KML / SHP)
                  </button>
                </div>

                {outputTab === 'cad_preview' && (
                  <CadPreviewPanel
                    model={appliedModel}
                    settings={cadSettings}
                    onSettingsChange={(next) => setCadSettings((prev) => ({ ...prev, ...next }))}
                    onDownloadDxf={() =>
                      downloadBlob(
                        'parcels_polylines_area_table.dxf',
                        new Blob([buildDxfContent(appliedModel, cadSettings)], { type: 'application/dxf' })
                      )
                    }
                  />
                )}

                {outputTab === 'sat_map' && (
                  <div className="rounded-xl border border-slate-800 bg-[#101725] p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-sm font-bold text-cyan-300">
                        المعاينة على القمر الصناعي (Google Satellite / Esri)
                      </h3>
                      <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={satShowIds}
                          onChange={(e) => setSatShowIds(e.target.checked)}
                          className="accent-cyan-400"
                        />
                        إظهار أرقام النقاط على الخريطة
                      </label>
                    </div>
                    <SatelliteMap model={appliedModel} showIds={satShowIds} />
                  </div>
                )}

                {outputTab === 'images' && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* 800x600 Satellite Export */}
                    <div className="rounded-xl border border-slate-800 bg-[#101725] p-4 space-y-3">
                      <h3 className="text-sm font-bold text-cyan-300">صورة القمر الصناعي (800×600)</h3>
                      <canvas
                        ref={satCanvasRef}
                        className="w-full aspect-[4/3] rounded-lg bg-slate-900 border border-slate-800 block"
                      />
                      <p className="text-xs text-slate-400 font-mono">{satStatus}</p>
                      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <label className="text-slate-400">Zoom (0 = تلقائي):</label>
                          <input
                            type="number"
                            dir="ltr"
                            min={0}
                            max={21}
                            value={satZoom}
                            onChange={(e) => setSatZoom(Number(e.target.value) || 0)}
                            className="w-16 px-2 py-1 rounded border border-slate-700 bg-slate-900 text-slate-100 font-mono"
                          />
                        </div>
                        <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={satShowIds}
                            onChange={(e) => setSatShowIds(e.target.checked)}
                            className="accent-cyan-400"
                          />
                          أرقام النقاط
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleSaveSat('png')}
                          className="py-2 px-3 rounded-lg text-xs font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
                        >
                          تحميل PNG
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveSat('jpg')}
                          className="py-2 px-3 rounded-lg text-xs font-bold bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
                        >
                          تحميل JPG
                        </button>
                      </div>
                    </div>

                    {/* Site Layout B&W Export */}
                    <div className="rounded-xl border border-slate-800 bg-[#101725] p-4 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-bold text-cyan-300">المخطط العام (CAD Site Layout)</h3>
                        <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cadSettings.includePartNames}
                            onChange={(e) =>
                              setCadSettings((p) => ({ ...p, includePartNames: e.target.checked }))
                            }
                            className="accent-cyan-400"
                          />
                          إظهار أسماء الأجزاء
                        </label>
                      </div>
                      <canvas
                        ref={layoutCanvasRef}
                        className="w-full aspect-[4/3] object-contain rounded-lg bg-white border border-slate-800 block"
                      />
                      <div className="grid grid-cols-2 gap-2 pt-7">
                        <button
                          type="button"
                          onClick={() => handleSaveLayout('jpg')}
                          className="py-2 px-3 rounded-lg text-xs font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
                        >
                          تحميل المخطط JPG
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveLayout('png')}
                          className="py-2 px-3 rounded-lg text-xs font-bold bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
                        >
                          تحميل المخطط PNG
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {outputTab === 'downloads' && (
                  <div className="rounded-xl border border-slate-800 bg-[#101725] p-5 space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <h3 className="text-base font-bold text-cyan-300">تصدير كافة المخرجات والملفات</h3>
                      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cadSettings.includePoints}
                            onChange={(e) =>
                              setCadSettings((p) => ({ ...p, includePoints: e.target.checked }))
                            }
                            className="accent-cyan-400"
                          />
                          النقاط + الأرقام
                        </label>
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cadSettings.includeDims}
                            onChange={(e) =>
                              setCadSettings((p) => ({ ...p, includeDims: e.target.checked }))
                            }
                            className="accent-cyan-400"
                          />
                          أبعاد الأضلاع
                        </label>
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cadSettings.includeNorth}
                            onChange={(e) =>
                              setCadSettings((p) => ({ ...p, includeNorth: e.target.checked }))
                            }
                            className="accent-cyan-400"
                          />
                          سهم الشمال
                        </label>
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cadSettings.includePartNames}
                            onChange={(e) =>
                              setCadSettings((p) => ({ ...p, includePartNames: e.target.checked }))
                            }
                            className="accent-cyan-400"
                          />
                          أسماء الأجزاء
                        </label>
                        <div className="flex items-center gap-1.5">
                          <span>ارتفاع النص:</span>
                          <input
                            type="number"
                            dir="ltr"
                            min={0}
                            step={0.1}
                            value={cadSettings.textHeight}
                            onChange={(e) =>
                              setCadSettings((p) => ({ ...p, textHeight: Number(e.target.value) || 0 }))
                            }
                            className="w-16 px-2 py-1 rounded border border-slate-700 bg-slate-900 text-slate-100 font-mono"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          downloadBlob(
                            'parcels_polylines_area_table.dxf',
                            new Blob([buildDxfContent(appliedModel, cadSettings)], {
                              type: 'application/dxf',
                            })
                          )
                        }
                        className="inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
                      >
                        <FileCode2 className="w-4 h-4" />
                        ملف DXF (AutoCAD)
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          downloadBlob(
                            'parcels_polylines_area_table.scr',
                            new Blob([scrText], { type: 'text/plain' })
                          )
                        }
                        className="inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-bold bg-slate-800 text-slate-100 hover:bg-slate-700 cursor-pointer"
                      >
                        <FileCode2 className="w-4 h-4 text-cyan-300" />
                        سكربت CAD (.scr)
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          downloadBlob(
                            'boundary.kml',
                            new Blob([buildKmlContent(appliedModel)], {
                              type: 'application/vnd.google-earth.kml+xml',
                            })
                          )
                        }
                        className="inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-bold bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer"
                      >
                        <Globe2 className="w-4 h-4" />
                        KML (Google Earth)
                      </button>

                      <button
                        type="button"
                        onClick={() => exportShapefileZip(appliedModel, 'all')}
                        className="inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-bold bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer"
                      >
                        <FolderArchive className="w-4 h-4" />
                        Shapefile (All .zip)
                      </button>

                      <button
                        type="button"
                        onClick={() => exportShapefileZip(appliedModel, 'rasm')}
                        className="inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
                      >
                        <FolderArchive className="w-4 h-4" />
                        export rasm elkhareta
                      </button>
                    </div>

                    <details className="rounded-lg border border-slate-800 bg-[#0b101b] p-3">
                      <summary className="cursor-pointer text-xs font-semibold text-slate-300">
                        عرض / نسخ كود GstarCAD / AutoCAD Script (.scr)
                      </summary>
                      <div className="mt-3 space-y-2">
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(scrText);
                            setScrCopied(true);
                            setTimeout(() => setScrCopied(false), 1800);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-cyan-300 hover:bg-slate-700 cursor-pointer"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          {scrCopied ? 'تم النسخ!' : 'نسخ السكربت'}
                        </button>
                        <textarea
                          readOnly
                          dir="ltr"
                          value={scrText}
                          className="w-full h-52 p-3 rounded-lg border border-slate-800 bg-[#060910] text-sky-300 font-mono text-xs"
                        />
                      </div>
                    </details>
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {topTab === 'coords' && (
          <CoordinatesTableTab
            coordRows={coordRows}
            sourceName={coordSourceName}
            onUpdateCoords={(rowsIn, nameIn) => {
              setCoordRows(rowsIn);
              setCoordSourceName(nameIn);
            }}
            onUseInStudio={handleUseFromCoordTab}
          />
        )}

        {topTab === 'excel2cad' && <ExcelToAutocadTab coordRows={coordRows} />}
      </main>
    </div>
  );
}
