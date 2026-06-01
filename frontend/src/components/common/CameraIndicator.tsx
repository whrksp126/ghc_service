import { useState, useEffect } from 'react';
import { useAlwaysOnCamera } from '../../services/alwaysOnCamera';
import { PermissionDeniedModal } from './PermissionDeniedModal';

/**
 * Surfaces camera errors / permission issues only. The previous "카메라 활성" green
 * badge was removed — when the camera is running fine, nothing is rendered.
 */
export function CameraIndicator() {
  const { error, errorType } = useAlwaysOnCamera();
  const [showPermModal, setShowPermModal] = useState(false);

  useEffect(() => {
    if (errorType === 'permission') {
      setShowPermModal(true);
    }
  }, [errorType]);

  useEffect(() => {
    if (!error) {
      setShowPermModal(false);
    }
  }, [error]);

  if (error) {
    return (
      <>
        <div
          className="fixed top-0 left-0 right-0 z-50 bg-danger/90 text-white text-xs text-center py-1.5 px-4 cursor-pointer"
          onClick={() => errorType === 'permission' && setShowPermModal(true)}
        >
          카메라 오류: {error}
          {errorType === 'permission' && (
            <span className="ml-2 underline">권한 설정</span>
          )}
        </div>
        <PermissionDeniedModal
          isOpen={showPermModal}
          onClose={() => setShowPermModal(false)}
        />
      </>
    );
  }

  return null;
}
