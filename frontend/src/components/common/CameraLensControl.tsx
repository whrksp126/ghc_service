import { SwitchCamera } from 'lucide-react';
import { buildRoster, lensChipLabel, type DisplayLens } from '../../lib/cameraLenses';

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
