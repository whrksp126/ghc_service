// 설계서 §5 파일 트리는 symbols.ts를 components/game/ 아래에 적어 두었고, 작업 지시는
// games/symbols.ts를 요구했다. 실제 구현은 games/symbols.ts 한 곳이고 여기서는 재export만 한다.
export { SYMBOLS, symbolOf, type GameSymbol } from '../../games/symbols';
