import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { AppliedGISModel, CadExportSettings } from '../lib/cadastral';
import { CanvasPaintOptions, CanvasView, downloadBlob, paintCadCanvas } from '../lib/cadExport';

interface CadPreviewPanelProps {
  model: AppliedGISModel;
  settings: CadExportSettings;
  onSettingsChange: (next: Partial<CadExportSettings>) => void;
  onDownloadDxf: () => void;
}

export const CadPreviewPanel: React.FC<CadPreviewPanelProps> = ({
  model,
  settings,
  onSettingsChange,
  onDownloadDxf,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<CanvasView | null>(null);
  const dprRef = useRef<number>(1);
  const fitRef = useRef<boolean>(true);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const [showAreas, setShowAreas] = useState(true);
  const [darkBg, setDarkBg] = useState(true);
  const [dimFontSize, setDimFontSize] = useState(20);

  const buildOpts = useCallback(
    (k: number): CanvasPaintOptions => ({
      names: settings.includePartNames,
      dims: settings.includeDims,
      pts: settings.includePoints,
      areas: showAreas,
      north: settings.includeNorth,
      dark: darkBg,
      k,
      m: (settings.includeDims ? dimFontSize * 1.7 + 70 : 60) * k,
      lw: 1.8 * k,
      dot: 3.5 * k,
      nf: 15 * k,
      idf: 11 * k,
      af: 12 * k,
      df: dimFontSize * k,
      off: (dimFontSize * 1.5 + 8) * k,
      scale: true,
      arrow: [46 * k, 100 * k, 60 * k],
    }),
    [darkBg, dimFontSize, settings, showAreas]
  );

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const d = window.devicePixelRatio || 1;
    const W = Math.round(cv.clientWidth * d);
    const H = Math.round(cv.clientHeight * d);
    if (!W || !H) return;
    dprRef.current = d;
    viewRef.current = paintCadCanvas(cv, model, W, H, buildOpts(d), fitRef.current ? null : viewRef.current);
  }, [buildOpts, model]);

  useEffect(() => {
    fitRef.current = true;
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  const zoom = (factor: number, mx?: number, my?: number) => {
    const v = viewRef.current;
    const cv = canvasRef.current;
    if (!v || !cv) return;
    const cx = mx ?? cv.width / 2;
    const cy = my ?? cv.height / 2;
    v.ox = cx - (cx - v.ox) * factor;
    v.oy = cy - (cy - v.oy) * factor;
    v.s *= factor;
    fitRef.current = false;
    draw();
  };

  const handleSave = (ext: 'png' | 'jpg') => {
    const tmp = document.createElement('canvas');
    paintCadCanvas(tmp, model, 2400, 1700, buildOpts(2), null);
    tmp.toBlob(
      (b) => b && downloadBlob(`cad_preview.${ext}`, b),
      ext === 'jpg' ? 'image/jpeg' : 'image/png',
      0.95
    );
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-[#101725] p-4">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-200">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.includePartNames}
              onChange={(e) => onSettingsChange({ includePartNames: e.target.checked })}
              className="accent-cyan-400"
            />
            أسماء الأجزاء
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.includeDims}
              onChange={(e) => onSettingsChange({ includeDims: e.target.checked })}
              className="accent-cyan-400"
            />
            الأبعاد (م)
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.includePoints}
              onChange={(e) => onSettingsChange({ includePoints: e.target.checked })}
              className="accent-cyan-400"
            />
            النقاط والأرقام
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showAreas}
              onChange={(e) => setShowAreas(e.target.checked)}
              className="accent-cyan-400"
            />
            المساحات
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.includeNorth}
              onChange={(e) => onSettingsChange({ includeNorth: e.target.checked })}
              className="accent-cyan-400"
            />
            سهم الشمال
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={darkBg}
              onChange={(e) => setDarkBg(e.target.checked)}
              className="accent-cyan-400"
            />
            خلفية أوتوكاد داكنة
          </label>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-300">
          <span className="font-mono tabular-nums">حجم خط الأبعاد: {dimFontSize}px</span>
          <input
            type="range"
            min={10}
            max={50}
            value={dimFontSize}
            onChange={(e) => setDimFontSize(Number(e.target.value))}
            className="w-28 accent-cyan-400"
          />
        </div>
      </div>

      <canvas
        ref={canvasRef}
        onWheel={(e) => {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          zoom(
            Math.exp(-e.deltaY * 0.0015),
            (e.clientX - rect.left) * dprRef.current,
            (e.clientY - rect.top) * dprRef.current
          );
        }}
        onPointerDown={(e) => {
          if (!viewRef.current) return;
          dragRef.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragRef.current || !viewRef.current) return;
          viewRef.current.ox += (e.clientX - dragRef.current.x) * dprRef.current;
          viewRef.current.oy += (e.clientY - dragRef.current.y) * dprRef.current;
          dragRef.current = { x: e.clientX, y: e.clientY };
          fitRef.current = false;
          draw();
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
        onDoubleClick={() => {
          fitRef.current = true;
          draw();
        }}
        className="w-full h-[540px] rounded-lg border border-slate-800 block cursor-grab active:cursor-grabbing touch-none mb-3"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => zoom(1.35)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" /> تكبير
          </button>
          <button
            type="button"
            onClick={() => zoom(1 / 1.35)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" /> تصغير
          </button>
          <button
            type="button"
            onClick={() => {
              fitRef.current = true;
              draw();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" /> ملاءمة
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleSave('png')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> تحميل PNG
          </button>
          <button
            type="button"
            onClick={() => handleSave('jpg')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> تحميل JPG
          </button>
          <button
            type="button"
            onClick={onDownloadDxf}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> تحميل DXF
          </button>
        </div>
      </div>
    </div>
  );
};
