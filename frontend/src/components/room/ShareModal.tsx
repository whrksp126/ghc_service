import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { showToast } from '../common/Toast';
import { api } from '../../lib/api';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  slug: string;
  roomName: string;
  hasPin: boolean;
}

export function ShareModal({ isOpen, onClose, slug, roomName, hasPin }: ShareModalProps) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const baseUrl = window.location.origin;
  const roomUrl = `${baseUrl}/room/${slug}`;
  const displayUrl = inviteUrl || roomUrl;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(displayUrl);
      showToast('링크가 복사되었습니다', 'success');
    } catch {
      showToast('복사에 실패했습니다', 'error');
    }
  }

  async function handleShare() {
    try {
      await navigator.share({
        title: `GHC - ${roomName}`,
        text: `"${roomName}" 방에 참여하세요!`,
        url: displayUrl,
      });
    } catch {
      handleCopy();
    }
  }

  async function handleCreateInvite() {
    setLoading(true);
    try {
      const res = await api.createInvite(slug);
      const url = `${baseUrl}/room/${slug}?invite=${res.inviteToken}`;
      setInviteUrl(url);
      showToast('초대 링크가 생성되었습니다 (24시간 유효)', 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="방 공유하기">
      <div className="space-y-5">
        <div className="flex justify-center p-4 bg-white rounded-xl">
          <QRCodeSVG value={displayUrl} size={180} level="M" />
        </div>

        <div>
          <label className="text-sm text-white/50 mb-1.5 block">방 코드</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white font-mono text-lg tracking-widest text-center select-all">
              {slug}
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <Button className="flex-1" onClick={handleCopy}>
            복사하기
          </Button>
          {typeof navigator.share === 'function' && (
            <Button className="flex-1" variant="secondary" onClick={handleShare}>
              공유하기
            </Button>
          )}
        </div>

        {hasPin && !inviteUrl && (
          <button
            onClick={handleCreateInvite}
            disabled={loading}
            className="w-full text-sm text-primary hover:underline disabled:opacity-50"
          >
            {loading ? '생성 중...' : 'PIN 없이 입장 가능한 초대 링크 생성'}
          </button>
        )}

        {inviteUrl && (
          <p className="text-xs text-white/30 text-center">
            초대 링크는 24시간 후 만료됩니다
          </p>
        )}
      </div>
    </Modal>
  );
}
