import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  userId: string | null;
  nickname: string | null;
  email: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  setAuth: (token: string, userId: string, nickname: string, email?: string | null) => void;
  setDevice: (deviceId: string, deviceLabel: string) => void;
  logout: () => void;
  isLoggedIn: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      userId: null,
      nickname: null,
      email: null,
      deviceId: null,
      deviceLabel: null,
      setAuth: (token, userId, nickname, email) =>
        set({ token, userId, nickname, email: email ?? null }),
      setDevice: (deviceId, deviceLabel) => set({ deviceId, deviceLabel }),
      logout: () =>
        set({ token: null, userId: null, nickname: null, email: null, deviceId: null, deviceLabel: null }),
      isLoggedIn: () => !!get().token,
    }),
    { name: 'ghc-auth' }
  )
);
