import { create } from 'zustand';
import type { Participant, ConsumerInfo, ConnectionQuality } from '../types/room';

interface RoomState {
  roomSlug: string | null;
  roomName: string | null;
  hasPin: boolean;
  participants: Participant[];
  consumers: ConsumerInfo[];
  connectionQuality: ConnectionQuality;
  isConnecting: boolean;
  isReconnecting: boolean;
  error: string | null;

  setRoom: (slug: string, name: string) => void;
  clearRoom: () => void;
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (userId: string, deviceId: string) => void;
  addConsumer: (consumer: ConsumerInfo) => void;
  removeConsumer: (consumerId: string) => void;
  removeConsumersByProducerId: (producerId: string) => void;
  updateConsumer: (consumerId: string, updates: Partial<ConsumerInfo>) => void;
  setConnectionQuality: (quality: ConnectionQuality) => void;
  setConnecting: (v: boolean) => void;
  setReconnecting: (v: boolean) => void;
  setError: (error: string | null) => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  roomSlug: null,
  roomName: null,
  hasPin: false,
  participants: [],
  consumers: [],
  connectionQuality: 'excellent',
  isConnecting: false,
  isReconnecting: false,
  error: null,

  setRoom: (slug, name) => set({ roomSlug: slug, roomName: name }),
  clearRoom: () =>
    set({
      roomSlug: null,
      roomName: null,
      hasPin: false,
      participants: [],
      consumers: [],
      connectionQuality: 'excellent',
      isConnecting: false,
      isReconnecting: false,
      error: null,
    }),

  setParticipants: (participants) => set({ participants }),
  addParticipant: (participant) =>
    set((s) => ({
      participants: [...s.participants.filter(
        (p) => !(p.userId === participant.userId && p.deviceId === participant.deviceId)
      ), participant],
    })),
  removeParticipant: (userId, deviceId) =>
    set((s) => ({
      participants: s.participants.filter(
        (p) => !(p.userId === userId && p.deviceId === deviceId)
      ),
    })),

  addConsumer: (consumer) =>
    set((s) => ({ consumers: [...s.consumers, consumer] })),
  removeConsumer: (consumerId) =>
    set((s) => ({ consumers: s.consumers.filter((c) => c.consumerId !== consumerId) })),
  removeConsumersByProducerId: (producerId) =>
    set((s) => ({ consumers: s.consumers.filter((c) => c.producerId !== producerId) })),
  updateConsumer: (consumerId, updates) =>
    set((s) => ({
      consumers: s.consumers.map((c) =>
        c.consumerId === consumerId ? { ...c, ...updates } : c
      ),
    })),

  setConnectionQuality: (quality) => set({ connectionQuality: quality }),
  setConnecting: (v) => set({ isConnecting: v }),
  setReconnecting: (v) => set({ isReconnecting: v }),
  setError: (error) => set({ error }),
}));
