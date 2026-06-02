import { useRef } from 'react';
import { Modal } from '../common/Modal';
import { useAudioSettings, micConstraints, THRESHOLD_MIN, THRESHOLD_MAX } from '../../stores/audioSettings';
import { useDeviceStore } from '../../stores/deviceStore';
import { useAlwaysOnCamera } from '../../services/alwaysOnCamera';
import { useVoiceStore } from '../../services/voiceActivity';
import { useAuthStore } from '../../stores/authStore';

/** Push the current DSP toggles onto the live mic track(s) immediately. */
function applyToActiveMic() {
  const c = micConstraints();
  const tracks = [
    useDeviceStore.getState().audioInput.track,
    useAlwaysOnCamera.getState().getAudioTrack(),
  ];
  for (const t of tracks) if (t) t.applyConstraints(c).catch(() => {});
}

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

export function AudioSettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const s = useAudioSettings();
  const { userId, deviceId } = useAuthStore();
  const myKey = userId && deviceId ? `${userId}:${deviceId}` : '';
  const level = useVoiceStore((st) => (myKey ? st.levels[myKey] ?? 0 : 0));
  const threshold = s.threshold;
  const over = level >= threshold;
  const meterRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

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
          label="자동 소음 제거"
          desc="키보드·팬·생활 소음을 자동으로 억제"
          value={s.noiseSuppression}
          onChange={(v) => { s.set({ noiseSuppression: v }); applyToActiveMic(); }}
        />
        <Toggle
          label="에코 제거"
          desc="스피커 소리가 마이크로 되돌아가는 울림 제거"
          value={s.echoCancellation}
          onChange={(v) => { s.set({ echoCancellation: v }); applyToActiveMic(); }}
        />
        <Toggle
          label="자동 볼륨 조절"
          desc="입력 음량을 자동으로 일정하게 맞춤"
          value={s.autoGainControl}
          onChange={(v) => { s.set({ autoGainControl: v }); applyToActiveMic(); }}
        />
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
            빨간 선이 기준이에요. 말할 때 막대가 빨간 선을 넘으면 전송돼요. 선을 끌어서 직접 맞추세요.
          </p>
          {/* Live input meter — the red marker IS the threshold control (drag it). */}
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
            className="relative h-7 rounded-md bg-dark-600 overflow-hidden cursor-ew-resize touch-none select-none"
          >
            <div
              className={`h-full transition-[width] duration-75 ${over ? 'bg-secondary/70' : 'bg-white/20'}`}
              style={{ width: `${Math.min(100, (level / THRESHOLD_MAX) * 100)}%` }}
            />
            {/* Threshold marker + grab handle */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary"
              style={{ left: `${(threshold / THRESHOLD_MAX) * 100}%` }}
            >
              <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-primary shadow" />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
