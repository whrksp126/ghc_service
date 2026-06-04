// Shared camera-lens classification used everywhere we offer "switch camera / lens" UI
// (room tiles, lobby preview, camera manager). The browser's enumerateDevices() is wildly
// inconsistent across platforms, so all the heuristics live HERE in one place:
//
// - Facing (front/back) cannot be read reliably from getCapabilities().facingMode on iOS
//   Safari, so we infer it from the device label across locales, with the active track's real
//   facingMode as an override when known. (Android Chrome labels carry "facing back/front".)
// - iOS exposes VIRTUAL logical cameras ("Back Dual Camera", "Back Triple Camera") that just
//   re-expose a physical lens — switching to them shows no FOV change. We drop these when a
//   real single-lens sibling of the same facing exists, so the user only sees distinct lenses.
// - Zoom/lens kind (ultra-wide 0.5× / wide 1× / tele 2× / periscope) is inferred from the label.
//
// Refs: Android logical multi-camera enumeration (developer.android.com/media/camera/camera2/
// camera-enumeration); iOS 16.3+ exposes all back lenses but with no facing identifier and
// localizable labels (webkit.org/b/253186, dominikschilling.de ios-access-all-back-cameras).

export type Facing = 'user' | 'environment' | 'unknown';

const FRONT_KW = ['front', '전면', 'facetime', 'truedepth', 'selfie', '셀카', '셀피', 'user-facing'];
const BACK_KW = ['back', 'rear', '후면', 'environment', 'world-facing', 'world'];
// Logical/virtual cameras that overlap a physical lens — dropped when a real sibling exists.
const COMBO_KW = ['dual', 'triple', 'duo', 'trio', 'combo', 'multi', '듀얼', '트리플'];
const ULTRA_KW = ['ultra', '초광각'];
const TELE_KW = ['tele', 'telephoto', '망원'];
const PERISCOPE_KW = ['periscope', '잠망경'];

// Display label per zoom rank. Index = rank. Unknown ranks fall back to ordinals upstream.
export const ZOOM_BY_RANK = ['0.5×', '1×', '2×', '5×'];

export function guessFacing(label: string): Facing {
  const l = (label || '').toLowerCase();
  // Front keywords win first: "Front Ultra Wide" should be front, not matched on a stray word.
  if (FRONT_KW.some((k) => l.includes(k))) return 'user';
  if (BACK_KW.some((k) => l.includes(k))) return 'environment';
  return 'unknown';
}

export function lensZoomRank(label: string): number {
  const l = (label || '').toLowerCase();
  if (ULTRA_KW.some((k) => l.includes(k))) return 0; // ultra-wide (0.5×)
  if (PERISCOPE_KW.some((k) => l.includes(k))) return 3; // periscope (~5×)
  if (TELE_KW.some((k) => l.includes(k))) return 2; // telephoto (2×)
  return 1; // wide / main / unknown (1×)
}

function isComboLabel(label: string): boolean {
  const l = (label || '').toLowerCase();
  return COMBO_KW.some((k) => l.includes(k));
}

export interface CameraLens {
  deviceId: string;
  label: string;
  facing: Facing;
  /** 0 ultra-wide · 1 wide/main · 2 tele · 3 periscope. */
  zoomRank: number;
}

/**
 * Turn a raw enumerateDevices() result into the cleaned, ordered lens list we actually show
 * and index against. Dedupes by deviceId, drops virtual combo cameras when a real same-facing
 * sibling exists, and assigns facing/zoom. Pass the active track's real facingMode so at least
 * the live camera is labelled correctly even when its label is opaque.
 *
 * IMPORTANT: the returned order is the canonical lens index used for remote switching, so the
 * device that produces this list and the peers that display it must run the SAME function.
 */
export function classifyCameras(
  devices: Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[],
  opts?: { activeDeviceId?: string | null; activeFacing?: Facing },
): CameraLens[] {
  const seen = new Set<string>();
  const raw = devices
    .filter((d) => d.kind === 'videoinput')
    .filter((d) => {
      if (!d.deviceId) return true; // keep unlabelled (pre-permission) entries
      if (seen.has(d.deviceId)) return false;
      seen.add(d.deviceId);
      return true;
    })
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `카메라 ${i + 1}`,
      facing: guessFacing(d.label),
      zoomRank: lensZoomRank(d.label),
      combo: isComboLabel(d.label),
    }));

  // Override the active camera's facing with its real settings when the label was opaque.
  if (opts?.activeDeviceId && opts.activeFacing && opts.activeFacing !== 'unknown') {
    const a = raw.find((x) => x.deviceId === opts.activeDeviceId);
    if (a && a.facing === 'unknown') a.facing = opts.activeFacing;
  }

  // Drop virtual combo cameras only when a real single-lens sibling of the same facing exists
  // (so a device that ONLY exposes a combo still keeps it).
  const realFacings = new Set(raw.filter((x) => !x.combo).map((x) => x.facing));
  const cleaned = raw.filter((x) => !(x.combo && realFacings.has(x.facing)));

  return cleaned.map(({ deviceId, label, facing, zoomRank }) => ({ deviceId, label, facing, zoomRank }));
}

// ---- Display roster (shared by the CameraLensControl UI) --------------------------------

/** A lens as the switcher UI consumes it. `key` is a deviceId (local) or a stringified index
 *  (remote), opaque to the component — it just passes it back to onSelect. */
export interface DisplayLens {
  key: string;
  facing: Facing;
  zoomRank: number;
}

export interface LensRoster {
  /** Front/back toggle is only meaningful when both facings are present. */
  canToggleFacing: boolean;
  currentFacing: Facing;
  /** The lens chips to show for the current facing (or all lenses when ungrouped). */
  group: DisplayLens[];
  /** First lens of the opposite facing, for the flip button. */
  flipTarget: DisplayLens | null;
}

/** Derive what the switcher should render for a lens list + the currently active key. */
export function buildRoster(lenses: DisplayLens[], activeKey: string | null): LensRoster {
  const active = lenses.find((l) => l.key === activeKey) ?? null;
  const front = lenses.filter((l) => l.facing === 'user');
  const back = lenses.filter((l) => l.facing === 'environment');
  const canToggleFacing = front.length > 0 && back.length > 0;

  const currentFacing: Facing = active
    ? active.facing
    : back.length
      ? 'environment'
      : front.length
        ? 'user'
        : 'unknown';

  const group = canToggleFacing
    ? currentFacing === 'user'
      ? front
      : back
    : lenses;
  const sorted = [...group].sort((a, b) => a.zoomRank - b.zoomRank);

  const flipTarget = canToggleFacing ? (currentFacing === 'user' ? back[0] : front[0]) ?? null : null;

  return { canToggleFacing, currentFacing, group: sorted, flipTarget };
}

/** Chip label for a lens within its group: ×-zoom labels when at least one lens is clearly
 *  non-default, otherwise plain ordinals ("렌즈 1"). */
export function lensChipLabel(group: DisplayLens[], lens: DisplayLens, index: number): string {
  const hasZoomHint = group.some((l) => l.zoomRank !== 1);
  if (!hasZoomHint) return `렌즈 ${index + 1}`;
  return ZOOM_BY_RANK[lens.zoomRank] ?? `${index + 1}×`;
}
