import { useEffect, useRef } from 'react';
import { Modal } from '../common/Modal';
import { useAudioSettings, micConstraints, THRESHOLD_MIN, THRESHOLD_MAX } from '../../stores/audioSettings';
import { useDeviceStore } from '../../stores/deviceStore';
import { useAlwaysOnCamera } from '../../services/alwaysOnCamera';
import { useVoiceStore, attachVoice, detachVoice } from '../../services/voiceActivity';

function Toggle({ label, desc, value, onChange }: {
  label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="w-full flex items-center justify-between gap-3 py-2.5 text-left"
    >
      <div className="min-w-0">
        <div className="text-sm text-white/90">{label}</div>
        <div className="text-xs text-white/40">{desc}</div>
      </div>
      <span className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${value ? 'bg-primary' : 'bg-dark-600'}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${value ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  );
}

// 0..1 fraction of the meter width → clamped threshold value.
function fractionToThreshold(f: number): number {
  const t = f * THRESHOLD_MAX;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, t));
}

// Dedicated voice-activity key so the modal's live meter works on its own, independent of
// whether RoomPage has attached the in-room mic.
const PREVIEW_KEY = 'settings-preview';

export function AudioSettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const s = useAudioSettings();
  const level = useVoiceStore((st) => st.levels[PREVIEW_KEY] ?? 0);
  const threshold = s.threshold;
  const over = level >= threshold;
  const meterRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // While the modal is open, tap the live mic so the meter always moves — even outside a
  // room or with the in-room mic off. Reuses an existing capture when possible; otherwise
  // briefly opens its own (stopped on close).
  useEffect(() => {
    if (!isOpen) return;
    let tempTrack: MediaStreamTrack | null = null;
    let cancelled = false;
    (async () => {
      let track = useDeviceStore.getState().audioInput.track
        || useAlwaysOnCamera.getState().getAudioTrack();
      if (!track) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
          tempTrack = stream.getAudioTracks()[0] || null;
          track = tempTrack;
        } catch { /* mic denied — meter just stays flat */ }
      }
      if (cancelled) { tempTrack?.stop(); return; }
      if (track) attachVoice(PREVIEW_KEY, track);
    })();
    return () => {
      cancelled = true;
      detachVoice(PREVIEW_KEY);
      tempTrack?.stop();
    };
  }, [isOpen]);

  // 0..100 display value the number input shows/edits (relative to THRESHOLD_MAX).
  const pct = Math.round((threshold / THRESHOLD_MAX) * 100);

  const setFromClientX = (clientX: number) => {
    const el = meterRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const f = (clientX - rect.left) / rect.width;
    s.set({ threshold: fractionToThreshold(f) });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="마이크 설정">
      <div className="divide-y divide-white/5">
        <Toggle
          label="음성 감지 전송"
          desc="설정한 민감도 이상 말할 때만 소리를 전송 (노이즈 게이트)"
          value={s.noiseGate}
          onChange={(v) => s.set({ noiseGate: v })}
        />

        <div className="pt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-white/90">입력 민감도 기준</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={Math.round((THRESHOLD_MIN / THRESHOLD_MAX) * 100)}
                max={100}
                value={pct}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                  s.set({ threshold: fractionToThreshold(v / 100) });
                }}
                className="w-14 bg-dark-700 border border-white/10 rounded-md px-2 py-1 text-sm text-white text-right focus:outline-none focus:border-primary/50"
              />
              <span className="text-xs text-white/30">/ 100</span>
            </div>
          </div>
          <p className="text-xs text-white/40 mb-2">
            지금 들어오는 소리 크기가 막대로 보여요. 막대가 빨간 선을 넘으면 전송돼요. 선을 끌어서 직접 맞추세요.
          </p>
          {/* Live input meter — bar = current mic level, red marker = threshold (draggable). */}
          <div
            ref={meterRef}
            onPointerDown={(e) => {
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              setFromClientX(e.clientX);
            }}
            onPointerMove={(e) => { if (dragging.current) setFromClientX(e.clientX); }}
            onPointerUp={(e) => {
              dragging.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            className="relative h-8 rounded-md bg-dark-600 overflow-hidden cursor-ew-resize touch-none select-none"
          >
            <div
              className={`h-full transition-[width] duration-75 ${over ? 'bg-secondary' : 'bg-secondary/40'}`}
              style={{ width: `${Math.min(100, (level / THRESHOLD_MAX) * 100)}%` }}
            />
            {/* Threshold marker + grab handle */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary"
              style={{ left: `${(threshold / THRESHOLD_MAX) * 100}%` }}
            >
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-primary shadow ring-2 ring-white/70" />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
