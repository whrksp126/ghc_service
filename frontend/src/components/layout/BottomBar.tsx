import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mic, MicOff, MonitorUp, MonitorOff,
  PhoneOff, MoreHorizontal, Trash2, SlidersHorizontal, Radio, Globe,
} from 'lucide-react';
import { useDeviceStore } from '../../stores/deviceStore';
import { playSound } from '../../lib/sounds';
import { AudioSettingsModal } from '../room/AudioSettingsModal';

interface BottomBarProps {
  onToggleMic: () => void;
  onToggleScreen: () => void;
  onLeave: () => void;
  /** Owner only — ends the room for everyone. */
  onCloseRoom?: () => void;
  /** Owner only — opens the OBS live broadcast setup. */
  onObsLive?: () => void;
  /** Owner only (desktop shell only) — opens the browser-source live setup. */
  onBrowserLive?: () => void;
}

/**
 * Simplified control bar. Camera on/off lives in MyDeviceDock now (per-device), so this
 * bar only keeps this-device essentials (mic, leave) up front; everything secondary
 * (screen share, room delete) is tucked into a "더보기" menu.
 */
export function BottomBar({
  onToggleMic, onToggleScreen, onLeave, onCloseRoom, onObsLive, onBrowserLive,
}: BottomBarProps) {
  const { isMicOn, isScreenSharing } = useDeviceStore();
  const [moreOpen, setMoreOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);

  const menuItem = (
    icon: ReactNode, label: string, onClick: () => void, danger?: boolean,
  ) => (
    <button
      onClick={() => { onClick(); setMoreOpen(false); }}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-white/5 ${
        danger ? 'text-danger' : 'text-white/80'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <motion.div
      initial={{ y: 60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="shrink-0 safe-area-pb px-3 pb-3 pt-1"
    >
      <div className="glass-strong rounded-2xl px-4 py-3 flex items-center justify-center gap-3">
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={() => { onToggleMic(); playSound('toggle'); }}
          className={`btn-icon ${isMicOn ? 'bg-dark-600 hover:bg-dark-500' : 'bg-danger hover:bg-red-600'}`}
          title={isMicOn ? '마이크 끄기' : '마이크 켜기'}
        >
          {isMicOn ? <Mic size={20} /> : <MicOff size={20} />}
        </motion.button>

        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={onToggleScreen}
          className={`btn-icon ${isScreenSharing ? 'bg-secondary text-dark-900 hover:bg-secondary-hover' : 'bg-dark-600 hover:bg-dark-500'}`}
          title="화면 공유"
        >
          {isScreenSharing ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
        </motion.button>

        <div className="relative">
          <motion.button
            whileTap={{ scale: 0.85 }}
            onClick={() => setMoreOpen((v) => !v)}
            className={`btn-icon ${moreOpen ? 'bg-dark-500' : 'bg-dark-600 hover:bg-dark-500'}`}
            title="더보기"
          >
            <MoreHorizontal size={20} />
          </motion.button>

          <AnimatePresence>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.96 }}
                  className="absolute bottom-14 left-1/2 -translate-x-1/2 z-50 w-44 glass-strong rounded-xl overflow-hidden py-1"
                >
                  {menuItem(<SlidersHorizontal size={18} />, '마이크 설정', () => setAudioOpen(true))}
                  {onObsLive && menuItem(<Radio size={18} />, 'OBS 라이브', onObsLive)}
                  {onBrowserLive && menuItem(<Globe size={18} />, '브라우저 라이브', onBrowserLive)}
                  {onCloseRoom && menuItem(<Trash2 size={18} />, '방 종료', onCloseRoom, true)}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={onLeave}
          className="btn-icon bg-danger hover:bg-red-600"
          title="나가기"
        >
          <PhoneOff size={20} />
        </motion.button>
      </div>

      <AudioSettingsModal isOpen={audioOpen} onClose={() => setAudioOpen(false)} />
    </motion.div>
  );
}
