import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { ArrowLeft, Copy, Download, FileSpreadsheet } from 'lucide-react';
import { CoordRow, extractCoordTable } from '../lib/cadExport';

interface CoordinatesTableTabProps {
  coordRows: CoordRow[];
  sourceName: string;
  onUpdateCoords: (rows: CoordRow[], sourceName: string) => void;
  onUseInStudio: (rows: CoordRow[], sourceName: string) => void;
}

const HEAD = ['ID', 'Easting (Meter)', 'Northing (Meter)', 'Elevation (Meter)', 'Feature Code'];

export const CoordinatesTableTab: React.FC<CoordinatesTableTabProps> = ({
  coordRows,
  sourceName,
  onUpdateCoords,
  onUseInStudio,
}) => {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [metaText, setMetaText] = useState('UTM Zone 36 North — WGS 1984 — الوحدات بالمتر');
  const [status, setStatus] = useState<{ text: string; type: 'neutral' | 'ok' | 'err' }>({
    text: '',
    type: 'neutral',
  });

  const fmt = (v: number | null) => (v === null || v === undefined ? '' : Number(v).toFixed(3));

  const handleProcess = () => {
    if (!pendingFile) return;
    const reader = new FileReader();
    reader.onerror = () => setStatus({ text: 'تعذّرت قراءة الملف.', type: 'err' });
    reader.onload = () => {
      try {
        const wb = XLSX.read(new Uint8Array(reader.result as ArrayBuffer), { type: 'array' });
        const res = extractCoordTable(wb);
        if (!res) {
          setStatus({
            text: 'لم أجد جدول إحداثيات: المطلوب صف عناوين فيه عمودان Easting و Northing (أو X و Y) وتحته أرقام.',
            type: 'err',
          });
          return;
        }
        const cleanName = pendingFile.name.replace(/\.[^.]+$/, '') || 'coordinates';
        const parts: string[] = [];
        if (res.zone) parts.push('Zone ' + res.zone);
        if (res.datum) parts.push(res.datum);
        setMetaText((parts.length ? parts.join(' — ') + ' — ' : '') + `المصدر: ${pendingFile.name} (${res.sheet})`);
        onUpdateCoords(res.rows, cleanName);
        setStatus({ text: `تمت المعالجة: ${res.rows.length} نقطة. يمكنك استخدامها الآن في شاشة الأوتوكاد.`, type: 'ok' });
      } catch {
        setStatus({ text: 'تعذّرت معالجة الملف. تأكد أنه xlsx أو csv سليم.', type: 'err' });
      }
    };
    reader.readAsArrayBuffer(pendingFile);
  };

  const handleCopy = async () => {
    const t = [HEAD.join('\t')]
      .concat(coordRows.map((r) => [r[0], fmt(r[1]), fmt(r[2]), fmt(r[3]), r[4]].join('\t')))
      .join('\n');
    try {
      await navigator.clipboard.writeText(t);
      setStatus({ text: 'تم النسخ، الصقه في Excel.', type: 'ok' });
    } catch {
      setStatus({ text: 'تعذّر النسخ.', type: 'err' });
    }
  };

  const handleDownloadXlsx = () => {
    const aoa: (string | number | null)[][] = [HEAD, ...coordRows.map((r) => [...r])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }];
    for (let R = 1; R < aoa.length; R++) {
      for (let C = 1; C <= 3; C++) {
        const c = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (c && c.t === 'n') c.z = '0.000';
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Coordinates');
    XLSX.writeFile(wb, `${sourceName}_processed.xlsx`);
    setStatus({ text: `تم تحميل الملف: ${sourceName}_processed.xlsx`, type: 'ok' });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-800 bg-[#101725] p-5">
        <h2 className="text-base font-bold text-cyan-300 mb-1">رفع ملف ومعالجته</h2>
        <p className="text-xs text-slate-400 mb-4">{metaText}</p>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.txt"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setPendingFile(f);
              setStatus({ text: f ? 'اضغط «معالجة» لاستخراج جدول الإحداثيات.' : '', type: 'neutral' });
            }}
            className="text-xs text-slate-200 file:ml-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-100 hover:file:bg-slate-700 cursor-pointer"
          />
          <button
            type="button"
            disabled={!pendingFile}
            onClick={handleProcess}
            className="px-4 py-2 rounded-lg text-xs font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            معالجة
          </button>
        </div>

        {status.text && (
          <p
            className={`mt-3 text-xs ${
              status.type === 'ok' ? 'text-emerald-400' : status.type === 'err' ? 'text-rose-400' : 'text-slate-400'
            }`}
          >
            {status.text}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#101725] p-5">
        <div className="overflow-x-auto rounded-lg border border-slate-800" dir="ltr">
          <table className="w-full text-xs text-center border-collapse">
            <thead>
              <tr className="bg-slate-900/90 text-cyan-300 border-b border-slate-800">
                {HEAD.map((h) => (
                  <th key={h} className="px-3 py-2.5 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
              {coordRows.map((r, i) => (
                <tr key={i} className="hover:bg-slate-800/40">
                  <td className="px-3 py-2">{r[0]}</td>
                  <td className="px-3 py-2">{fmt(r[1])}</td>
                  <td className="px-3 py-2">{fmt(r[2])}</td>
                  <td className="px-3 py-2">{fmt(r[3])}</td>
                  <td className="px-3 py-2">{r[4]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
          <span className="text-xs text-slate-400 font-mono tabular-nums">عدد النقاط: {coordRows.length}</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onUseInStudio(coordRows, sourceName)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              استخدام النقاط في شاشة الأوتوكاد
            </button>
            <button
              type="button"
              onClick={handleDownloadXlsx}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              تحميل Excel (xlsx)
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" />
              نسخ الجدول
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
