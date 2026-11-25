import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crosshair,
  Eye,
  EyeOff,
  Focus,
  Hand,
  Link2,
  Maximize2,
  Plus,
  Redo2,
  RotateCcw,
  SkipForward,
  Sparkles,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  FED,
  SurveyPoint,
  UserPart,
  detectNearPairs,
  letterName,
  measure,
} from '../lib/cadastral';

export type CadToolMode = 'connect' | 'delete' | 'pan';

interface CadEditorCanvasProps {
  points: SurveyPoint[];
  userParts: UserPart[];
  tolerance: number;
  hasPendingChanges: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  onUndo: () => void;
  onRedo: () => void;
  onToleranceChange: (tol: number) => void;
  onToggleDeletePoint: (key: string) => void;
  onDeletePointsBatch: (keys: string[]) => void;
  onDeleteAllNear: () => void;
  onRestoreAllDeleted: () => void;
  onAddPart: (name: string, pointKeys: string[]) => void;
  onRenamePart: (partId: string, newName: string) => void;
  onDeletePart: (partId: string) => void;
  onClearAllParts: () => void;
  onAutoConnectFromFile: () => void;
  onApplyToOutputs: () => void;
}

const PART_COLORS = [
  '#22d3ee',
  '#34d399',
  '#a78bfa',
  '#fb7185',
  '#38bdf8',
  '#fbbf24',
  '#f472b6',
  '#2dd4bf',
];

interface ViewState {
  scale: number; // px per meter
  cx: number; // world X at canvas center
  cy: number; // world Y at canvas center
}

export const CadEditorCanvas: React.FC<CadEditorCanvasProps> = ({
  points,
  userParts,
  tolerance,
  hasPendingChanges,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  onToleranceChange,
  onToggleDeletePoint,
  onDeletePointsBatch,
  onDeleteAllNear,
  onRestoreAllDeleted,
  onAddPart,
  onRenamePart,
  onDeletePart,
  onClearAllParts,
  onAutoConnectFromFile,
  onApplyToOutputs,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<CadToolMode>('connect');
  const [boxSelectMode, setBoxSelectMode] = useState(false);
  const [showIds, setShowIds] = useState(true);
  const [showDeleted, setShowDeleted] = useState(true);
  const [showPartAreas, setShowPartAreas] = useState(true);

  const [chain, setChain] = useState<string[]>([]);
  const [pendingNamePrompt, setPendingNamePrompt] = useState<{ pointKeys: string[]; defaultName: string } | null>(null);
  const [draftPartName, setDraftPartName] = useState('');
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);

  const [view, setView] = useState<ViewState | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [snappedKey, setSnappedKey] = useState<string | null>(null);
  const [nearIdx, setNearIdx] = useState(0);

  const panDragRef = useRef<{ startX: number; startY: number; cx: number; cy: number } | null>(null);
  const boxDragRef = useRef<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [boxRect, setBoxRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const spaceHeldRef = useRef(false);

  const pointMap = useMemo(() => new Map(points.map((p) => [p.key, p])), [points]);
  const deletedCount = useMemo(() => points.filter((p) => p.deleted).length, [points]);
  const activePoints = useMemo(() => points.filter((p) => !p.deleted), [points]);
  const { nearKeys, pairs: nearPairs } = useMemo(() => detectNearPairs(points, tolerance), [points, tolerance]);

  // Remove any deleted points from active drawing chain automatically
  useEffect(() => {
    setChain((prev) => prev.filter((k) => {
      const p = pointMap.get(k);
      return p && !p.deleted;
    }));
  }, [pointMap]);

  const partSummaries = useMemo(() => {
    return userParts.map((up, idx) => {
      const pts = up.pointKeys
        .map((k) => pointMap.get(k))
        .filter((p): p is SurveyPoint => Boolean(p && !p.deleted));
      const m = pts.length >= 3 ? measure(pts) : { area: 0, lp: { x: 0, y: 0 }, ccw: true };
      return {
        ...up,
        pts,
        area: m.area,
        lp: m.lp,
        color: PART_COLORS[idx % PART_COLORS.length],
      };
    });
  }, [userParts, pointMap]);

  const zoomExtents = useCallback(() => {
    const cv = canvasRef.current;
    const pts = activePoints.length ? activePoints : points;
    if (!cv || !pts.length) return;
    const w = cv.clientWidth || 800;
    const h = cv.clientHeight || 560;
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const dx = Math.max(maxX - minX, 1);
    const dy = Math.max(maxY - minY, 1);
    const scale = Math.min((w * 0.8) / dx, (h * 0.8) / dy);
    setView({
      scale,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    });
  }, [activePoints, points]);

  // Fit on initial points load or dataset swap
  const pointsSignature = points.length > 0 ? `${points.length}:${points[0]?.key}` : '';
  useEffect(() => {
    if (!pointsSignature) return;
    const id = requestAnimationFrame(() => zoomExtents());
    return () => cancelAnimationFrame(id);
  }, [pointsSignature, zoomExtents]);

  const zoomToPoints = useCallback((pts: { x: number; y: number }[], minSpan = 4) => {
    const cv = canvasRef.current;
    if (!cv || !pts.length) return;
    const w = cv.clientWidth || 800;
    const h = cv.clientHeight || 560;
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const dx = Math.max(maxX - minX, minSpan);
    const dy = Math.max(maxY - minY, minSpan);
    setView({
      scale: Math.min((w * 0.65) / dx, (h * 0.65) / dy),
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    });
  }, []);

  const handleNextNearPair = () => {
    if (!nearPairs.length) return;
    const idx = nearIdx % nearPairs.length;
    setNearIdx((idx + 1) % nearPairs.length);
    const [a, b] = nearPairs[idx];
    const span = Math.max(tolerance * 6, 1.5);
    zoomToPoints([a, b], span);
  };

  const openNamePrompt = useCallback(
    (pointKeys: string[]) => {
      if (pointKeys.length < 3) return;
      const suggested = letterName(userParts.length);
      setDraftPartName(suggested);
      setPendingNamePrompt({ pointKeys, defaultName: suggested });
      setTimeout(() => {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
      }, 30);
    },
    [userParts.length]
  );

  const confirmPartName = () => {
    if (!pendingNamePrompt) return;
    const finalName = draftPartName.trim() || pendingNamePrompt.defaultName;
    onAddPart(finalName, pendingNamePrompt.pointKeys);
    setPendingNamePrompt(null);
    setChain([]);
  };

  // Keyboard shortcuts like AutoCAD
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (canUndo && !pendingNamePrompt) onUndo();
          return;
        }
        if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault();
          if (canRedo && !pendingNamePrompt) onRedo();
          return;
        }
      }
      if (e.code === 'Space') {
        spaceHeldRef.current = true;
      } else if (e.key === 'Escape') {
        if (pendingNamePrompt) {
          setPendingNamePrompt(null);
        } else if (chain.length) {
          setChain([]);
        }
      } else if (e.key === 'Backspace' && mode === 'connect' && chain.length && !pendingNamePrompt) {
        e.preventDefault();
        setChain((prev) => prev.slice(0, -1));
      } else if (e.key === 'Enter' && mode === 'connect' && chain.length >= 3 && !pendingNamePrompt) {
        e.preventDefault();
        openNamePrompt(chain);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [canRedo, canUndo, chain, mode, onRedo, onUndo, openNamePrompt, pendingNamePrompt]);

  // Coordinate conversions
  const worldToScreen = useCallback(
    (wx: number, wy: number, v: ViewState, w: number, h: number): [number, number] => [
      w / 2 + (wx - v.cx) * v.scale,
      h / 2 - (wy - v.cy) * v.scale,
    ],
    []
  );

  const screenToWorld = useCallback(
    (sx: number, sy: number, v: ViewState, w: number, h: number): [number, number] => [
      v.cx + (sx - w / 2) / v.scale,
      v.cy - (sy - h / 2) / v.scale,
    ],
    []
  );

  const findNearestPoint = useCallback(
    (sx: number, sy: number, v: ViewState, w: number, h: number): SurveyPoint | null => {
      const candidates = mode === 'delete' && showDeleted ? points : activePoints;
      let best: SurveyPoint | null = null;
      let bestDist = 18; // OSNAP pixel radius
      for (const p of candidates) {
        const [px, py] = worldToScreen(p.x, p.y, v, w, h);
        const d = Math.hypot(px - sx, py - sy);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      return best;
    },
    [activePoints, mode, points, showDeleted, worldToScreen]
  );

  // Canvas draw loop
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !view) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Model-space dark background
    ctx.fillStyle = '#090e17';
    ctx.fillRect(0, 0, w, h);

    // 2. Adaptive CAD Coordinate Grid
    const minWX = view.cx - w / 2 / view.scale;
    const maxWX = view.cx + w / 2 / view.scale;
    const minWY = view.cy - h / 2 / view.scale;
    const maxWY = view.cy + h / 2 / view.scale;

    const targetStepM = 75 / view.scale;
    const gridSteps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
    const majorStep = gridSteps.find((s) => s >= targetStepM) || 2000;
    const minorStep = majorStep / 5;

    if (minorStep * view.scale >= 10) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = Math.floor(minWX / minorStep) * minorStep; gx <= maxWX; gx += minorStep) {
        const [sx] = worldToScreen(gx, 0, view, w, h);
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      }
      for (let gy = Math.floor(minWY / minorStep) * minorStep; gy <= maxWY; gy += minorStep) {
        const [, sy] = worldToScreen(0, gy, view, w, h);
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const majorXs: number[] = [];
    const majorYs: number[] = [];
    for (let gx = Math.floor(minWX / majorStep) * majorStep; gx <= maxWX; gx += majorStep) {
      majorXs.push(gx);
      const [sx] = worldToScreen(gx, 0, view, w, h);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let gy = Math.floor(minWY / majorStep) * majorStep; gy <= maxWY; gy += majorStep) {
      majorYs.push(gy);
      const [, sy] = worldToScreen(0, gy, view, w, h);
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();

    // Grid UTM coordinate ticks
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    majorXs.forEach((gx) => {
      const [sx] = worldToScreen(gx, 0, view, w, h);
      if (sx > 48 && sx < w - 30) ctx.fillText(gx.toFixed(0), sx, h - 4);
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    majorYs.forEach((gy) => {
      const [, sy] = worldToScreen(0, gy, view, w, h);
      if (sy > 18 && sy < h - 22) ctx.fillText(gy.toFixed(0), 6, sy);
    });

    // 3. Draw connected parts (polygons + segment lengths + labels)
    partSummaries.forEach((part) => {
      if (part.pts.length < 3) return;
      const isHovered = hoveredPartId === part.id;
      ctx.save();
      ctx.beginPath();
      part.pts.forEach((q, idx) => {
        const [sx, sy] = worldToScreen(q.x, q.y, view, w, h);
        if (idx === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = isHovered ? `${part.color}36` : `${part.color}1c`;
      ctx.fill();
      ctx.strokeStyle = part.color;
      ctx.lineWidth = isHovered ? 3 : 2;
      ctx.stroke();

      // Part edge lengths when zoomed in enough
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < part.pts.length; i++) {
        const a = part.pts[i];
        const b = part.pts[(i + 1) % part.pts.length];
        const [ax, ay] = worldToScreen(a.x, a.y, view, w, h);
        const [bx, by] = worldToScreen(b.x, b.y, view, w, h);
        const segPx = Math.hypot(bx - ax, by - ay);
        if (segPx > 55) {
          const distM = Math.hypot(b.x - a.x, b.y - a.y);
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          let ang = Math.atan2(by - ay, bx - ax);
          if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI;
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(ang);
          ctx.fillStyle = 'rgba(9, 14, 23, 0.75)';
          const label = `${distM.toFixed(2)}m`;
          const tw = ctx.measureText(label).width;
          ctx.fillRect(-tw / 2 - 3, -15, tw + 6, 12);
          ctx.fillStyle = part.color;
          ctx.fillText(label, 0, -9);
          ctx.restore();
        }
      }

      // Part name + area at interior label point
      const [lx, ly] = worldToScreen(part.lp.x, part.lp.y, view, w, h);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 14px "Cairo", "Plus Jakarta Sans", sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#090e17';
      ctx.strokeText(part.name, lx, ly - (showPartAreas ? 8 : 0));
      ctx.fillStyle = '#ffffff';
      ctx.fillText(part.name, lx, ly - (showPartAreas ? 8 : 0));
      if (showPartAreas) {
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.strokeText(`${part.area.toFixed(2)} m²`, lx, ly + 10);
        ctx.fillStyle = part.color;
        ctx.fillText(`${part.area.toFixed(2)} m²`, lx, ly + 10);
      }
      ctx.restore();
    });

    // 4. Highlight near-duplicate pairs with dashed amber link
    if (nearPairs.length) {
      ctx.save();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      nearPairs.forEach(([a, b]) => {
        const [ax, ay] = worldToScreen(a.x, a.y, view, w, h);
        const [bx, by] = worldToScreen(b.x, b.y, view, w, h);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      });
      ctx.restore();
    }

    // 5. Active unclosed connection chain + rubber-band line
    if (chain.length > 0) {
      const chainPts = chain.map((k) => pointMap.get(k)).filter((p): p is SurveyPoint => Boolean(p));
      if (chainPts.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        chainPts.forEach((q, idx) => {
          const [sx, sy] = worldToScreen(q.x, q.y, view, w, h);
          if (idx === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.stroke();

        // Rubber-band from last picked point to snap/cursor
        const last = chainPts[chainPts.length - 1];
        const first = chainPts[0];
        const [lx, ly] = worldToScreen(last.x, last.y, view, w, h);
        const [fx, fy] = worldToScreen(first.x, first.y, view, w, h);

        let targetSX: number | null = null;
        let targetSY: number | null = null;
        let targetWX = 0;
        let targetWY = 0;

        const snappedPt = snappedKey ? pointMap.get(snappedKey) : null;
        if (snappedPt && !snappedPt.deleted) {
          [targetSX, targetSY] = worldToScreen(snappedPt.x, snappedPt.y, view, w, h);
          targetWX = snappedPt.x;
          targetWY = snappedPt.y;
        } else if (mousePos && mode === 'connect') {
          targetSX = mousePos.x;
          targetSY = mousePos.y;
          [targetWX, targetWY] = screenToWorld(mousePos.x, mousePos.y, view, w, h);
        }

        if (targetSX !== null && targetSY !== null) {
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = '#fbbf24';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(targetSX, targetSY);
          ctx.stroke();

          // Closing preview line back to first point if >= 2 points picked
          if (chainPts.length >= 2) {
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
            ctx.beginPath();
            ctx.moveTo(targetSX, targetSY);
            ctx.lineTo(fx, fy);
            ctx.stroke();
          }

          // Live distance HUD on rubber-band
          const segLen = Math.hypot(targetWX - last.x, targetWY - last.y);
          if (segLen > 0.001) {
            const dx = targetWX - last.x;
            const dy = targetWY - last.y;
            const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
            const txt = `${segLen.toFixed(2)} m · ${deg.toFixed(1)}°`;
            const mx = (lx + targetSX) / 2;
            const my = (ly + targetSY) / 2;
            ctx.setLineDash([]);
            ctx.font = '11px "JetBrains Mono", monospace';
            const tw = ctx.measureText(txt).width;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1;
            ctx.fillRect(mx - tw / 2 - 6, my - 11, tw + 12, 20);
            ctx.strokeRect(mx - tw / 2 - 6, my - 11, tw + 12, 20);
            ctx.fillStyle = '#fde68a';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(txt, mx, my - 1);
          }
        }
        ctx.restore();
      }
    }

    // 6. Draw all points (active, near, chain order, deleted)
    points.forEach((p) => {
      if (p.deleted && !showDeleted) return;
      const [sx, sy] = worldToScreen(p.x, p.y, view, w, h);
      if (sx < -30 || sx > w + 30 || sy < -30 || sy > h + 30) return;

      const chainIndex = chain.indexOf(p.key);
      const isFirstInChain = chainIndex === 0 && chain.length >= 3;
      const isNear = !p.deleted && nearKeys.has(p.key);
      const isSnapped = snappedKey === p.key;

      if (p.deleted) {
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sx - 5, sy - 5);
        ctx.lineTo(sx + 5, sy + 5);
        ctx.moveTo(sx + 5, sy - 5);
        ctx.lineTo(sx - 5, sy + 5);
        ctx.stroke();
        if (showIds) {
          ctx.font = '10px "JetBrains Mono", monospace';
          ctx.fillStyle = 'rgba(248, 113, 113, 0.55)';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(p.id, sx + 7, sy - 4);
        }
        ctx.restore();
        return;
      }

      // CAD Node Marker (AutoCAD style circle + cross or filled dot)
      const r = chainIndex > -1 ? 6.5 : isNear ? 5.5 : 4.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = chainIndex > -1 ? '#f97316' : isNear ? '#facc15' : '#22d3ee';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#090e17';
      ctx.stroke();

      // Close ring hint around 1st point when chain >= 3
      if (isFirstInChain) {
        ctx.beginPath();
        ctx.arc(sx, sy, 12, 0, Math.PI * 2);
        ctx.strokeStyle = isSnapped ? '#4ade80' : 'rgba(249, 115, 22, 0.7)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // OSNAP Square around snapped point
      if (isSnapped) {
        ctx.save();
        ctx.strokeStyle = mode === 'delete' ? '#ef4444' : isFirstInChain ? '#4ade80' : '#fde047';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx - 9, sy - 9, 18, 18);
        ctx.restore();
      }

      if (showIds || chainIndex > -1) {
        ctx.font = chainIndex > -1 ? 'bold 11px "JetBrains Mono", monospace' : '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const label = chainIndex > -1 ? `[${chainIndex + 1}] ${p.id}` : p.id;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#090e17';
        ctx.strokeText(label, sx + 8, sy - 5);
        ctx.fillStyle = chainIndex > -1 ? '#fdba74' : isNear ? '#fef08a' : '#e2e8f0';
        ctx.fillText(label, sx + 8, sy - 5);
      }
    });

    // 7. Box selection rectangle (for multi-point delete)
    if (boxRect) {
      const rx = Math.min(boxRect.x1, boxRect.x2);
      const ry = Math.min(boxRect.y1, boxRect.y2);
      const rw = Math.abs(boxRect.x2 - boxRect.x1);
      const rh = Math.abs(boxRect.y2 - boxRect.y1);
      ctx.save();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.restore();
    }

    // 8. AutoCAD Crosshair Cursor + Pickbox + Coordinate Tooltip
    if (mousePos && !panDragRef.current) {
      const { x: mx, y: my } = mousePos;
      ctx.save();
      ctx.strokeStyle = mode === 'delete' ? 'rgba(248, 113, 113, 0.4)' : 'rgba(226, 232, 240, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, my);
      ctx.lineTo(w, my);
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, h);
      ctx.stroke();

      if (mode !== 'pan' && !spaceHeldRef.current) {
        ctx.strokeStyle = mode === 'delete' ? '#ef4444' : '#38bdf8';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(mx - 5, my - 5, 10, 10);
      }

      // Snapped point info pill near cursor
      const snappedPt = snappedKey ? pointMap.get(snappedKey) : null;
      if (snappedPt) {
        const isFirst = chain.length >= 3 && chain[0] === snappedPt.key;
        const infoText =
          mode === 'connect' && isFirst
            ? `انقر لإغلاق وتسمية الجزء (${snappedPt.id})`
            : mode === 'delete'
              ? `${snappedPt.deleted ? 'استعادة' : 'حذف'} نقطة ${snappedPt.id} · E:${snappedPt.x.toFixed(2)} N:${snappedPt.y.toFixed(2)}`
              : `نقطة ${snappedPt.id} · E:${snappedPt.x.toFixed(2)} N:${snappedPt.y.toFixed(2)}`;
        ctx.font = '11px "Cairo", "JetBrains Mono", sans-serif';
        const tw = ctx.measureText(infoText).width;
        const bx = Math.min(mx + 14, w - tw - 18);
        const by = Math.max(my - 32, 8);
        ctx.fillStyle = 'rgba(11, 16, 24, 0.94)';
        ctx.strokeStyle = isFirst ? '#4ade80' : mode === 'delete' ? '#ef4444' : '#22d3ee';
        ctx.lineWidth = 1;
        ctx.fillRect(bx, by, tw + 14, 22);
        ctx.strokeRect(bx, by, tw + 14, 22);
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(infoText, bx + 7, by + 11);
      }
      ctx.restore();
    }

    ctx.restore();
  }, [
    boxRect,
    chain,
    hoveredPartId,
    mode,
    mousePos,
    nearKeys,
    nearPairs,
    partSummaries,
    pointMap,
    points,
    screenToWorld,
    showDeleted,
    showIds,
    showPartAreas,
    snappedKey,
    view,
    worldToScreen,
  ]);

  // Resize observer so canvas sharpens on window/panel resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setView((v) => (v ? { ...v } : v));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Mouse handlers
  const getLocalXY = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!view || !canvasRef.current) return;
    const { x: sx, y: sy } = getLocalXY(e);
    const w = canvasRef.current.clientWidth;
    const h = canvasRef.current.clientHeight;
    const [wx, wy] = screenToWorld(sx, sy, view, w, h);
    const factor = Math.exp(-e.deltaY * 0.0014);
    const newScale = Math.max(0.05, Math.min(view.scale * factor, 2500));
    setView({
      scale: newScale,
      cx: wx - (sx - w / 2) / newScale,
      cy: wy + (sy - h / 2) / newScale,
    });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!view || !canvasRef.current) return;
    const { x: sx, y: sy } = getLocalXY(e);
    const w = canvasRef.current.clientWidth;
    const h = canvasRef.current.clientHeight;

    // Middle click, Pan mode, or Space+Left click -> Pan
    if (e.button === 1 || mode === 'pan' || (e.button === 0 && spaceHeldRef.current)) {
      e.preventDefault();
      panDragRef.current = { startX: e.clientX, startY: e.clientY, cx: view.cx, cy: view.cy };
      return;
    }

    if (e.button !== 0) return;

    // Box selection in delete mode (when box toggle on or Shift held)
    if (mode === 'delete' && (boxSelectMode || e.shiftKey)) {
      boxDragRef.current = { startX: sx, startY: sy, curX: sx, curY: sy };
      setBoxRect({ x1: sx, y1: sy, x2: sx, y2: sy });
      return;
    }

    const hit = findNearestPoint(sx, sy, view, w, h);
    if (!hit) return;

    if (mode === 'delete') {
      onToggleDeletePoint(hit.key);
      return;
    }

    if (mode === 'connect') {
      if (hit.deleted || pendingNamePrompt) return;
      if (chain.length >= 3 && hit.key === chain[0]) {
        openNamePrompt(chain);
        return;
      }
      if (!chain.includes(hit.key)) {
        setChain((prev) => [...prev, hit.key]);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!view || !canvasRef.current) return;
    const { x: sx, y: sy } = getLocalXY(e);
    setMousePos({ x: sx, y: sy });

    if (panDragRef.current) {
      const dx = e.clientX - panDragRef.current.startX;
      const dy = e.clientY - panDragRef.current.startY;
      setView({
        ...view,
        cx: panDragRef.current.cx - dx / view.scale,
        cy: panDragRef.current.cy + dy / view.scale,
      });
      return;
    }

    if (boxDragRef.current) {
      boxDragRef.current.curX = sx;
      boxDragRef.current.curY = sy;
      setBoxRect({
        x1: boxDragRef.current.startX,
        y1: boxDragRef.current.startY,
        x2: sx,
        y2: sy,
      });
      return;
    }

    const w = canvasRef.current.clientWidth;
    const h = canvasRef.current.clientHeight;
    const hit = findNearestPoint(sx, sy, view, w, h);
    setSnappedKey(hit ? hit.key : null);
  };

  const handleMouseUp = () => {
    if (panDragRef.current) {
      panDragRef.current = null;
    }
    if (boxDragRef.current && view && canvasRef.current) {
      const { startX, startY, curX, curY } = boxDragRef.current;
      boxDragRef.current = null;
      setBoxRect(null);
      if (Math.hypot(curX - startX, curY - startY) > 8) {
        const w = canvasRef.current.clientWidth;
        const h = canvasRef.current.clientHeight;
        const minX = Math.min(startX, curX);
        const maxX = Math.max(startX, curX);
        const minY = Math.min(startY, curY);
        const maxY = Math.max(startY, curY);
        const enclosedKeys = activePoints
          .filter((p) => {
            const [px, py] = worldToScreen(p.x, p.y, view, w, h);
            return px >= minX && px <= maxX && py >= minY && py <= maxY;
          })
          .map((p) => p.key);
        if (enclosedKeys.length) onDeletePointsBatch(enclosedKeys);
      }
    }
  };

  const liveWorldCoords = useMemo(() => {
    if (!view || !mousePos || !canvasRef.current) return null;
    const snappedPt = snappedKey ? pointMap.get(snappedKey) : null;
    if (snappedPt) return { x: snappedPt.x, y: snappedPt.y };
    const [wx, wy] = screenToWorld(
      mousePos.x,
      mousePos.y,
      view,
      canvasRef.current.clientWidth,
      canvasRef.current.clientHeight
    );
    return { x: wx, y: wy };
  }, [mousePos, pointMap, screenToWorld, snappedKey, view]);

  return (
    <section className="rounded-xl border border-slate-800 bg-[#101725] overflow-hidden">
      {/* Focused CAD Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-[#0d1320]">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMode('connect')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'connect'
                ? 'bg-cyan-400 text-slate-950'
                : 'bg-slate-800/80 text-slate-200 hover:bg-slate-700'
            }`}
          >
            <Link2 className="w-4 h-4" />
            توصيل النقاط لتكوين جزء
          </button>

          <button
            type="button"
            onClick={() => {
              setMode('delete');
              setChain([]);
            }}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'delete'
                ? 'bg-rose-500 text-white'
                : 'bg-slate-800/80 text-slate-200 hover:bg-slate-700'
            }`}
          >
            <Trash2 className="w-4 h-4" />
            حذف نقاط باختيارك
          </button>

          <button
            type="button"
            onClick={() => setMode('pan')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'pan'
                ? 'bg-amber-400 text-slate-950'
                : 'bg-slate-800/80 text-slate-200 hover:bg-slate-700'
            }`}
          >
            <Hand className="w-4 h-4" />
            تحريك العرض
          </button>

          {mode === 'delete' && (
            <button
              type="button"
              onClick={() => setBoxSelectMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                boxSelectMode
                  ? 'border-rose-400 bg-rose-500/20 text-rose-200'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
            >
              تحديد بنافذة (سحب)
            </button>
          )}
        </div>

        {/* Chain controls when actively connecting */}
        {mode === 'connect' && chain.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-mono tabular-nums text-amber-300 px-2">
              {chain.length} نقاط محددة
            </span>
            <button
              type="button"
              onClick={() => setChain((prev) => prev.slice(0, -1))}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer whitespace-nowrap"
            >
              <Undo2 className="w-3.5 h-3.5" />
              تراجع نقطة
            </button>
            {chain.length >= 3 && (
              <button
                type="button"
                onClick={() => openNamePrompt(chain)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 cursor-pointer whitespace-nowrap"
              >
                <Check className="w-3.5 h-3.5" />
                إغلاق وتسمية الجزء
              </button>
            )}
            <button
              type="button"
              onClick={() => setChain([])}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-rose-300 hover:bg-slate-700 cursor-pointer whitespace-nowrap"
            >
              <X className="w-3.5 h-3.5" />
              إلغاء
            </button>
          </div>
        )}

        {/* History Undo/Redo + Viewport zoom controls */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            title={undoLabel ? `تراجع: ${undoLabel} (Ctrl+Z)` : 'تراجع (Ctrl+Z)'}
            className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <Undo2 className="w-3.5 h-3.5" />
            تراجع
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            title={redoLabel ? `إعادة: ${redoLabel} (Ctrl+Y)` : 'إعادة (Ctrl+Y)'}
            className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <Redo2 className="w-3.5 h-3.5" />
            إعادة
          </button>
          <span className="h-5 w-px bg-slate-800 mx-0.5" aria-hidden="true" />
          <button
            type="button"
            title="تكبير"
            onClick={() => setView((v) => (v ? { ...v, scale: v.scale * 1.35 } : v))}
            className="p-2 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="تصغير"
            onClick={() => setView((v) => (v ? { ...v, scale: Math.max(0.05, v.scale / 1.35) } : v))}
            className="p-2 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={zoomExtents}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            ملاءمة الكل
          </button>
        </div>
      </div>

      {/* Near-Points Cleanup & Display Options Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-2.5 border-b border-slate-800/80 bg-[#0b101b] text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="cad-tol" className="text-slate-400 whitespace-nowrap">
              مسافة التقارب (م):
            </label>
            <input
              id="cad-tol"
              type="number"
              dir="ltr"
              step="0.05"
              min="0.01"
              value={tolerance}
              onChange={(e) => onToleranceChange(Math.max(0.01, parseFloat(e.target.value) || 0.2))}
              className="w-20 px-2 py-1 rounded border border-slate-700 bg-slate-900 text-slate-100 font-mono tabular-nums text-xs"
            />
          </div>

          <span className="text-amber-300 font-mono tabular-nums">
            {nearPairs.length} أزواج متقاربة ({nearKeys.size} نقطة)
          </span>

          <button
            type="button"
            onClick={handleNextNearPair}
            disabled={!nearPairs.length}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
          >
            <SkipForward className="w-3.5 h-3.5 text-amber-400" />
            معاينة المتقاربة
          </button>

          <button
            type="button"
            onClick={onDeleteAllNear}
            disabled={!nearPairs.length}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-amber-400/15 border border-amber-400/40 text-amber-200 hover:bg-amber-400/25 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            حذف المتقاربة (إبقاء الأولى)
          </button>

          {deletedCount > 0 && (
            <button
              type="button"
              onClick={onRestoreAllDeleted}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-800 text-cyan-300 hover:bg-slate-700 cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              استعادة المحذوف ({deletedCount})
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 text-slate-300">
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showIds}
              onChange={(e) => setShowIds(e.target.checked)}
              className="accent-cyan-400"
            />
            أرقام النقاط
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showPartAreas}
              onChange={(e) => setShowPartAreas(e.target.checked)}
              className="accent-cyan-400"
            />
            المساحات على الرسم
          </label>
          <button
            type="button"
            onClick={() => setShowDeleted((v) => !v)}
            className="inline-flex items-center gap-1 text-slate-300 hover:text-white cursor-pointer"
          >
            {showDeleted ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {showDeleted ? 'إظهار المحذوفة' : 'إخفاء المحذوفة'}
          </button>
        </div>
      </div>

      {/* Main Split: AutoCAD Model Space Canvas + Connected Parts Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12">
        {/* CAD Viewport */}
        <div ref={containerRef} className="lg:col-span-9 relative bg-[#090e17] min-h-[540px] lg:h-[620px]">
          <canvas
            ref={canvasRef}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
              setMousePos(null);
              setSnappedKey(null);
              handleMouseUp();
            }}
            onDoubleClick={() => {
              if (mode === 'pan') zoomExtents();
            }}
            className={`w-full h-full block select-none ${
              mode === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-none'
            }`}
          />

          {/* Legend overlay (quiet top-right micro strip) */}
          <div className="pointer-events-none absolute top-3 right-3 flex flex-wrap items-center gap-3 px-3 py-1.5 rounded-md bg-[#090e17]/85 border border-slate-800 text-[11px] text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 inline-block" />
              نقطة فعّالة
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
              نقطة متقاربة
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" />
              توصيل جاري
            </span>
            <span className="inline-flex items-center gap-1.5 text-rose-400">
              <span>×</span>
              محذوفة
            </span>
          </div>

          {/* Part Naming Popover upon closing polygon */}
          {pendingNamePrompt && (
            <div className="absolute inset-0 bg-slate-950/60 flex items-center justify-center p-4 z-20">
              <div className="w-full max-w-sm rounded-xl border border-cyan-500/40 bg-[#11192a] p-5 shadow-2xl">
                <h3 className="text-base font-bold text-white mb-1">تسمية الجزء الجديد</h3>
                <p className="text-xs text-slate-400 mb-3">
                  تم توصيل {pendingNamePrompt.pointKeys.length} نقاط. أدخل اسم الجزء لتطبيقه في الجدول وجميع المخرجات.
                </p>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={draftPartName}
                  onChange={(e) => setDraftPartName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmPartName();
                    if (e.key === 'Escape') setPendingNamePrompt(null);
                  }}
                  placeholder="مثال: A أو مبنى 1 أو قطعة أ"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-700 bg-[#090e17] text-white text-sm mb-4 focus:outline-none focus:border-cyan-400"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPendingNamePrompt(null)}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 cursor-pointer"
                  >
                    إلغاء
                  </button>
                  <button
                    type="button"
                    onClick={confirmPartName}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer"
                  >
                    حفظ وتسمية الجزء
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* CAD Bottom Coordinate Status Strip */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-1.5 border-t border-slate-800 bg-[#0b101b] text-[11px] text-slate-400">
            <div className="flex items-center gap-3 font-mono tabular-nums" dir="ltr">
              <span className="inline-flex items-center gap-1 text-cyan-300">
                <Crosshair className="w-3.5 h-3.5" />
                {liveWorldCoords
                  ? `E: ${liveWorldCoords.x.toFixed(3)}   N: ${liveWorldCoords.y.toFixed(3)}`
                  : 'E: —   N: —'}
              </span>
              <span className="text-slate-600">|</span>
              <span>Active: {activePoints.length} pts</span>
            </div>
            <div className="text-slate-400">
              {mode === 'connect'
                ? 'انقر النقاط بالترتيب ثم انقر الأولى لإغلاق الجزء · Backspace للتراجع · المسافة+سحب للتحريك'
                : mode === 'delete'
                  ? 'انقر النقطة لحذفها أو استعادتها · Shift+سحب لتحديد عدة نقاط'
                  : 'اسحب للتحريك · عجلة الفأرة للتكبير والتصغير'}
            </div>
          </div>
        </div>

        {/* Connected Parts & Naming Sidebar */}
        <aside className="lg:col-span-3 border-t lg:border-t-0 lg:border-r border-slate-800 bg-[#0d1422] flex flex-col justify-between">
          <div className="p-4 flex-1 overflow-y-auto max-h-[540px]">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-slate-100">الأجزاء المتصلة ({partSummaries.length})</h3>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onAutoConnectFromFile}
                  title="توصيل تلقائي حسب ترتيب الملف"
                  className="p-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-cyan-300 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                </button>
                {partSummaries.length > 0 && (
                  <button
                    type="button"
                    onClick={onClearAllParts}
                    title="مسح جميع الأجزاء للبدء من جديد"
                    className="p-1.5 rounded bg-slate-800 text-slate-300 hover:bg-rose-500/20 hover:text-rose-300 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {partSummaries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-700 bg-[#090e17]/60 p-4 text-center">
                <p className="text-xs text-slate-300 leading-relaxed mb-3">
                  لا توجد أجزاء متصلة بعد. اختر أداة <strong>توصيل النقاط</strong> وانقر على النقاط بالترتيب على الشاشة، ثم انقر النقطة الأولى لإغلاق الجزء وتسميته.
                </p>
                <button
                  type="button"
                  onClick={onAutoConnectFromFile}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-cyan-300 hover:bg-slate-700 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  توصيل مبدئي من ترتيب الملف
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {partSummaries.map((part, i) => (
                  <div
                    key={part.id}
                    onMouseEnter={() => setHoveredPartId(part.id)}
                    onMouseLeave={() => setHoveredPartId(null)}
                    className="rounded-lg border border-slate-800 bg-[#0b101b] p-2.5 transition-colors hover:border-slate-700"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="w-3 h-3 rounded-sm shrink-0"
                        style={{ backgroundColor: part.color }}
                      />
                      <span className="text-[11px] font-mono text-slate-500 tabular-nums shrink-0">
                        #{i + 1}
                      </span>
                      <input
                        type="text"
                        value={part.name}
                        onChange={(e) => onRenamePart(part.id, e.target.value)}
                        aria-label={`اسم الجزء ${i + 1}`}
                        className="w-full px-2 py-1 rounded border border-slate-700/80 bg-[#090e17] text-slate-100 text-xs font-semibold focus:outline-none focus:border-cyan-400"
                      />
                      <button
                        type="button"
                        title="تركيز على الجزء"
                        onClick={() => zoomToPoints(part.pts, 3)}
                        className="p-1.5 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 cursor-pointer shrink-0"
                      >
                        <Focus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title="حذف هذا الجزء"
                        onClick={() => onDeletePart(part.id)}
                        className="p-1.5 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono tabular-nums" dir="ltr">
                      <span>{part.pts.length} pts</span>
                      <span>{part.area.toFixed(2)} m² · {(part.area / FED).toFixed(4)} Fed</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Apply to All Outputs Action */}
          <div className="p-4 border-t border-slate-800 bg-[#0b101b]">
            {hasPendingChanges && partSummaries.length > 0 && (
              <p className="text-[11px] text-amber-300 mb-2">
                توجد تعديلات لم تُطبّق بعد على المخرجات والملفات.
              </p>
            )}
            <button
              type="button"
              disabled={partSummaries.length === 0}
              onClick={onApplyToOutputs}
              className={`w-full py-2.5 px-4 rounded-lg text-sm font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                hasPendingChanges
                  ? 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                  : 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
              }`}
            >
              تطبيق على كافة المخرجات
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
};
