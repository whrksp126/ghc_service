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
  /** Set ONLY for synthetic zoom-lenses (Android optical ultra-wide reached via applyConstraints,
   *  not a distinct deviceId). When present, switching means applyConstraints({ zoom }) on the
   *  same track rather than re-acquiring a new deviceId. See expandWithZoom(). */
  zoom?: number;
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

// ---- Android optical ultra-wide via zoom ------------------------------------------------
//
// Android Chrome exposes only ONE logical back camera per facing — it does NOT enumerate the
// physical ultra-wide/tele lenses as distinct deviceIds (unlike iOS 16.3+). The one genuinely
// OPTICAL path the web exposes is the zoom constraint: on Android 11+ (CONTROL_ZOOM_RATIO) a
// zoom range whose min < 1.0 means there IS a physical ultra-wide, and going below 1.0 cannot be
// done digitally — the OS must switch to that physical lens. So `zoom.min < 1.0` is a reliable
// "real optical ultra-wide present" signal. (Tele is NOT surfaced: we can't tell from the web
// API which zoom ratio crosses to the optical tele lens vs a digital crop.)
//
// We expand the active back camera into TWO synthetic lenses (0.5× = zoom.min, 1× = main) that
// share the SAME deviceId; selecting one calls applyConstraints({ zoom }) on the live track
// (no re-acquire, no SFU renegotiation). Devices without sub-1.0 zoom (Note9-class, single-lens,
// digital-only) get NOTHING extra — exactly the "real optical only, no fakes" requirement.

/** Stable key for a lens: a synthetic zoom-lens keys on its zoom ratio, a real lens on deviceId.
 *  Opaque to the UI — passed straight back to onSelect. */
export function lensKey(l: { deviceId: string; zoom?: number }): string {
  return l.zoom != null ? `z:${l.zoom}` : l.deviceId;
}

/**
 * Expand the active back camera into optical zoom-lenses when (and only when) the device reports
 * a sub-1.0 zoom range. Returns the input unchanged otherwise. The result order is canonical:
 * device and peers MUST run this same function so a remote `cameraIndex` resolves identically.
 */
export function expandWithZoom(
  cameras: CameraLens[],
  opts: { activeDeviceId: string | null; zoom: { min: number; max: number } | null },
): CameraLens[] {
  const { activeDeviceId, zoom } = opts;
  if (!zoom || zoom.min >= 1.0 || !activeDeviceId) return cameras;
  const idx = cameras.findIndex((c) => c.deviceId === activeDeviceId);
  if (idx < 0) return cameras;
  const base = cameras[idx];
  // Only the back logical camera gains an optical ultra-wide step.
  if (base.facing === 'user') return cameras;
  const ultra: CameraLens = { ...base, zoom: zoom.min, zoomRank: 0 }; // 0.5×
  const wide: CameraLens = { ...base, zoom: 1.0, zoomRank: 1 }; // 1×
  const out = [...cameras];
  out.splice(idx, 1, ultra, wide);
  return out;
}

/** The lens key currently live: the zoom-lens nearest the active zoom when expanded, else the
 *  active deviceId. Used to highlight the active chip and to index the broadcast lens list. */
export function activeLensKey(
  expanded: CameraLens[],
  activeDeviceId: string | null,
  activeZoom: number,
): string | null {
  const zoomLenses = expanded.filter((c) => c.zoom != null && c.deviceId === activeDeviceId);
  if (zoomLenses.length) {
    const best = zoomLenses.reduce((a, b) =>
      Math.abs((b.zoom as number) - activeZoom) < Math.abs((a.zoom as number) - activeZoom) ? b : a,
    );
    return lensKey(best);
  }
  return activeDeviceId;
}

// ---- Display roster (shared by the CameraLensControl UI) --------------------------------

/** A lens as the switcher UI consumes it. `key` is a deviceId (local) or a stringified index
 *  (remote), opaque to the component — it just passes it back to onSelect. */
export interface DisplayLens {
  key: string;
  facing: Facing;
  zoomRank: number;
  /** Present for synthetic optical zoom-lenses (informational; chips render by zoomRank). */
  zoom?: number;
}

export interface LensRoster {
  /** Front/back toggle is only meaningful when both facings are present. */
  canToggleFacing: boolean;
  currentFacing: Facing;
  /** The lens chips to show for the current facing (or all lenses when ungrouped). */
  group: DisplayLens[];
  /** First lens of each facing — the segmented 전면/후면 toggle switches to these. */
  frontFirst: DisplayLens | null;
  backFirst: DisplayLens | null;
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

  return { canToggleFacing, currentFacing, group: sorted, frontFirst: front[0] ?? null, backFirst: back[0] ?? null };
}

/** Chip label for a lens within its group: ×-zoom labels when at least one lens is clearly
 *  non-default, otherwise plain ordinals ("렌즈 1"). */
export function lensChipLabel(group: DisplayLens[], lens: DisplayLens, index: number): string {
  const hasZoomHint = group.some((l) => l.zoomRank !== 1);
  if (!hasZoomHint) return `렌즈 ${index + 1}`;
  return ZOOM_BY_RANK[lens.zoomRank] ?? `${index + 1}×`;
}
