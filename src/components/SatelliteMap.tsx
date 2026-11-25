import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { AppliedGISModel, toLL } from '../lib/cadastral';

interface SatelliteMapProps {
  model: AppliedGISModel;
  showIds: boolean;
}

export const SatelliteMap: React.FC<SatelliteMapProps> = ({ model, showIds }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groupRef = useRef<L.FeatureGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { maxZoom: 22, preferCanvas: true }).setView([30.5, 31], 7);
    const makeGoogle = (layer: string) =>
      L.tileLayer(`https://mt{s}.google.com/vt/lyrs=${layer}&x={x}&y={y}&z={z}`, {
        subdomains: '0123',
        maxZoom: 22,
        maxNativeZoom: 20,
        attribution: 'Imagery © Google',
      });
    const sat = makeGoogle('s').addTo(map);
    L.control
      .layers({
        'Google Satellite': sat,
        'Google Hybrid': makeGoogle('y'),
        'Esri Imagery': L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 22, maxNativeZoom: 19 }
        ),
      })
      .addTo(map);

    const grp = L.featureGroup().addTo(map);
    mapRef.current = map;
    groupRef.current = grp;

    return () => {
      map.remove();
      mapRef.current = null;
      groupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const grp = groupRef.current;
    if (!map || !grp) return;

    grp.clearLayers();
    model.partsLL.forEach((p) => {
      L.polygon(p.ring, { color: '#22d3ee', weight: 2, fillOpacity: 0.1, interactive: false })
        .bindTooltip(p.name, { permanent: true, direction: 'center', className: 'ptl' })
        .addTo(grp);
    });

    if (model.boundaryLL.length >= 3) {
      L.polygon(model.boundaryLL, { color: '#fbbf24', weight: 3, fill: false, interactive: false }).addTo(grp);
    }

    const seen = new Set<string>();
    model.parts.forEach((p) =>
      p.pts.forEach((q) => {
        if (seen.has(q.key)) return;
        seen.add(q.key);
        const [lon, lat] = toLL(q.x, q.y);
        const m = L.circleMarker([lat, lon], {
          radius: 5,
          color: '#ffffff',
          weight: 1.5,
          fillColor: '#22d3ee',
          fillOpacity: 0.95,
        }).addTo(grp);
        if (showIds) {
          m.bindTooltip(q.id, { permanent: true, direction: 'top', offset: [0, -6], className: 'ptl' });
        }
      })
    );

    const bounds = grp.getBounds();
    if (bounds.isValid()) {
      setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(bounds.pad(0.15), { maxZoom: 20 });
      }, 100);
    }
  }, [model, showIds]);

  return <div ref={containerRef} className="w-full h-[460px] rounded-lg overflow-hidden border border-slate-800" />;
};
