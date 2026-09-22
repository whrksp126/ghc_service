import { useState } from 'react';
import { Crown, Eye, LogOut, Play, UserPlus, Volume2, VolumeX, X } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { Scoreboard } from './Scoreboard';
import { ShisenSettings } from './ShisenSettings';
import { MAX_PLAYERS, type GameMode, type GameOptions, type GameSnapshot } from '../../games/types';

/** 게임 선택 카드 (v2 §V1-1). 테트리스는 자리만 잡아 둔다. */
const GAMES: Array<{ id: string; name: string; desc: string; ready: boolean }> = [
  { id: 'shisen', name: '사천성', desc: '같은 그림 두 개를 이어서 지우기', ready: true },
  { id: 'tetris', name: '테트리스', desc: '준비 중', ready: false },
];

/** 로비: 게임 선택 → 상세 설정 → 플레이어 슬롯 → 시작/나가기 → 전적. */
export function GameLobby({ snapshot }: { snapshot: GameSnapshot }) {
  const myUserId = useAuthStore((s) => s.userId);
  const soundOn = useUIStore((s) => s.gameSoundOn);
  const toggleSound = useUIStore((s) => s.toggleGameSound);
  const [busy, setBusy] = useState(false);

  const isHost = snapshot.hostUserId === myUserId;
  const amPlayer = snapshot.players.some((p) => p.userId === myUserId);
  const full = snapshot.players.length >= MAX_PLAYERS;

  const call = async (event: string, payload: unknown = {}) => {
    setBusy(true);
    try {
      await emitWithAck(event, payload);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '요청에 실패했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  // options는 서버에서 부분 병합된다(v2 §V2).
  const patchOptions = (patch: Partial<GameOptions>) => call('game:updateOptions', { options: patch });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {/* 1. 게임 선택 */}
      <div className="flex items-center gap-2">
        {GAMES.map((g) => {
          const selected = snapshot.gameId === g.id;
          return (
            <button
              key={g.id}
              disabled={!g.ready || !isHost || busy}
              onClick={() => call('game:updateOptions', { gameId: g.id })}
              className={`flex-1 rounded-feed border p-2.5 text-left transition-colors ${
                selected ? 'border-primary bg-primary/10' : 'border-white/10 bg-white/5'
              } ${!g.ready ? 'opacity-40' : isHost ? 'hover:border-white/20' : 'opacity-80'}`}
            >
              <p className="text-sm font-semibold">{g.name}</p>
              <p className="mt-0.5 text-[11px] leading-tight text-white/45">{g.desc}</p>
            </button>
          );
        })}
        <button
          onClick={toggleSound}
          className="btn-icon shrink-0 bg-dark-700 hover:bg-dark-600"
          title={soundOn ? '효과음 끄기' : '효과음 켜기'}
        >
          {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* 2. 상세 설정 */}
      <ShisenSettings
        mode={snapshot.mode}
        options={snapshot.options}
        seed={snapshot.seed}
        canEdit={isHost}
        busy={busy}
        onMode={(mode: GameMode) => call('game:updateOptions', { mode })}
        onOptions={patchOptions}
      />

      {/* 3. 플레이어 슬롯 */}
      <div>
        <p className="mb-1.5 px-1 text-xs text-white/50">플레이어 {snapshot.players.length}/{MAX_PLAYERS}</p>
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: MAX_PLAYERS }).map((_, i) => {
            const p = snapshot.players[i];
            return (
              <div
                key={i}
                className={`flex items-center gap-2 rounded-btn px-3 py-2 text-sm ${
                  p ? 'bg-white/5' : 'border border-dashed border-white/10 text-white/25'
                }`}
              >
                {p ? (
                  <>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                    <span className="min-w-0 flex-1 truncate">{p.nickname}</span>
                    {p.userId === snapshot.hostUserId && <Crown size={13} className="shrink-0 text-warning" />}
                    {p.userId === myUserId && <span className="shrink-0 text-[11px] text-white/40">나</span>}
                  </>
                ) : (
                  <span className="text-xs">빈 자리</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {snapshot.spectators.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <Eye size={13} className="text-white/40" />
          {snapshot.spectators.map((s) => (
            <span key={s.userId} className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-white/60">
              {s.nickname}
            </span>
          ))}
        </div>
      )}

      {/* 4. 액션 */}
      <div className="flex flex-wrap items-center gap-2">
        {isHost && (
          <Button size="sm" loading={busy} disabled={snapshot.players.length < 1} onClick={() => call('game:start')}>
            <Play size={14} /> 시작
          </Button>
        )}
        {amPlayer ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => call('game:spectate')}>
            <LogOut size={14} /> 나가기
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={busy} disabled={full} onClick={() => call('game:join')}>
            <UserPlus size={14} /> {full ? '자리가 없어요' : '입장'}
          </Button>
        )}
        {isHost && (
          <Button size="sm" variant="ghost" loading={busy} onClick={() => call('game:close')}>
            <X size={14} /> 방 닫기
          </Button>
        )}
      </div>

      <Scoreboard rows={snapshot.scoreboard} />
    </div>
  );
}
