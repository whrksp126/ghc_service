import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '../components/common/Button';
import { showToast } from '../components/common/Toast';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { API_URL } from '../config/constants';
import { getDeviceFingerprint, getDeviceType } from '../lib/fingerprint';

const deviceTypeLabel: Record<string, string> = {
  phone: '휴대폰',
  tablet: '태블릿',
  desktop: '데스크톱',
  other: '기기',
};

export function RegisterPage() {
  const navigate = useNavigate();
  const { setAuth, setDevice } = useAuthStore();

  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!nickname.trim() || !email.trim() || !password) return;

    if (password !== passwordConfirm) {
      showToast('비밀번호가 일치하지 않습니다', 'error');
      return;
    }

    if (password.length < 8) {
      showToast('비밀번호는 8자 이상이어야 합니다', 'error');
      return;
    }

    setLoading(true);
    try {
      const fp = getDeviceFingerprint();
      const dt = getDeviceType();
      const res = await api.register({
        nickname: nickname.trim(),
        email: email.trim(),
        password,
        deviceFingerprint: fp,
        deviceType: dt,
        deviceLabel: deviceTypeLabel[dt] || '기기',
      });
      setAuth(res.token, res.user.id, res.user.nickname, res.user.email);
      setDevice(res.device.id, res.device.label);
      showToast(`${res.user.nickname}님, 환영합니다!`, 'success');
      navigate('/');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function handleGoogleRegister() {
    window.location.href = `${API_URL}/api/auth/google`;
  }

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        <div className="text-center mb-8">
          <h1 className="text-3xl font-display font-extrabold tracking-tight mb-2">
            <span className="text-primary">Long</span>
            <span className="text-secondary">dcam</span>
          </h1>
          <p className="text-white/50">새 계정을 만들어보세요</p>
        </div>

        <form onSubmit={handleRegister} className="space-y-4">
          <div>
            <label className="text-sm text-white/50 mb-1.5 block">닉네임</label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="이름을 입력하세요"
              className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
              maxLength={50}
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm text-white/50 mb-1.5 block">이메일</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@email.com"
              className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="text-sm text-white/50 mb-1.5 block">비밀번호</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8자 이상"
                className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 pr-12 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
                aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
          <div>
            <label className="text-sm text-white/50 mb-1.5 block">비밀번호 확인</label>
            <div className="relative">
              <input
                type={showPasswordConfirm ? 'text' : 'password'}
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                placeholder="비밀번호를 다시 입력하세요"
                className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 pr-12 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPasswordConfirm((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
                aria-label={showPasswordConfirm ? '비밀번호 숨기기' : '비밀번호 표시'}
              >
                {showPasswordConfirm ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
          <Button className="w-full" size="lg" loading={loading} type="submit">
            회원가입
          </Button>
        </form>

        <div className="my-6 flex items-center gap-3">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-xs text-white/30">또는</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>

        <Button
          className="w-full"
          variant="secondary"
          size="lg"
          onClick={handleGoogleRegister}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Google로 시작하기
        </Button>

        <p className="text-center text-sm text-white/40 mt-6">
          이미 계정이 있으신가요?{' '}
          <Link to="/login" className="text-primary hover:underline">
            로그인
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
