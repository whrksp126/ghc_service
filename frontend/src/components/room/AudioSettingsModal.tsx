import { Modal } from '../common/Modal';
import { useAudioSettings, micConstraints, sensitivityToThreshold } from '../../stores/audioSettings';
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

export function AudioSettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const s = useAudioSettings();
  const { userId, deviceId } = useAuthStore();
  const myKey = userId && deviceId ? `${userId}:${deviceId}` : '';
  const level = useVoiceStore((st) => (myKey ? st.levels[myKey] ?? 0 : 0));
  const threshold = sensitivityToThreshold(s.sensitivity);
  const over = level >= threshold;

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
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-white/90">입력 민감도</span>
            <span className="text-xs text-white/40">{Math.round(s.sensitivity * 100)}</span>
          </div>
          {/* Live input meter with the threshold marker */}
          <div className="relative h-2 rounded-full bg-dark-600 overflow-hidden mb-2">
            <div
              className={`h-full rounded-full transition-[width] duration-75 ${over ? 'bg-secondary' : 'bg-white/30'}`}
              style={{ width: `${Math.min(100, level * 320)}%` }}
            />
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary"
              style={{ left: `${Math.min(100, threshold * 320)}%` }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={s.sensitivity}
            onChange={(e) => s.set({ sensitivity: Number(e.target.value) })}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-[11px] text-white/30 mt-1">
            <span>둔감</span>
            <span>민감</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
