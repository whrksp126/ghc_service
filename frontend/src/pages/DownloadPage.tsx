import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Download, Apple, Monitor, ArrowLeft, Info } from 'lucide-react';
import logoUrl from '../assets/ghcam-logo.png';
import { Button } from '../components/common/Button';
import { showToast } from '../components/common/Toast';
import { detectOS, downloadDesktopApp, type AppPlatform } from '../lib/downloadApp';

interface PlatformCard {
  platform: AppPlatform;
  name: string;
  icon: typeof Apple;
  note?: string;
}

const CARDS: PlatformCard[] = [
  { platform: 'mac', name: 'macOS', icon: Apple, note: 'Apple Silicon (M1 이상) 전용' },
  {
    platform: 'win',
    name: 'Windows',
    icon: Monitor,
    note: '설치 시 SmartScreen 경고가 보이면 "추가 정보 → 실행"을 눌러주세요.',
  },
];

export function DownloadPage() {
  const navigate = useNavigate();
  const detected = detectOS();
  const [loading, setLoading] = useState<AppPlatform | null>(null);

  // 감지된 OS 카드를 맨 앞으로 정렬해 강조한다.
  const cards = [...CARDS].sort((a, b) => {
    if (a.platform === detected) return -1;
    if (b.platform === detected) return 1;
    return 0;
  });

  async function handleDownload(platform: AppPlatform) {
    setLoading(platform);
    try {
      await downloadDesktopApp(platform);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : '다운로드에 실패했습니다.';
      showToast(message, 'error');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col items-center px-6 py-10">
      <div className="w-full max-w-md">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-white/50 hover:text-white text-sm mb-8 transition-colors"
        >
          <ArrowLeft size={16} />
          돌아가기
        </button>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <img src={logoUrl} alt="GHC" className="h-12 w-auto mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-white">데스크탑 앱 다운로드</h1>
          <p className="text-white/50 text-sm mt-2">
            운영체제에 맞는 버전을 선택해 다운로드하세요.
          </p>
        </motion.div>

        <div className="space-y-4">
          {cards.map((card) => {
            const Icon = card.icon;
            const isRecommended = card.platform === detected;
            return (
              <motion.div
                key={card.platform}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className={`rounded-2xl border p-5 ${
                  isRecommended
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-white/10 bg-dark-700'
                }`}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center text-white">
                    <Icon size={22} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">{card.name}</span>
                      {isRecommended && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary text-white">
                          내 기기
                        </span>
                      )}
                    </div>
                    {card.note && (
                      <p className="text-xs text-white/40 mt-0.5">{card.note}</p>
                    )}
                  </div>
                </div>
                <Button
                  className="w-full"
                  size="lg"
                  variant={isRecommended ? 'primary' : 'secondary'}
                  loading={loading === card.platform}
                  onClick={() => handleDownload(card.platform)}
                >
                  <Download size={18} />
                  {card.name} 앱 다운로드
                </Button>
              </motion.div>
            );
          })}
        </div>

        <div className="mt-8 flex items-start gap-2 text-white/40 text-xs">
          <Info size={14} className="shrink-0 mt-0.5" />
          <p>
            모바일 기기는 별도 설치 없이 브라우저(웹)에서 그대로 사용할 수 있습니다.
            데스크탑 앱은 Windows·macOS를 지원합니다.
          </p>
        </div>
      </div>
    </div>
  );
}
