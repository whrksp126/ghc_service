import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2 } from 'lucide-react';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';
import { showToast } from '../components/common/Toast';
import { ShareModal } from '../components/room/ShareModal';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';

export function HomePage() {
  const navigate = useNavigate();
  const { nickname, logout } = useAuthStore();

  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showJoinRoom, setShowJoinRoom] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [shareRoom, setShareRoom] = useState<{ slug: string; name: string; hasPin: boolean } | null>(null);
  const [roomName, setRoomName] = useState('');
  const [joinSlug, setJoinSlug] = useState('');
  const [rooms, setRooms] = useState<{ id: string; name: string; slug: string; role: string; hasPin: boolean }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getMyRooms().then((res) => setRooms(res.rooms)).catch(() => {});
  }, []);

  async function handleCreateRoom() {
    if (!roomName.trim()) return;
    setLoading(true);
    try {
      const res = await api.createRoom({
        name: roomName.trim(),
      });
      setShowCreateRoom(false);
      setShareRoom({ slug: res.room.slug, name: res.room.name, hasPin: res.room.hasPin });
      setShowShare(true);
      setRooms((prev) => [{ id: res.room.id, name: res.room.name, slug: res.room.slug, role: 'owner', hasPin: res.room.hasPin }, ...prev]);
      setRoomName('');
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

  const roleLabel: Record<string, string> = {
    owner: '방장',
    member: '참여자',
    viewer: '시청자',
  };

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col">
      <header className="p-6 flex items-center justify-between">
        <h1 className="text-2xl font-display font-extrabold tracking-tight">
          <span className="text-primary">Long</span>
          <span className="text-secondary">dcam</span>
        </h1>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-sm font-bold">
            {nickname?.[0]?.toUpperCase()}
          </div>
          <span className="text-sm text-white/70">{nickname}</span>
          <button
            onClick={() => {
              logout();
              navigate('/login');
            }}
            className="text-xs text-white/30 hover:text-white/60 transition-colors ml-2"
          >
            로그아웃
          </button>
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
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleShareRoom(room);
                          }}
                          className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                          title="공유하기"
                        >
                          <svg className="w-4 h-4 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                          </svg>
                        </button>
                        {room.role === 'owner' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteRoom(room);
                            }}
                            className="p-2 hover:bg-danger/15 rounded-lg transition-colors group/del"
                            title="방 삭제"
                          >
                            <Trash2 className="w-4 h-4 text-white/40 group-hover/del:text-danger" />
                          </button>
                        )}
                        <span className="text-xs text-white/30 bg-dark-700 px-2 py-1 rounded-full">
                          {roleLabel[room.role] || room.role}
                        </span>
                      </div>
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
        </div>
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
