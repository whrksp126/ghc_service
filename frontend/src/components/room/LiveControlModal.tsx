// Module-scope so it isn't recreated on every parent render (RoomPage re-renders ~12x/sec
// from voice-activity updates; an inline component would remount on each render).
import { useEffect, useState, useRef, memo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Radio, MonitorUp, AppWindow, Camera, Square, VolumeX, Volume2 } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { showToast } from '../common/Toast';
import { api } from '../../lib/api';
import { nativeBridge, type LiveSource, type LiveStatus, type LiveMuteState } from '../../lib/native';

interface LiveControlModalProps {
  isOpen: boolean;
  onClose: () => void;
  slug: string;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function sourceIcon(src: LiveSource) {
  if (src.type === 'camera') return <Camera size={20} className="text-secondary shrink-0" />;
  if (src.type === 'screen') return <MonitorUp size={20} className="text-white/60 shrink-0" />;
  return <AppWindow size={20} className="text-white/60 shrink-0" />;
}

function sourceLabel(src: LiveSource): { primary: string; secondary?: string } {
  if (src.type === 'camera') return { primary: '내 카메라' };
  if (src.type === 'browser') return { primary: src.name || '브라우저 라이브', secondary: src.url };
  if (src.type === 'screen') return { primary: src.title };
  return { primary: src.title, secondary: src.appName };
}

// SourceItem is module-scope to avoid remounting on parent renders.
const SourceItem = memo(function SourceItem({
  source,
  selected,
  onSelect,
}: {
  source: LiveSource;
  selected: boolean;
  onSelect: (s: LiveSource) => void;
}) {
  const label = sourceLabel(source);
  const thumbnail = (source.type !== 'camera' && source.type !== 'browser') ? source.thumbnail : undefined;
  const handleClick = useCallback(() => onSelect(source), [source, onSelect]);

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      onClick={handleClick}
      className={`w-full flex items-center gap-3 p-3 rounded-btn border transition-colors text-left
        ${selected
          ? 'border-primary/60 bg-primary/10'
          : 'border-white/10 bg-dark-700 hover:border-white/20 hover:bg-dark-600'
        }`}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt={label.primary}
          className="w-14 h-9 object-cover rounded shrink-0 bg-dark-900"
        />
      ) : (
        <div className="w-14 h-9 flex items-center justify-center rounded bg-dark-800 shrink-0">
          {sourceIcon(source)}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{label.primary}</p>
        {label.secondary && (
          <p className="text-xs text-white/50 truncate">{label.secondary}</p>
        )}
      </div>
      {selected && (
        <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
      )}
    </motion.button>
  );
});

const DEFAULT_NAME = '라이브';

export const LiveControlModal = memo(function LiveControlModal({
  isOpen,
  onClose,
  slug,
}: LiveControlModalProps) {
  const [sources, setSources] = useState<LiveSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [selected, setSelected] = useState<LiveSource | null>(null);
  const [name, setName] = useState(DEFAULT_NAME);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [ingressId, setIngressId] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ state: 'idle' });
  const [muteState, setMuteState] = useState<LiveMuteState | null>(null);
  // Elapsed timer: tick every second while live.
  const [now, setNow] = useState(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to native status updates while modal is mounted.
  useEffect(() => {
    if (!isOpen) return;
    const bridge = nativeBridge();
    if (!bridge) return;

    // Snapshot the current status first.
    bridge.live.getStatus().then(setStatus).catch(() => {});

    const unsub = bridge.live.onStatus((s) => setStatus(s));
    return unsub;
  }, [isOpen]);

  // Manage the elapsed-time ticker.
  useEffect(() => {
    if (status.state === 'live') {
      setNow(Date.now());
      timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status.state]);

  // Fetch mute state whenever we enter an active live session.
  useEffect(() => {
    if (status.state === 'live' || status.state === 'starting') {
      nativeBridge()?.live.getMute().then(setMuteState).catch(() => {});
    } else {
      setMuteState(null);
    }
  }, [status.state]);

  // On open: load sources and snapshot status.
  useEffect(() => {
    if (!isOpen) return;
    setSelected(null);
    setName(DEFAULT_NAME);
    setIngressId(null);
    setLoadingSources(true);

    nativeBridge()!.live
      .listSources()
      .then((list) => setSources(list))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : '소스를 불러오지 못했습니다';
        showToast(msg, 'error');
      })
      .finally(() => setLoadingSources(false));
  }, [isOpen]);

  const isLiveOrStarting =
    status.state === 'live' ||
    status.state === 'starting' ||
    status.state === 'reconnecting';

  const handleStart = useCallback(async () => {
    if (!selected) return;
    setStarting(true);
    let createdIngressId: string | null = null;
    try {
      const { ingress } = await api.createIngress(slug, name.trim() || DEFAULT_NAME);
      createdIngressId = ingress.ingressId;

      const result = await nativeBridge()!.live.startLive({
        source: selected,
        rtmpUrl: ingress.url,
        streamKey: ingress.streamKey,
        captureAudio: true,
      });

      if (!result.ok) {
        showToast(result.error || '라이브 시작에 실패했습니다', 'error');
        // Best-effort cleanup of the ingress we just created.
        api.deleteIngress(slug, createdIngressId).catch(() => {});
        return;
      }

      setIngressId(createdIngressId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '라이브 시작에 실패했습니다';
      showToast(msg, 'error');
      if (createdIngressId) {
        api.deleteIngress(slug, createdIngressId).catch(() => {});
      }
    } finally {
      setStarting(false);
    }
  }, [selected, slug, name]);

  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      await nativeBridge()!.live.stopLive();
      if (ingressId) {
        await api.deleteIngress(slug, ingressId);
      }
      showToast('라이브를 종료했습니다', 'info');
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '종료에 실패했습니다';
      showToast(msg, 'error');
    } finally {
      setStopping(false);
    }
  }, [ingressId, slug, onClose]);

  const handleToggleMute = useCallback(async () => {
    if (!muteState) return;
    const next = await nativeBridge()!.live.setMute(!muteState.muted);
    setMuteState(next);
  }, [muteState]);

  // Group sources by type.
  const screenSources = sources.filter((s) => s.type === 'screen');
  const windowSources = sources.filter((s) => s.type === 'window');
  const cameraSources = sources.filter((s) => s.type === 'camera');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="네이티브 라이브">
      <div className="space-y-5">
        {/* Header info row */}
        <div className="flex items-center gap-2 text-secondary">
          <Radio size={18} />
          <span className="text-sm">앱에서 직접 화면을 선택해 방에 송출합니다</span>
        </div>

        {/* Status row — always visible once live/starting */}
        {isLiveOrStarting && (
          <div
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-btn border
              ${status.state === 'live'
                ? 'bg-primary/10 border-primary/30 text-white'
                : status.state === 'reconnecting'
                  ? 'bg-warning/10 border-warning/30 text-warning'
                  : 'bg-dark-700 border-white/10 text-white/70'
              }`}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 animate-pulse
                ${status.state === 'live'
                  ? 'bg-primary'
                  : status.state === 'reconnecting'
                    ? 'bg-warning'
                    : 'bg-secondary'
                }`}
            />
            {status.state === 'starting' && <span className="text-sm">라이브 준비 중...</span>}
            {status.state === 'live' && (
              <span className="text-sm font-semibold">
                송출 중&nbsp;
                <span className="font-mono font-normal text-white/70">
                  {formatElapsed(now - status.sinceMs)}
                </span>
              </span>
            )}
            {status.state === 'reconnecting' && (
              <span className="text-sm">재연결 중...</span>
            )}
          </div>
        )}

        {status.state === 'error' && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-btn bg-danger/10 border border-danger/30 text-danger text-sm">
            {status.message}
          </div>
        )}

        {/* Source picker — hide when already live */}
        {!isLiveOrStarting && (
          <>
            <div>
              <label className="text-sm text-white/50 mb-1.5 block">방에 표시될 이름</label>
              <input
                type="text"
                value={name}
                maxLength={30}
                onChange={(e) => setName(e.target.value)}
                placeholder={DEFAULT_NAME}
                className="w-full bg-dark-700 border border-white/10 rounded-btn px-3 py-2.5 text-white text-sm focus:outline-none focus:border-primary/50 transition-colors"
              />
            </div>

            <div>
              <label className="text-sm text-white/50 mb-2 block">캡처 소스 선택</label>
              {loadingSources ? (
                <p className="text-sm text-white/40 text-center py-6">소스 목록을 불러오는 중...</p>
              ) : sources.length === 0 ? (
                <p className="text-sm text-white/40 text-center py-6">사용 가능한 소스가 없습니다</p>
              ) : (
                <div className="space-y-4 max-h-64 overflow-y-auto pr-1">
                  {screenSources.length > 0 && (
                    <div>
                      <p className="text-xs text-white/40 uppercase tracking-wide mb-2">화면</p>
                      <div className="space-y-1.5">
                        {screenSources.map((src) => (
                          <SourceItem
                            key={src.id}
                            source={src}
                            selected={selected === src}
                            onSelect={setSelected}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {windowSources.length > 0 && (
                    <div>
                      <p className="text-xs text-white/40 uppercase tracking-wide mb-2">창</p>
                      <div className="space-y-1.5">
                        {windowSources.map((src) => (
                          <SourceItem
                            key={src.id}
                            source={src}
                            selected={selected === src}
                            onSelect={setSelected}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {cameraSources.length > 0 && (
                    <div>
                      <p className="text-xs text-white/40 uppercase tracking-wide mb-2">카메라</p>
                      <div className="space-y-1.5">
                        {cameraSources.map((src, i) => (
                          <SourceItem
                            key={i}
                            source={src}
                            selected={selected === src}
                            onSelect={setSelected}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <Button
              className="w-full"
              variant="primary"
              loading={starting}
              disabled={!selected || starting}
              onClick={handleStart}
            >
              <Radio size={16} />
              라이브 시작
            </Button>
          </>
        )}

        {/* Mute toggle — shown once live/starting, only if available */}
        {isLiveOrStarting && muteState?.available && (
          <div className="space-y-1.5">
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={handleToggleMute}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-btn border transition-colors text-left
                ${muteState.muted
                  ? 'bg-dark-700 border-secondary/40 text-white'
                  : 'bg-dark-800 border-white/10 text-white/70 hover:border-white/20 hover:bg-dark-700'
                }`}
            >
              {muteState.muted
                ? <VolumeX size={18} className="text-secondary shrink-0" />
                : <Volume2 size={18} className="text-white/50 shrink-0" />
              }
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {muteState.muted ? '라이브 소리 잠금 ON' : '내 소리 들림'}
                </p>
              </div>
              <div
                className={`w-8 h-4 rounded-full transition-colors shrink-0 relative
                  ${muteState.muted ? 'bg-secondary/70' : 'bg-white/20'}`}
              >
                <div
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform
                    ${muteState.muted ? 'translate-x-4' : 'translate-x-0.5'}`}
                />
              </div>
            </motion.button>
            <p className="text-xs text-white/40 px-1">
              켜면 이 기기에선 안 들리고, 라이브에는 그대로 전달됩니다
            </p>
          </div>
        )}

        {/* Stop button — shown once live/starting */}
        {isLiveOrStarting && (
          <Button
            className="w-full"
            variant="danger"
            loading={stopping}
            disabled={stopping}
            onClick={handleStop}
          >
            <Square size={16} />
            {stopping ? '종료하는 중...' : '라이브 종료'}
          </Button>
        )}
      </div>
    </Modal>
  );
});
