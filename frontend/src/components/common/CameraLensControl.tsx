import { SwitchCamera } from 'lucide-react';
import { buildRoster, lensChipLabel, type DisplayLens } from '../../lib/cameraLenses';
import { useAlwaysOnCamera, type ZoomRange } from '../../services/alwaysOnCamera';

interface CameraLensControlProps {
  /** Lenses to offer. `key` is opaque (deviceId for local, index string for remote). */
  lenses: DisplayLens[];
  /** Currently active lens key. */
  activeKey: string | null;
  /** Selecting a lens (flip button or a zoom chip) calls this with the lens key. */
  onSelect: (key: string) => void;
  disabled?: boolean;
  /** Compact sizing for small viewers (lobby grid tiles) so it never overflows the tile. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Shared smartphone-style lens switcher used on every camera viewer (room tiles, lobby preview,
 * camera manager). Front/back toggle (only when both facings exist) + zoom-lens chips for the
 * active facing. Pure presentation — the caller maps `key` back to a deviceId or a remote index.
 * Wraps to a second row rather than overflowing when the viewer is narrow.
 */
export function CameraLensControl({ lenses, activeKey, onSelect, disabled, size = 'md', className = '' }: CameraLensControlProps) {
  if (lenses.length <= 1) return null;
  const { canToggleFacing, currentFacing, group, frontFirst, backFirst } = buildRoster(lenses, activeKey);

  const sm = size === 'sm';
  const chipCls = sm ? 'h-6 min-w-[1.75rem] px-1.5 text-[11px]' : 'h-8 min-w-[2rem] px-2 text-xs';
  // Plain flip icon (no front/back text) toggles to the other facing — the viewer itself shows
  // which camera you're on, so a label only invited confusion.
  const flipTarget = currentFacing === 'user' ? backFirst : frontFirst;

  return (
    <div className={`flex flex-wrap items-center justify-center ${sm ? 'gap-1' : 'gap-2'} max-w-full ${className}`}>
      {canToggleFacing && flipTarget && (
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); onSelect(flipTarget.key); }}
          title="카메라 전환"
          className={`${sm ? 'w-7 h-7' : 'w-9 h-9'} rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 transition-colors disabled:opacity-50`}
        >
          <SwitchCamera size={sm ? 14 : 17} />
        </button>
      )}
      {group.length > 1 && (
        <div className="flex items-center gap-1 bg-black/35 rounded-full p-0.5">
          {group.map((lens, i) => {
            const isActive = lens.key === activeKey;
            return (
              <button
                key={lens.key}
                type="button"
                disabled={disabled}
                onClick={(e) => { e.stopPropagation(); onSelect(lens.key); }}
                className={`${chipCls} rounded-full font-semibold transition-colors disabled:opacity-50 ${
                  isActive ? 'bg-white text-dark-900' : 'text-white/80 hover:bg-white/10'
                }`}
              >
                {lensChipLabel(group, lens, i)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Zoom presets as magnification multiples of the camera's min zoom (1× = widest). Works whether
// the device reports zoom as a magnification (min≈1) or some other unit (value = min × m).
function zoomStops(range: ZoomRange): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = [];
  for (const m of [1, 2, 3, 5, 10]) {
    const value = +(range.min * m).toFixed(2);
    if (value > range.max + 1e-6) break;
    out.push({ value, label: `${m}×` });
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Zoom-level chips for MY current device's active camera (e.g. rear telephoto reachable only as
 * zoom, not a separate deviceId). Reads the always-on store directly; hidden when the camera has
 * no usable zoom range. Same chip styling as the lens switcher.
 */
export function CameraZoomControl({ size = 'md', disabled, className = '' }: { size?: 'sm' | 'md'; disabled?: boolean; className?: string }) {
  const zoomRange = useAlwaysOnCamera((s) => s.zoomRange);
  const zoom = useAlwaysOnCamera((s) => s.zoom);
  const setZoom = useAlwaysOnCamera((s) => s.setZoom);
  if (!zoomRange) return null;
  const stops = zoomStops(zoomRange);
  if (stops.length <= 1) return null;

  const cur = zoom ?? zoomRange.min;
  const activeIdx = stops.reduce((best, s, i) => (Math.abs(s.value - cur) < Math.abs(stops[best].value - cur) ? i : best), 0);
  const sm = size === 'sm';
  const chipCls = sm ? 'h-6 min-w-[1.75rem] px-1.5 text-[11px]' : 'h-8 min-w-[2rem] px-2 text-xs';

  return (
    <div className={`flex items-center gap-1 bg-black/35 rounded-full p-0.5 ${className}`}>
      {stops.map((s, i) => (
        <button
          key={s.value}
          type="button"
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); setZoom(s.value); }}
          className={`${chipCls} rounded-full font-semibold transition-colors disabled:opacity-50 ${
            i === activeIdx ? 'bg-white text-dark-900' : 'text-white/80 hover:bg-white/10'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** Map the local always-on roster to DisplayLens[] (key = deviceId). */
export function lensesFromLocal(cameras: { deviceId: string; facing: DisplayLens['facing']; zoomRank: number }[]): DisplayLens[] {
  return cameras.map((c) => ({ key: c.deviceId, facing: c.facing, zoomRank: c.zoomRank }));
}

/** Map a remote device's reported lens metadata to DisplayLens[] (key = index string). When a
 *  device reports only a count (older client), fall back to N undistinguished lenses. */
export function lensesFromRemote(
  remoteLenses: { facing: DisplayLens['facing']; zoomRank: number }[] | undefined,
  count: number,
): DisplayLens[] {
  if (remoteLenses && remoteLenses.length) {
    return remoteLenses.map((l, i) => ({ key: String(i), facing: l.facing, zoomRank: l.zoomRank }));
  }
  return Array.from({ length: count }, (_, i) => ({ key: String(i), facing: 'unknown' as const, zoomRank: 1 }));
}
