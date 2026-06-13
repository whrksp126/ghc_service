import { Download } from 'lucide-react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { isNativeShell } from '../lib/native';

export function DownloadAppButton() {
  const navigate = useNavigate();

  // 네이티브 셸(데스크탑/모바일 앱) 안에서는 렌더하지 않음
  if (isNativeShell()) return null;

  const label = '앱 다운로드';

  return (
    <motion.button
      onClick={() => navigate('/download')}
      whileTap={{ scale: 0.95 }}
      title={label}
      aria-label={label}
      className="
        flex items-center gap-1.5 rounded-full px-3 py-1.5
        text-sm text-white/70 hover:text-white hover:bg-white/5
        border border-white/10 transition-colors
      "
    >
      <Download size={16} />
      <span className="hidden sm:inline">앱 다운로드</span>
    </motion.button>
  );
}
