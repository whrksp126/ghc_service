import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import logoUrl from '../assets/ghcam-logo.png';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, MoreHorizontal, Share2, Pencil, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';
import { BottomSheet, type SheetAction } from '../components/common/BottomSheet';
import { showToast } from '../components/common/Toast';
import { ShareModal } from '../components/room/ShareModal';
import { QrScanModal } from '../components/room/QrScanModal';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { DownloadAppButton } from '../components/DownloadAppButton';
import { DeviceVersionCard } from '../components/DeviceVersionCard';
import { getUpdater } from '../lib/updater';

export function HomePage() {
  const navigate = useNavigate();
  const { nickname, logout } = useAuthStore();

  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showJoinRoom, setShowJoinRoom] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [shareRoom, setShareRoom] = useState<{ slug: string; name: string; hasPin: boolean } | null>(null);
  const [roomName, setRoomName] = useState('');
  const [roomPin, setRoomPin] = useState('');
  const [joinSlug, setJoinSlug] = useState('');
  const [rooms, setRooms] = useState<{ id: string; name: string; slug: string; role: string; hasPin: boolean }[]>([]);
  const [loading, setLoading] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showAppInfo, setShowAppInfo] = useState(false);
  // 데스크탑 셸에서만 인앱 업데이트 브리지가 주입된다 → 메뉴 항목/모달을 노출.
  const canSelfUpdate = !!getUpdater();
  type RoomItem = { id: string; name: string; slug: string; role: string; hasPin: boolean };
  const [sheetRoom, setSheetRoom] = useState<RoomItem | null>(null);
  const [renameRoom, setRenameRoom] = useState<RoomItem | null>(null);
  const [renameName, setRenameName] = useState('');

  useEffect(() => {
    api.getMyRooms().then((res) => setRooms(res.rooms)).catch(() => {});
  }, []);

  async function handleCreateRoom() {
    if (!roomName.trim()) return;
    setLoading(true);
    try {
      const res = await api.createRoom({
        name: roomName.trim(),
        pin: roomPin || undefined,
      });
      setShowCreateRoom(false);
      setShareRoom({ slug: res.room.slug, name: res.room.name, hasPin: res.room.hasPin });
      setShowShare(true);
      setRooms((prev) => [{ id: res.room.id, name: res.room.name, slug: res.room.slug, role: 'owner', hasPin: res.room.hasPin }, ...prev]);
      setRoomName('');
      setRoomPin('');
      showToast('방이 생성되었습니다!', 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function handleJoinRoom() {
    const slug = joinSlug.trim().toLowerCase();
    if (!slug) return;
    // Only the room code here — the password (if any) is asked once inside the room.
    setShowJoinRoom(false);
    navigate(`/room/${slug}`);
  }

  function handleShareRoom(room: { slug: string; name: string; hasPin: boolean }) {
    setShareRoom(room);
    setShowShare(true);
  }

  async function handleDeleteRoom(room: { id: string; name: string; slug: string }) {
    if (!window.confirm(`'${room.name}' 방을 삭제할까요?\n접속 중인 참가자들의 연결이 종료됩니다.`)) return;
    try {
      await api.deleteRoom(room.slug);
      setRooms((prev) => prev.filter((r) => r.id !== room.id));
      showToast('방을 삭제했습니다', 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }

  async function handleLeaveRoom(room: { id: string; name: string; slug: string }) {
    try {
      await api.leaveRoom(room.slug);
      setRooms((prev) => prev.filter((r) => r.id !== room.id));
      showToast('목록에서 삭제했습니다', 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }

  async function handleRename() {
    if (!renameRoom || !renameName.trim()) return;
    try {
      await api.renameRoom(renameRoom.slug, renameName.trim());
      setRooms((prev) => prev.map((r) => (r.id === renameRoom.id ? { ...r, name: renameName.trim() } : r)));
      showToast('방 이름을 변경했습니다', 'success');
      setRenameRoom(null);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }

  const roomSheetActions: SheetAction[] = sheetRoom
    ? [
        { icon: <Share2 size={18} />, label: '공유하기', onClick: () => handleShareRoom(sheetRoom) },
        ...(sheetRoom.role === 'owner'
          ? [
              { icon: <Pencil size={18} />, label: '방 이름 변경', onClick: () => { setRenameName(sheetRoom.name); setRenameRoom(sheetRoom); } },
              { icon: <Trash2 size={18} />, label: '방 삭제', danger: true, onClick: () => handleDeleteRoom(sheetRoom) },
            ]
          : [
              { icon: <LogOut size={18} />, label: '목록에서 삭제', danger: true, onClick: () => handleLeaveRoom(sheetRoom) },
            ]),
      ]
    : [];

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col">
      <header className="p-6 flex items-center justify-between">
        <h1>
          <img src={logoUrl} alt="GHC" className="h-9 w-auto" />
        </h1>
        <div className="flex items-center gap-2">
          {/* macOS에서만 노출되는 데스크탑 앱 다운로드 (헤더 저강조 아이콘) */}
          <DownloadAppButton />
          <div className="relative">
          <button
            onClick={() => setShowUserMenu((v) => !v)}
            className="flex items-center gap-2 rounded-full pl-1 pr-3 py-1 hover:bg-white/5 transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-sm font-bold">
              {nickname?.[0]?.toUpperCase()}
            </div>
            <span className="text-sm text-white/70">{nickname}</span>
          </button>

          {showUserMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
              <div className="absolute right-0 mt-2 w-48 bg-dark-700 border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/10">
                  <p className="text-sm font-medium truncate">{nickname}</p>
                  <p className="text-[11px] text-white/40 mt-0.5">개인 설정</p>
                </div>
                {canSelfUpdate && (
                  <button
                    onClick={() => { setShowUserMenu(false); setShowAppInfo(true); }}
                    className="w-full flex items-center gap-2.5 text-left px-4 py-2.5 text-sm text-white/80 hover:bg-white/5 transition-colors border-b border-white/10"
                  >
                    <RefreshCw size={16} /> 앱 정보 · 업데이트
                  </button>
                )}
                <button
                  onClick={() => { setShowUserMenu(false); logout(); navigate('/login'); }}
                  className="w-full flex items-center gap-2.5 text-left px-4 py-2.5 text-sm text-danger hover:bg-danger/10 transition-colors"
                >
                  <LogOut size={16} /> 로그아웃
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 pb-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h2 className="text-4xl sm:text-5xl font-display font-extrabold mb-4 leading-tight">
            모든 순간을
            <br />
            <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
              함께
            </span>
          </h2>
          <p className="text-white/50 text-lg max-w-sm mx-auto">
            여러 카메라로 서로의 공간을 공유하는 영상통화
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="w-full max-w-sm space-y-3"
        >
          <Button className="w-full" size="lg" onClick={() => setShowCreateRoom(true)}>
            방 만들기
          </Button>
          <Button className="w-full" variant="secondary" size="lg" onClick={() => setShowJoinRoom(true)}>
            방 참여하기
          </Button>
          <Button className="w-full" variant="ghost" size="lg" onClick={() => navigate('/cameras')}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            카메라 관리
          </Button>

          {rooms.length > 0 && (
            <div className="pt-6">
              <h3 className="text-sm font-semibold text-white/40 uppercase tracking-wider mb-3">내 방 목록</h3>
              <div className="space-y-2">
                <AnimatePresence>
                  {rooms.map((room) => (
                    <motion.div
                      key={room.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="w-full glass rounded-btn p-4 flex items-center justify-between hover:bg-white/5 transition-colors"
                    >
                      <button
                        onClick={() => navigate(`/room/${room.slug}`)}
                        className="flex-1 text-left"
                      >
                        <p className="font-medium">{room.name}</p>
                        <p className="text-xs text-white/40 mt-0.5">{room.slug}</p>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSheetRoom(room);
                        }}
                        className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                        title="더보기"
                      >
                        <MoreHorizontal className="w-5 h-5 text-white/50" />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}
        </motion.div>
      </main>

      <Modal isOpen={showCreateRoom} onClose={() => setShowCreateRoom(false)} title="방 만들기">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-white/50 mb-1.5 block">방 이름</label>
            <input
              type="text"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="예) 우리집 거실"
              className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
              maxLength={100}
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm text-white/50 mb-1.5 block">비밀번호 (선택)</label>
            <input
              type="text"
              value={roomPin}
              onChange={(e) => setRoomPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="4~6자리 숫자"
              className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
              inputMode="numeric"
            />
          </div>
          <Button className="w-full" loading={loading} onClick={handleCreateRoom}>
            만들기
          </Button>
        </div>
      </Modal>

      <Modal isOpen={showJoinRoom} onClose={() => setShowJoinRoom(false)} title="방 참여하기">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-white/50 mb-1.5 block">방 코드</label>
            <input
              type="text"
              value={joinSlug}
              onChange={(e) => setJoinSlug(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
              placeholder="방 코드를 입력하세요"
              className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
              autoFocus
            />
          </div>
          <Button className="w-full" onClick={handleJoinRoom}>
            참여하기
          </Button>
          <button
            onClick={() => { setShowJoinRoom(false); setShowScan(true); }}
            className="w-full flex items-center justify-center gap-2 text-sm text-white/60 hover:text-white py-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h4v4H4V4zM16 4h4v4h-4V4zM4 16h4v4H4v-4zM14 14h2v2h-2v-2zM18 14h2v2h-2v-2zM14 18h2v2h-2v-2zM18 18h2v2h-2v-2z" />
            </svg>
            QR 코드로 참여
          </button>
        </div>
      </Modal>

      <QrScanModal
        isOpen={showScan}
        onClose={() => setShowScan(false)}
        onResult={(path) => { setShowScan(false); navigate(path); }}
      />

      <BottomSheet
        isOpen={!!sheetRoom}
        onClose={() => setSheetRoom(null)}
        title={sheetRoom?.name}
        actions={roomSheetActions}
      />

      <Modal isOpen={!!renameRoom} onClose={() => setRenameRoom(null)} title="방 이름 변경">
        <div className="space-y-4">
          <input
            type="text"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            placeholder="새 방 이름"
            className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
            maxLength={100}
            autoFocus
          />
          <Button className="w-full" onClick={handleRename}>
            저장
          </Button>
        </div>
      </Modal>

      <Modal isOpen={showAppInfo} onClose={() => setShowAppInfo(false)} title="앱 정보">
        <DeviceVersionCard />
      </Modal>

      {shareRoom && (
        <ShareModal
          isOpen={showShare}
          onClose={() => setShowShare(false)}
          slug={shareRoom.slug}
          roomName={shareRoom.name}
          hasPin={shareRoom.hasPin}
        />
      )}
    </div>
  );
}
