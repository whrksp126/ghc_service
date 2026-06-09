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
      title={label}
      aria-label={label}
      className={`
        flex items-center gap-1.5 rounded-full px-3 py-1.5
        text-sm text-white/70 hover:text-white hover:bg-white/5
        border border-white/10 transition-colors
        ${loading ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      {loading ? (
        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      ) : (
        <Download size={16} />
      )}
      <span className="hidden sm:inline">Mac 앱</span>
    </motion.button>
  );
}
