import { useState } from 'react';
import { Download } from 'lucide-react';
import { motion } from 'framer-motion';
import { isNativeShell } from '../lib/native';
import { detectOS, downloadDesktopApp } from '../lib/downloadApp';
import { showToast } from './common/Toast';

export function DownloadAppButton() {
  const [loading, setLoading] = useState(false);

  // 네이티브 셸(데스크탑/모바일 앱) 안에서는 렌더하지 않음
  if (isNativeShell()) return null;

  const os = detectOS();

  // 현재 데스크탑 앱은 macOS(Apple Silicon)만 배포 중. Windows·Linux·기타는
  // 버튼을 숨겨 웹에서 그대로 사용하게 한다(Windows 빌드 준비되면 'win' 추가).
  if (os !== 'mac') return null;

  const label = 'Mac 앱 다운로드';

  async function handleClick() {
    setLoading(true);
    try {
      await downloadDesktopApp('mac');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : '다운로드에 실패했습니다.';
      showToast(message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.button
      onClick={handleClick}
      disabled={loading}
      whileTap={{ scale: 0.95 }}
      className={`
        w-full flex items-center justify-center gap-2
        px-6 py-3 text-lg font-semibold rounded-btn transition-colors duration-200
        bg-primary hover:bg-primary/90 text-white
        ${loading ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      {loading ? (
        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      ) : (
        <Download size={20} />
      )}
      {label}
    </motion.button>
  );
}
