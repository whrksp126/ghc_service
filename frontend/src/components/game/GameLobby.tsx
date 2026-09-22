import { useState } from 'react';
import { Crown, Eye, Play, UserPlus, Volume2, VolumeX, X } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { Scoreboard } from './Scoreboard';
import { BOARD_DIMS, MAX_PLAYERS, type BoardSize, type GameMode, type GameSnapshot } from '../../games/types';

const MODE_LABEL: Record<GameMode, string> = { race: '레이스', coop: '협동' };
const MODE_DESC: Record<GameMode, string> = {
  race: '같은 판을 각자 지워서 누가 먼저 끝내는지',
  coop: '한 판을 다 같이 지우고 팀 기록을 남겨요',
};
const SIZE_LABEL: Record<BoardSize, string> = { s: '작게', m: '기본', l: '크게' };
const TIME_CHOICES = [0, 180, 300, 600];

/** 모드·옵션·슬롯·관전자·시작. 호스트만 옵션을 바꿀 수 있고 나머지는 읽기 전용. */
export function GameLobby({ snapshot }: { snapshot: GameSnapshot }) {
  const myUserId = useAuthStore((s) => s.userId);
  const soundOn = useUIStore((s) => s.gameSoundOn);
  const toggleSound = useUIStore((s) => s.toggleGameSound);
  const [busy, setBusy] = useState(false);

  const isHost = snapshot.hostUserId === myUserId;
  const amPlayer = snapshot.players.some((p) => p.userId === myUserId);
  const full = snapshot.players.length >= MAX_PLAYERS;
  const dims = BOARD_DIMS[snapshot.options.boardSize];

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

  const setOptions = (patch: Partial<GameSnapshot['options']>) =>
    call('game:updateOptions', { options: { ...snapshot.options, ...patch } });

  const chip = (active: boolean, disabled: boolean) =>
    `rounded-full px-3 py-1 text-xs transition-colors ${
      active ? 'bg-primary text-white' : 'bg-dark-700 text-white/60 hover:bg-dark-600'
    } ${disabled ? 'pointer-events-none opacity-50' : ''}`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {/* 모드 */}
      <div className="flex items-center gap-2">
        {(['race', 'coop'] as GameMode[]).map((m) => (
          <button
            key={m}
            disabled={!isHost || busy}
            onClick={() => call('game:updateOptions', { mode: m })}
            className={`flex-1 rounded-feed border p-3 text-left transition-colors ${
              snapshot.mode === m ? 'border-primary bg-primary/10' : 'border-white/10 bg-white/5'
            } ${!isHost ? 'opacity-70' : 'hover:border-white/20'}`}
          >
            <p className="text-sm font-semibold">{MODE_LABEL[m]}</p>
            <p className="mt-0.5 text-[11px] leading-tight text-white/45">{MODE_DESC[m]}</p>
          </button>
        ))}
        <button
          onClick={toggleSound}
          className="btn-icon shrink-0 bg-dark-700 hover:bg-dark-600"
          title={soundOn ? '효과음 끄기' : '효과음 켜기'}
        >
          {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* 옵션 */}
      <div className="glass space-y-2 rounded-feed p-3">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-white/50">판 크기</span>
          <div className="flex gap-1.5">
            {(['s', 'm', 'l'] as BoardSize[]).map((s) => (
              <button
                key={s}
                onClick={() => setOptions({ boardSize: s })}
                className={chip(snapshot.options.boardSize === s, !isHost || busy)}
              >
                {SIZE_LABEL[s]} {BOARD_DIMS[s].cols}×{BOARD_DIMS[s].rows}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-white/50">제한 시간</span>
          <div className="flex flex-wrap gap-1.5">
            {TIME_CHOICES.map((t) => (
              <button
                key={t}
                onClick={() => setOptions({ timeLimitSec: t })}
                className={chip(snapshot.options.timeLimitSec === t, !isHost || busy)}
              >
                {t === 0 ? '무제한' : `${t / 60}분`}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-white/50">방해 아이템</span>
          <div className="flex gap-1.5">
            {[false, true].map((v) => (
              <button
                key={String(v)}
                onClick={() => setOptions({ items: v })}
                className={chip(snapshot.options.items === v, !isHost || busy || snapshot.mode === 'coop')}
              >
                {v ? '켜짐' : '꺼짐'}
              </button>
            ))}
          </div>
          {snapshot.mode === 'coop' && (
            <span className="text-[11px] text-white/30">협동에서는 사용 불가</span>
          )}
        </div>
        <p className="text-[11px] text-white/30">
          타일 {dims.cols * dims.rows}개 · 심볼 {(dims.cols * dims.rows) / 4}종
        </p>
      </div>

      {/* 플레이어 슬롯 */}
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

      {/* 관전자 */}
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

      {/* 액션 */}
      <div className="flex flex-wrap items-center gap-2">
        {amPlayer ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => call('game:spectate')}>
            <Eye size={14} /> 관전으로
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={busy} disabled={full} onClick={() => call('game:join')}>
            <UserPlus size={14} /> {full ? '자리가 없어요' : '참가하기'}
          </Button>
        )}
        {isHost && (
          <>
            <Button size="sm" loading={busy} disabled={snapshot.players.length < 1} onClick={() => call('game:start')}>
              <Play size={14} /> 시작
            </Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => call('game:close')}>
              <X size={14} /> 게임 닫기
            </Button>
          </>
        )}
      </div>

      <Scoreboard rows={snapshot.scoreboard} />
    </div>
  );
}
