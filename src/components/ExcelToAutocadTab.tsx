import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Copy, Download } from 'lucide-react';
import { CoordRow, downloadBlob, extractCoordTable } from '../lib/cadExport';

interface ExcelToAutocadTabProps {
  coordRows: CoordRow[];
}

export const ExcelToAutocadTab: React.FC<ExcelToAutocadTabProps> = ({ coordRows }) => {
  const [localRows, setLocalRows] = useState<CoordRow[]>(coordRows);
  const [srcLabel, setSrcLabel] = useState('جدول الإحداثيات الحالي');
  const [mode, setMode] = useState('num');
  const [th, setTh] = useState(1);
  const [rot, setRot] = useState(0);
  const [ox, setOx] = useState(0.25);
  const [oy, setOy] = useState(0.25);
  const [sides, setSides] = useState(4);
  const [radius, setRadius] = useState(1);
  const [justifyCenter, setJustifyCenter] = useState(true);
  const [closeShape, setCloseShape] = useState(false);
  const [copied, setCopied] = useState(false);

  const f3 = (n: number) => String(+Number(n).toFixed(3));

  const generated = useMemo(() => {
    const o: string[] = [];
    let skipped = 0;
    const s = Math.max(3, Math.round(sides) || 4);
    const h = th || 1;
    const R = radius || 1;

    if (mode === 'lin' || mode === 'ply') {
      if (localRows.length) {
        o.push(mode === 'lin' ? 'LINE' : 'PLINE');
        localRows.forEach((r) => o.push(`${f3(r[1])},${f3(r[2])}`));
        o.push(closeShape ? 'C' : '');
      }
    } else {
      localRows.forEach((r, i) => {
        const x = f3(r[1]);
        const y = f3(r[2]);
        const tx = f3(r[1] + ox);
        const ty = f3(r[2] + oy);
        const pushText = (txt: string | number) => {
          const val = String(txt ?? '').trim();
          if (!val) {
            skipped++;
            return;
          }
          o.push(`-text ${i === 0 && justifyCenter ? 'J MC ' : ''}${tx},${ty} ${h} ${rot} ${val}`);
        };
        if (mode === 'px') o.push(`point ${x},${y}`);
        else if (mode === 'pxz') o.push(`point ${x},${y},${f3(r[3] === null ? 0 : r[3])}`);
        else if (mode === 'num') pushText(r[0]);
        else if (mode === 'lvl') {
          if (r[3] === null) skipped++;
          else pushText('Z=' + f3(r[3]));
        } else if (mode === 'dsc') pushText(r[4]);
        else if (mode === 'lbl') pushText(`E=${x} N=${y}`);
        else if (mode === 'pol') o.push(`pol ${s} ${x},${y}  ${R}`);
        else if (mode === 'cir') o.push(`c ${x},${y} ${R}`);
      });
    }

    return { text: o.length ? o.join('\n') + '\n' : '', lines: o.length, skipped };
  }, [closeShape, justifyCenter, localRows, mode, ox, oy, radius, rot, sides, th]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const res = extractCoordTable(XLSX.read(new Uint8Array(fr.result as ArrayBuffer), { type: 'array' }));
        if (!res) {
          setSrcLabel('لم يتم العثور على أعمدة Easting / Northing في الملف.');
          return;
        }
        setLocalRows(res.rows);
        setSrcLabel(`${f.name} (${res.sheet})`);
      } catch {
        setSrcLabel('تعذرت قراءة الملف.');
      }
    };
    fr.readAsArrayBuffer(f);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-800 bg-[#101725] p-5">
        <h2 className="text-base font-bold text-cyan-300 mb-1">نقل البيانات من الاكسل إلى الأوتوكاد</h2>
        <p className="text-xs text-slate-400 mb-4">
          اختر أمر الرسم واضبط الخيارات ثم انسخ السطور والصقها في سطر الأوامر داخل AutoCAD / GstarCAD أو حمّلها كملف .scr.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">ملف النقاط (xlsx / xlsm / csv)</label>
            <input
              type="file"
              accept=".xlsx,.xlsm,.xls,.csv,.txt"
              onChange={handleFile}
              className="w-full text-xs text-slate-200 file:ml-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-100 hover:file:bg-slate-700 cursor-pointer"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => {
                setLocalRows(coordRows);
                setSrcLabel('جدول الإحداثيات الحالي');
              }}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
            >
              استخدام نقاط تبويب جدول الإحداثيات
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-400 mb-4">المصدر: {srcLabel}</p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="block text-slate-400 mb-1">أمر الرسم</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
            >
              <option value="px">Point XY</option>
              <option value="pxz">Point XYZ</option>
              <option value="num">Point Number Text</option>
              <option value="lvl">Level As Text</option>
              <option value="dsc">Description Text</option>
              <option value="lbl">Coordinates Label</option>
              <option value="pol">Polygon</option>
              <option value="cir">Circle</option>
              <option value="lin">Line</option>
              <option value="ply">Polyline</option>
            </select>
          </div>
          <div>
            <label className="block text-slate-400 mb-1">ارتفاع النص</label>
            <input
              type="number"
              dir="ltr"
              step="0.1"
              min="0.01"
              value={th}
              onChange={(e) => setTh(Number(e.target.value))}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100 font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">دوران النص (°)</label>
            <input
              type="number"
              dir="ltr"
              step="1"
              value={rot}
              onChange={(e) => setRot(Number(e.target.value))}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100 font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">إزاحة X / Y (م)</label>
            <div className="grid grid-cols-2 gap-1.5" dir="ltr">
              <input
                type="number"
                step="0.05"
                value={ox}
                onChange={(e) => setOx(Number(e.target.value))}
                className="w-full px-2 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100 font-mono"
              />
              <input
                type="number"
                step="0.05"
                value={oy}
                onChange={(e) => setOy(Number(e.target.value))}
                className="w-full px-2 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100 font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-slate-400 mb-1">أضلاع المضلع</label>
            <input
              type="number"
              dir="ltr"
              min="3"
              value={sides}
              onChange={(e) => setSides(Number(e.target.value))}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100 font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">نصف القطر</label>
            <input
              type="number"
              dir="ltr"
              step="0.1"
              min="0.001"
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-100 font-mono"
            />
          </div>
          <div className="col-span-2 flex flex-wrap items-center gap-4 pt-4">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={justifyCenter}
                onChange={(e) => setJustifyCenter(e.target.checked)}
                className="accent-cyan-400"
              />
              توسيط النص (Middle-Centre)
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={closeShape}
                onChange={(e) => setCloseShape(e.target.checked)}
                className="accent-cyan-400"
              />
              إغلاق Line / Polyline
            </label>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#101725] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <h3 className="text-sm font-bold text-slate-200">الأسطر الجاهزة للأوتوكاد</h3>
          <span className="text-xs text-slate-400 font-mono tabular-nums">
            {localRows.length} نقطة ← {generated.lines} سطر
            {generated.skipped ? ` · تم تخطي ${generated.skipped}` : ''}
          </span>
        </div>
        <textarea
          readOnly
          dir="ltr"
          value={generated.text}
          className="w-full h-64 p-3 rounded-lg border border-slate-800 bg-[#070b12] text-sky-300 font-mono text-xs mb-3"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              if (!generated.text) return;
              await navigator.clipboard.writeText(generated.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? 'تم النسخ!' : 'نسخ لسطر أوامر الأوتوكاد'}
          </button>
          <button
            type="button"
            onClick={() =>
              generated.text &&
              downloadBlob(`excel_to_autocad_${mode}.scr`, new Blob([generated.text], { type: 'text/plain' }))
            }
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            تحميل .scr
          </button>
        </div>
      </div>
    </div>
  );
};
