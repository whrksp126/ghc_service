import { useEffect, useState, memo, useCallback } from 'react';
import { Copy, Radio } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { showToast } from '../common/Toast';
import { api } from '../../lib/api';

interface ObsBroadcastModalProps {
  isOpen: boolean;
  onClose: () => void;
  slug: string;
}

interface Ingress {
  ingressId: string;
  url: string;
  streamKey: string;
}

async function copyText(text: string, label: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label}를 복사했습니다`, 'success');
  } catch {
    showToast('복사에 실패했습니다', 'error');
  }
}

// Module-scope so it isn't recreated on every parent render (RoomPage re-renders ~12x/sec
// from voice-activity updates; an inline component would remount these inputs each time,
// causing the flicker + swallowed clicks). Click the field OR the icon to copy.
const CopyField = memo(function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-sm text-white/50 mb-1.5 block">{label}</label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => copyText(value, label)}
          className="flex-1 min-w-0 bg-dark-700 border border-white/10 rounded-btn px-3 py-2.5 text-left text-white font-mono text-sm truncate hover:border-primary/40 hover:bg-dark-600 transition-colors cursor-pointer"
          title="클릭하면 복사됩니다"
        >
          {value || '—'}
        </button>
        <button
          type="button"
          onClick={() => copyText(value, label)}
          className="shrink-0 w-10 h-10 rounded-btn bg-dark-700 border border-white/10 flex items-center justify-center text-white/70 hover:text-white hover:bg-dark-600 transition-colors"
          title="복사"
        >
          <Copy size={16} />
        </button>
      </div>
    </div>
  );
});

/**
 * OBS high-quality live broadcast setup. Creates (or reuses) an RTMP ingress for the room
 * and shows the server URL + stream key to paste into OBS. The OBS stream then enters the
 * room as an "OBS 라이브" participant tile automatically.
 */
const DEFAULT_NAME = 'OBS 라이브';

export const ObsBroadcastModal = memo(function ObsBroadcastModal({ isOpen, onClose, slug }: ObsBroadcastModalProps) {
  const [ingress, setIngress] = useState<Ingress | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [name, setName] = useState(DEFAULT_NAME);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setIngress(null);
    setName(DEFAULT_NAME);
    setLoading(true);
    api.createIngress(slug, DEFAULT_NAME)
      .then((r) => setIngress(r.ingress))
      .catch((e: any) => showToast(e.message || 'OBS 라이브 설정에 실패했습니다', 'error'))
      .finally(() => setLoading(false));
  }, [isOpen, slug]);

  const applyName = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setApplying(true);
    try {
      const r = await api.createIngress(slug, trimmed);
      setIngress(r.ingress);
      showToast('이름을 변경했습니다 (다음 송출부터 적용)', 'success');
    } catch (e: any) {
      showToast(e.message || '이름 변경에 실패했습니다', 'error');
    } finally {
      setApplying(false);
    }
  }, [name, slug]);

  const stop = useCallback(async () => {
    if (!ingress) return;
    setStopping(true);
    try {
      await api.deleteIngress(slug, ingress.ingressId);
      showToast('OBS 라이브를 종료했습니다', 'info');
      onClose();
    } catch (e: any) {
      showToast(e.message || '종료에 실패했습니다', 'error');
    } finally {
      setStopping(false);
    }
  }, [ingress, slug, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="OBS 라이브 방송">
      <div className="space-y-5">
        <div className="flex items-center gap-2 text-secondary">
          <Radio size={18} />
          <span className="text-sm">OBS로 고화질 화면을 방에 송출합니다</span>
        </div>

        {loading ? (
          <p className="text-sm text-white/40 text-center py-8">설정을 준비하는 중...</p>
        ) : ingress ? (
          <>
            <div>
              <label className="text-sm text-white/50 mb-1.5 block">방에 표시될 이름</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  maxLength={30}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyName()}
                  placeholder={DEFAULT_NAME}
                  className="flex-1 min-w-0 bg-dark-700 border border-white/10 rounded-btn px-3 py-2.5 text-white text-sm focus:outline-none focus:border-primary/50 transition-colors"
                />
                <Button onClick={applyName} disabled={applying || !name.trim()}>
                  {applying ? '적용 중' : '적용'}
                </Button>
              </div>
            </div>

            <CopyField label="서버 (Server)" value={ingress.url} />
            <CopyField label="스트림 키 (Stream Key)" value={ingress.streamKey} />

            <div className="text-xs text-white/40 leading-relaxed bg-dark-800 rounded-lg p-3 space-y-1">
              <p className="text-white/60 font-medium">OBS 설정 방법</p>
              <p>1. OBS → 설정 → 방송 → 서비스: <span className="text-white/70">사용자 지정</span></p>
              <p>2. 위 <span className="text-white/70">서버</span>와 <span className="text-white/70">스트림 키</span>를 붙여넣기 (칸을 누르면 복사돼요)</p>
              <p>3. 확인 후 <span className="text-white/70">방송 시작</span> → 잠시 뒤 방에 "OBS 라이브" 화면이 나타납니다</p>
            </div>

            <Button className="w-full" variant="danger" onClick={stop} disabled={stopping}>
              {stopping ? '종료하는 중...' : 'OBS 라이브 종료'}
            </Button>
          </>
        ) : (
          <p className="text-sm text-white/40 text-center py-8">설정을 불러오지 못했습니다</p>
        )}
      </div>
    </Modal>
  );
});
