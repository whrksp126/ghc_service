import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, CheckCircle2, Monitor, Laptop, AlertCircle } from 'lucide-react';
import { getUpdater, type UpdateStatus } from '../lib/updater';
import { nativePlatform } from '../lib/native';

/**
 * 앱 버전/업데이트 화면 — 데스크탑 셸에서만 노출.
 * 설치된 버전 vs 최신 버전을 보여주고, 설치 파일을 다시 내려받지 않고 앱 안에서
 * 바로 업데이트(다운로드 + 재시작)한다. 모바일/웹(getUpdater() === null)에서는
 * 아무것도 렌더하지 않는다 — 그쪽은 앱 업데이트가 스토어/브라우저에서 이뤄진다.
 *
 * 자체 카드 배경/테두리를 두지 않는다. 이건 "앱 정보" 모달 안에 들어가는 내용이고,
 * 모달이 이미 카드다 — 안에 또 카드를 그리면 테두리가 겹쳐 보인다. 구획은 얇은
 * 구분선으로만 준다(설정 목록과 같은 방식).
 */
export function DeviceVersionCard() {
  const updater = useMemo(() => getUpdater(), []);
  const [current, setCurrent] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    if (!updater) return;
    updater.current().then(setCurrent).catch(() => {});
    updater.onStatus(setStatus);
    updater.check().catch(() => {});
  }, [updater]);

  if (!updater) return null; // 데스크탑 셸 전용

  const platform = nativePlatform();
  const osLabel = platform === 'desktop' ? (isMac() ? 'Mac' : 'Windows') : '데스크탑';
  const OsIcon = isMac() ? Laptop : Monitor;

  const busy = status.state === 'idle' || status.state === 'checking';
  const available = status.state === 'available';
  const downloading = status.state === 'downloading';
  const downloaded = status.state === 'downloaded';
  const upToDate = status.state === 'none';
  const errored = status.state === 'error';

  const latestVersion =
    available || downloaded ? status.version : upToDate ? current ?? undefined : undefined;

  return (
    <div>
      {/* 모달 제목이 이미 "앱 정보"라 여기서 이름을 반복하지 않는다 — 어느 기기의 어느 앱인지만. */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
          <OsIcon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-white leading-tight">GHC</p>
          <p className="text-xs text-white/40 mt-0.5">{osLabel} 데스크탑 앱</p>
        </div>
        <button
          onClick={() => updater.check().catch(() => {})}
          disabled={busy || downloading}
          className="shrink-0 inline-flex items-center gap-1 text-xs text-white/50 hover:text-white transition active:scale-95 disabled:opacity-40"
        >
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          업데이트 확인
        </button>
      </div>

      <dl className="mt-4 text-sm border-y border-white/10 divide-y divide-white/10">
        <div className="flex items-center justify-between py-2.5">
          <dt className="text-white/50">현재 버전</dt>
          <dd className="font-medium text-white tabular-nums">v{current ?? '—'}</dd>
        </div>
        <div className="flex items-center justify-between py-2.5">
          <dt className="text-white/50">최신 버전</dt>
          <dd className="font-medium text-white tabular-nums">
            {busy ? '확인 중…' : latestVersion ? `v${latestVersion}` : '—'}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        {upToDate && (
          <div className="flex items-center gap-1.5 text-sm text-secondary font-medium">
            <CheckCircle2 size={16} /> 최신 버전이에요
          </div>
        )}

        {available && (
          <button
            onClick={() => {
              // 버튼을 누르는 즉시 진행 UI를 띄운다. electron-updater의 첫
              // 'download-progress' 이벤트(실제 바이트가 흐를 때만 발화)를 기다리면
              // 빈 구간이 생긴다.
              setStatus({ state: 'downloading', percent: 0 });
              updater.download().catch(() => {});
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-btn bg-primary hover:bg-primary-hover text-white font-semibold px-4 py-2.5 transition active:scale-[0.98]"
          >
            <Download size={16} strokeWidth={2.25} /> 업데이트 (v{status.version})
          </button>
        )}

        {downloading && (
          <div>
            <div className="flex items-center justify-between text-xs text-white/50 mb-1">
              <span>{status.percent > 0 ? '다운로드 중…' : '다운로드 준비 중…'}</span>
              {status.percent > 0 && <span>{Math.round(status.percent)}%</span>}
            </div>
            <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.max(6, Math.round(status.percent))}%` }}
              />
            </div>
          </div>
        )}

        {downloaded && (
          <button
            onClick={() => updater.install().catch(() => {})}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-btn bg-primary hover:bg-primary-hover text-white font-semibold px-4 py-2.5 transition active:scale-[0.98]"
          >
            <RefreshCw size={16} strokeWidth={2.25} /> 재시작하여 설치
          </button>
        )}

        {errored && (
          <div className="flex items-center gap-1.5 text-xs text-danger">
            <AlertCircle size={14} /> 업데이트 확인에 실패했어요. 잠시 후 다시 시도해 주세요.
          </div>
        )}
      </div>
    </div>
  );
}

// 데스크탑 셸은 platform === 'desktop' 하나로 Mac/Windows를 구분하지 않으므로
// userAgent로 표시 라벨/아이콘만 가른다(기능 분기 아님).
function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
}
