import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { RoomPage } from './pages/RoomPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { CamerasPage } from './pages/CamerasPage';
import { ToastContainer } from './components/common/Toast';
import { CameraIndicator } from './components/common/CameraIndicator';
import { useAuthStore } from './stores/authStore';
import { useGlobalSocket } from './hooks/useGlobalSocket';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function GuestRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (token) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function GlobalSocketManager() {
  useGlobalSocket();
  return null;
}

// In the packaged desktop app the page loads from file:// — BrowserRouter (history API) can't do
// clean-path routing there, so use HashRouter. Web/dev (http/https) keeps BrowserRouter.
const Router = typeof window !== 'undefined' && window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

export default function App() {
  const token = useAuthStore((s) => s.token);

  return (
    <Router>
      <ToastContainer />
      {token && <GlobalSocketManager />}
      {token && <CameraIndicator />}
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <HomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/login"
          element={
            <GuestRoute>
              <LoginPage />
            </GuestRoute>
          }
        />
        <Route
          path="/register"
          element={
            <GuestRoute>
              <RegisterPage />
            </GuestRoute>
          }
        />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route
          path="/cameras"
          element={
            <ProtectedRoute>
              <CamerasPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/room/:slug"
          element={
            <ProtectedRoute>
              <RoomPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
