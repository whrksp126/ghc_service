import { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface SheetAction {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Highlight the row (e.g. currently-active option). */
  active?: boolean;
  disabled?: boolean;
}

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  actions?: SheetAction[];
  children?: ReactNode;
}

/**
 * Slide-up sheet anchored to the bottom of the screen. Used to tuck away per-camera
 * controls (power / lens switch / rename) behind a "더보기(⋯)" button so the tiles
 * stay clean. Pass `actions` for the common icon+label row list, or `children` for
 * custom content.
 */
export function BottomSheet({ isOpen, onClose, title, actions, children }: BottomSheetProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="relative w-full sm:max-w-md glass-strong rounded-t-modal pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] z-10"
          >
            {/* grabber */}
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" />

            {title && (
              <h2 className="px-5 pb-2 text-sm font-semibold text-white/50 truncate">{title}</h2>
            )}

            {actions && (
              <div className="px-2 pb-1">
                {actions.map((a, i) => (
                  <button
                    key={i}
                    onClick={() => { a.onClick(); onClose(); }}
                    disabled={a.disabled}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[15px] transition-colors disabled:opacity-40 ${
                      a.danger
                        ? 'text-danger hover:bg-danger/10'
                        : a.active
                          ? 'text-primary hover:bg-white/5'
                          : 'text-white/85 hover:bg-white/5'
                    }`}
                  >
                    {a.icon && <span className="shrink-0">{a.icon}</span>}
                    <span className="truncate">{a.label}</span>
                  </button>
                ))}
              </div>
            )}

            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
