import { useState } from 'react';
import { motion } from 'framer-motion';
import { Share2 } from 'lucide-react';
import { ConnectionIndicator } from '../connection/ConnectionIndicator';
import { ShareModal } from '../room/ShareModal';
import { useRoomStore } from '../../stores/roomStore';

/** Slim in-room info bar. Laid out as a normal flex child (no fixed overlap). */
export function TopBar() {
  const { roomSlug, roomName, hasPin, participants } = useRoomStore();
  const [shareOpen, setShareOpen] = useState(false);

  const uniqueUsers = new Set(participants.map((p) => p.userId)).size;
  const totalDevices = participants.length;

  return (
    <motion.div
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="shrink-0 safe-area-pt px-3 pt-2"
    >
      <div className="flex items-center gap-2 min-w-0 px-1">
        <ConnectionIndicator />
        <h2 className="text-sm font-semibold truncate">{roomName}</h2>
        <span className="text-[11px] text-white/35 shrink-0">
          · {uniqueUsers}명 · 기기 {totalDevices}
        </span>
        <button
          onClick={() => setShareOpen(true)}
          className="ml-auto shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-white/10 text-white hover:bg-white/20 transition-colors"
          title="방 공유 · 코드/초대 링크"
        >
          <Share2 size={18} />
        </button>
      </div>

      {roomSlug && (
        <ShareModal
          isOpen={shareOpen}
          onClose={() => setShareOpen(false)}
          slug={roomSlug}
          roomName={roomName || roomSlug}
          hasPin={hasPin}
        />
      )}
    </motion.div>
  );
}
