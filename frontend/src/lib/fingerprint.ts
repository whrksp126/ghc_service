export function getDeviceFingerprint(): string {
  const stored = localStorage.getItem('ghc-fp');
  if (stored) return stored;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx?.fillText('fp', 0, 0);
  const canvasHash = canvas.toDataURL().slice(-20);

  const parts = [
    navigator.userAgent,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    canvasHash,
    Date.now().toString(36),
  ];

  const fp = btoa(parts.join('|')).slice(0, 32);
  localStorage.setItem('ghc-fp', fp);
  return fp;
}

export function getDeviceType(): 'phone' | 'tablet' | 'desktop' | 'other' {
  const ua = navigator.userAgent.toLowerCase();
  if (/ipad|tablet/.test(ua) || (screen.width >= 768 && /android/.test(ua))) return 'tablet';
  if (/mobile|iphone|android/.test(ua)) return 'phone';
  return 'desktop';
}
