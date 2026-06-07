import { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            // Cap the height and scroll inside: on a phone (bottom-sheet layout) a tall modal — e.g.
            // the audio settings with the mic-gain slider at the bottom — otherwise overflows the
            // viewport and its lower controls get clipped behind the home bar. max-h + overflow makes
            // the content scrollable, and the safe-area padding keeps the last control above the bar.
            className="relative w-full sm:max-w-md glass-strong rounded-t-modal sm:rounded-modal p-6 z-10 max-h-[90dvh] overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            {title && (
              <h2 className="text-xl font-display font-bold mb-4">{title}</h2>
            )}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
