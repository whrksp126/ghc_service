import { useEffect, useState, useCallback, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X, Columns2, Rows2, LayoutGrid } from 'lucide-react';
import type { RemoteTrack } from 'livekit-client';
import { FeedCard } from './FeedCard';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';
import { isNativeShell } from '../../lib/native';

/** 자동 = 창 모양에 맞춰 알아서, 가로 = 한 줄로 나란히, 세로 = 한 칸씩 쌓기. */
type PipLayoutMode = 'auto' | 'row' | 'column';

const MODE_LABEL: Record<PipLayoutMode, string> = {
  auto: '자동',
  row: '가로',
  column: '세로',
};
const MODE_ORDER: PipLayoutMode[] = ['auto', 'row', 'column'];
const MODE_KEY = 'ghc-pip-layout';

function loadMode(): PipLayoutMode {
  try {
    const v = localStorage.getItem(MODE_KEY) as PipLayoutMode | null;
    if (v && MODE_ORDER.includes(v)) return v;
  } catch { /* private mode */ }
  return 'auto';
}

/**
 * Columns for the PiP grid.
 *
 * 'auto' picks whatever makes the tiles biggest for the window's CURRENT shape — the same rule the
 * in-room grid uses — so dragging the window wide lines the feeds up side by side and dragging it
 * tall stacks them, with no button press. 'row'/'column' pin it when the automatic choice isn't
 * what the user wants.
 */
function layoutColumns(mode: PipLayoutMode, n: number, w: number, h: number, aspect = 16 / 9): number {
  if (n <= 1) return 1;
  if (mode === 'row') return n;
  if (mode === 'column') return 1;
  let best = 1;
  let bestArea = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = Math.min(w / cols, (h / rows) * aspect);
    const area = tileW * (tileW / aspect);
    if (area > bestArea) {
      bestArea = area;
      best = cols;
    }
  }
  return best;
}

export interface PipFeed {
  id: string;
  track: MediaStreamTrack | null;
  lkTrack?: RemoteTrack;
  label: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  voiceKey?: string;
  controls?: ReactNode;
  mirror?: boolean;
}

interface DocumentPipPortalProps {
  feeds: PipFeed[];
}

/**
 * Desktop Chromium path for the PiP / multi-window button: popped cameras render into a single
 * always-on-top Document Picture-in-Picture OS window (grid). The window floats over other apps
 * and native fullscreen — the KakaoTalk/Discord-style behavior. The window itself is created in
 * the store's toggle() (within the click gesture); this component just portals content into it.
 */
export function DocumentPipPortal({ feeds }: DocumentPipPortalProps) {
  const popped = useFloatingWindowStore((s) => s.popped);
  const pipWindow = useFloatingWindowStore((s) => s.pipWindow);
  const close = useFloatingWindowStore((s) => s.close);

  // Drop popped feeds whose source has disappeared (camera left / stopped).
  useEffect(() => {
    const ids = new Set(feeds.map((f) => f.id));
    for (const id of Object.keys(popped)) {
      if (!ids.has(id)) close(id);
    }
  }, [feeds, popped, close]);

  // The window's live inner size. On the desktop shell this window is ours and resizes freely from
  // any edge, so this is what makes the tiles re-flow as it's dragged — drag it wide and they line
  // up side by side, drag it tall and they stack.
  const [mode, setMode] = useState<PipLayoutMode>(loadMode);
  const cycleMode = useCallback(() => {
    setMode((m) => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length];
      try { localStorage.setItem(MODE_KEY, next); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const [size, setSize] = useState({ w: 480, h: 300 });
  useEffect(() => {
    if (!pipWindow) return;
    const read = () => setSize({ w: pipWindow.innerWidth, h: pipWindow.innerHeight });
    read();
    pipWindow.addEventListener('resize', read);
    return () => pipWindow.removeEventListener('resize', read);
  }, [pipWindow]);

  if (!pipWindow) return null;

  const openFeeds = Object.keys(popped)
    .map((id) => feeds.find((f) => f.id === id))
    .filter((f): f is PipFeed => !!f);
  if (openFeeds.length === 0) return null;

  const nativeShell = isNativeShell();
  const barH = nativeShell ? 30 : 0; // frameless window → we supply the drag strip
  const cols = layoutColumns(mode, openFeeds.length, size.w, Math.max(1, size.h - barH));
  const rows = Math.max(1, Math.ceil(openFeeds.length / cols));

  return createPortal(
    <div className="w-screen h-screen bg-dark-900 flex flex-col">
      {nativeShell && (
        // Frameless: this strip is the only place to grab the window (the tiles below must stay
        // clickable). The layout button opts out of the drag region so it can be pressed.
        // The drag region is inset 4px from the top so the window's own resize edge stays grabbable
        // — a full-bleed drag strip swallows it and the top edge stops responding.
        <div
          className="flex items-center justify-end gap-1 px-1 shrink-0 bg-dark-900/95"
          style={{ height: barH, marginTop: 4, WebkitAppRegion: 'drag' } as CSSProperties}
        >
          <button
            onClick={cycleMode}
            title={MODE_LABEL[mode]}
            className="h-5 px-2 rounded-full flex items-center gap-1 text-[10px] font-medium text-white/70 hover:text-white bg-white/10 hover:bg-white/20 transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            {mode === 'row' ? <Columns2 size={11} /> : mode === 'column' ? <Rows2 size={11} /> : <LayoutGrid size={11} />}
            {MODE_LABEL[mode]}
          </button>
        </div>
      )}
      <div
        className="flex-1 min-h-0 grid gap-1 p-1"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
      {openFeeds.map((feed) => (
        <div key={feed.id} className="relative min-h-0 min-w-0">
          <FeedCard
            track={feed.track}
            lkTrack={feed.lkTrack}
            label={feed.label}
            isMuted={feed.isMuted}
            isLocal={feed.isLocal}
            isScreen={feed.isScreen}
            voiceKey={feed.voiceKey}
            controls={feed.controls}
            mirror={feed.mirror}
            fitContain
            className="w-full h-full"
          />
          <button
            onClick={() => close(feed.id)}
            className="absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 text-white hover:bg-black/70 transition-colors"
            title="닫기"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      </div>
    </div>,
    pipWindow.document.body
  );
}
