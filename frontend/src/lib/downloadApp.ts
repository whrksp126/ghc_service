import { API_URL } from '../config/constants';

export type AppPlatform = 'win' | 'mac';

export interface ReleaseInfo {
  platform: AppPlatform;
  key: string;
  filename: string;
  size: number;
  url: string;
  updatedAt: string;
}

export function detectOS(): AppPlatform | null {
  const ua = navigator.userAgent;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';

  // Windows
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'win';

  // macOS / iOS — distinguish by checking for iPhone/iPad to exclude iOS
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    // Exclude iOS devices that report Macintosh in UA (iPadOS 13+)
    const isTouchDevice = typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
    if (!isTouchDevice) return 'mac';
  }

  return null;
}

export async function downloadDesktopApp(platform?: AppPlatform): Promise<void> {
  const resolvedPlatform = platform ?? detectOS();
  if (!resolvedPlatform) {
    throw new Error('지원되지 않는 운영체제입니다.');
  }

  const res = await fetch(
    `${API_URL}/api/releases/latest?platform=${resolvedPlatform}`,
    { headers: { Accept: 'application/json' } }
  );

  if (!res.ok) {
    let message = '다운로드 정보를 불러오지 못했습니다.';
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore parse error
    }
    throw new Error(message);
  }

  const data: Partial<ReleaseInfo> = await res.json();
  const downloadUrl = data?.url;

  if (!downloadUrl) {
    throw new Error('다운로드 링크가 없습니다.');
  }

  // Trigger download via a temporary <a> element
  const a = document.createElement('a');
  a.href = downloadUrl;
  if (data.filename) a.download = data.filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
