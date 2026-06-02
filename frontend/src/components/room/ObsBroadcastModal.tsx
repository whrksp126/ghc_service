import { useEffect, useState } from 'react';
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

/**
 * OBS high-quality live broadcast setup. Creates (or reuses) an RTMP ingress for the room
 * and shows the server URL + stream key to paste into OBS. The OBS stream then enters the
 * room as an "OBS 라이브" participant tile automatically.
 */
export function ObsBroadcastModal({ isOpen, onClose, slug }: ObsBroadcastModalProps) {
  const [ingress, setIngress] = useState<Ingress | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setIngress(null);
    setLoading(true);
    api.createIngress(slug)
      .then((r) => setIngress(r.ingress))
      .catch((e: any) => showToast(e.message || 'OBS 라이브 설정에 실패했습니다', 'error'))
      .finally(() => setLoading(false));
  }, [isOpen, slug]);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label}를 복사했습니다`, 'success');
    } catch {
      showToast('복사에 실패했습니다', 'error');
    }
  }

  async function stop() {
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
  }

  const Field = ({ label, value }: { label: string; value: string }) => (
    <div>
      <label className="text-sm text-white/50 mb-1.5 block">{label}</label>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 bg-dark-700 border border-white/10 rounded-btn px-3 py-2.5 text-white font-mono text-sm truncate select-all">
          {value}
        </div>
        <button
          onClick={() => copy(value, label)}
          className="shrink-0 w-10 h-10 rounded-btn bg-dark-700 border border-white/10 flex items-center justify-center text-white/70 hover:text-white hover:bg-dark-600 transition-colors"
          title="복사"
        >
          <Copy size={16} />
        </button>
      </div>
    </div>
  );

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
            <Field label="서버 (Server)" value={ingress.url} />
            <Field label="스트림 키 (Stream Key)" value={ingress.streamKey} />

            <div className="text-xs text-white/40 leading-relaxed bg-dark-800 rounded-lg p-3 space-y-1">
              <p className="text-white/60 font-medium">OBS 설정 방법</p>
              <p>1. OBS → 설정 → 방송 → 서비스: <span className="text-white/70">사용자 지정</span></p>
              <p>2. 위 <span className="text-white/70">서버</span>와 <span className="text-white/70">스트림 키</span>를 붙여넣기</p>
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
}
