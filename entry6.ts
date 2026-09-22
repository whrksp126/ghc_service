
import { useGameStore } from '/Users/whrksp126/other/project/longdcam/ghc_service/frontend/src/stores/gameStore';
import { useAuthStore } from '/Users/whrksp126/other/project/longdcam/ghc_service/frontend/src/stores/authStore';
import type { GameSnapshot } from '/Users/whrksp126/other/project/longdcam/ghc_service/frontend/src/games/types';
useAuthStore.setState({ userId: 'u1', nickname: 'me' } as any);
const snap: GameSnapshot = {
  gameId:'shisen', phase:'playing', hostUserId:'u1', mode:'coop',
  options:{boardSize:'s',items:false,timeLimitSec:0}, seed:1, startAt:Date.now(), endedAt:null,
  players:[
    {userId:'u1',nickname:'me',color:'#FE2C55',boardId:'shared',score:0,combo:0,maxCombo:0,pairsCleared:0,lastMatchAt:0,hintsLeft:5,finishedAt:null,connected:true},
    {userId:'u2',nickname:'you',color:'#25F4EE',boardId:'shared',score:0,combo:0,maxCombo:0,pairsCleared:0,lastMatchAt:0,hintsLeft:5,finishedAt:null,connected:true},
  ],
  boards:{ shared:{id:'shared',cols:4,rows:2,cells:[1,1,2,2,3,3,4,4],remaining:8,effects:[]} },
  spectators:[], results:null, scoreboard:[], seq:5,
};
const S = useGameStore.getState();
S.applySnapshot(snap);
// 1) 내가 (0,1) 예측 제거
S.predictPick('shared', 0, 1, [{r:0,c:0},{r:0,c:1}], '#FE2C55');
console.log('predict → cells', useGameStore.getState().snapshot!.boards.shared.cells.join(','), 'remaining', useGameStore.getState().snapshot!.boards.shared.remaining);
// 2) 상대가 먼저 같은 쌍을 지운 matched 도착
useGameStore.getState().applyMatched({seq:6,userId:'u2',boardId:'shared',a:0,b:1,path:[],combo:1,score:10,remaining:6});
const pend = useGameStore.getState().pendingPicks[0];
console.log('pending superseded?', pend?.superseded, 'color', pend?.supersededColor);
// 3) 내 ack가 늦게 {ok:false, gone}으로 도착 → 절대 되살리면 안 됨
const pick = useGameStore.getState().takePending(0,1)!;
useGameStore.getState().rollbackPick(pick);   // superseded → dropPending으로 우회
const b = useGameStore.getState().snapshot!.boards.shared;
console.log('after gone-rollback cells', b.cells.join(','), 'remaining', b.remaining, 'pending', useGameStore.getState().pendingPicks.length);
console.log('flash fx', useGameStore.getState().fxQueue.filter(f=>f.type==='flash').map(f=>f.color).join(','));
// 4) 정상 거절(nopath)은 되살린다
S.predictPick('shared', 4, 5, [{r:1,c:0},{r:1,c:1}], '#FE2C55');
const p2 = useGameStore.getState().takePending(4,5)!;
useGameStore.getState().rollbackPick(p2);
const b2 = useGameStore.getState().snapshot!.boards.shared;
console.log('after normal rollback cells', b2.cells.join(','), 'remaining', b2.remaining);
