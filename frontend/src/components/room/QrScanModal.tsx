import { useEffect, useRef, useState } from 'react';
import { Modal } from '../common/Modal';

interface QrScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with an in-app path like `/room/abcd` or `/room/abcd?invite=...`. */
  onResult: (path: string) => void;
}

/**
 * Camera QR scanner using the native BarcodeDetector API (no extra dependency).
 * Supported on Chrome desktop + Android. On unsupported browsers (e.g. iOS Safari) we
 * tell the user to scan with their phone's Camera app, which opens the room URL directly.
 */
export function QrScanModal({ isOpen, onClose, onResult }: QrScanModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const supported = typeof (window as any).BarcodeDetector !== 'undefined';

  useEffect(() => {
    if (!isOpen) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    function finish(path: string) {
      stopped = true;
      cleanup();
      onResult(path);
    }

    function handleValue(raw: string) {
      let path = '';
      try {
        const u = new URL(raw);
        const m = u.pathname.match(/\/room\/([^/?#]+)/);
        if (m) path = `/room/${m[1]}${u.search || ''}`;
      } catch {
        const code = raw.trim();
        if (code) path = `/room/${code.toLowerCase()}`;
      }
      if (path) finish(path);
    }

    async function start() {
      if (!supported) {
        setErr('이 브라우저는 스캔을 지원하지 않아요. 휴대폰 카메라 앱으로 QR을 찍으면 방이 바로 열립니다.');
        return;
      }
      try {
        const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        const scan = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes && codes.length) { handleValue(codes[0].rawValue as string); return; }
          } catch { /* keep scanning */ }
          raf = requestAnimationFrame(scan);
        };
        scan();
      } catch (e: any) {
        setErr('카메라를 열 수 없습니다. 권한을 확인해주세요.');
      }
    }

    function cleanup() {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    }

    start();
    return () => { stopped = true; cleanup(); };
  }, [isOpen, supported, onResult]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="QR 코드 스캔">
      <div className="space-y-3">
        {err ? (
          <p className="text-sm text-white/60 leading-relaxed">{err}</p>
        ) : (
          <>
            <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-black">
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
              <div className="absolute inset-8 border-2 border-secondary/70 rounded-xl pointer-events-none" />
            </div>
            <p className="text-xs text-white/40 text-center">초대 QR 코드를 사각형 안에 비추세요</p>
          </>
        )}
      </div>
    </Modal>
  );
}
