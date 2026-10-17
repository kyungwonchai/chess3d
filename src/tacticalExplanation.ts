import { Chess, Move } from 'chess.js';

export interface TacticalExplanation {
  type: 'mate' | 'check' | 'capture' | 'defense' | 'attack' | 'strategy';
  badge: string;
  badgeClass: string;
  explanation: string;
  speechSummary: string;
}

const PIECE_NAMES_KO: Record<string, string> = {
  p: '폰',
  n: '나이트',
  b: '비숍',
  r: '룩',
  q: '퀸',
  k: '킹'
};

export function generateTacticalExplanation(game: Chess, moveObj: Move): TacticalExplanation {
  const pieceType = moveObj.piece.toLowerCase();
  const pieceName = PIECE_NAMES_KO[pieceType] || '기물';
  const myColor = moveObj.color;
  const oppColor = myColor === 'w' ? 'b' : 'w';

  // Simulate move to evaluate post-move state
  const testGame = new Chess(game.fen());
  const applied = testGame.move(moveObj);

  if (!applied) {
    return {
      type: 'strategy',
      badge: '♟️ 호수',
      badgeClass: 'hint-badge-strategy',
      explanation: `${pieceName}을(를) ${moveObj.to} 칸으로 전개하는 좋은 수입니다.`,
      speechSummary: `${pieceName}을 ${moveObj.to}로 전개하는 좋은 수입니다.`
    };
  }

  // 1. Checkmate Threat
  if (testGame.isCheckmate()) {
    return {
      type: 'mate',
      badge: '👑 체크메이트 승리',
      badgeClass: 'hint-badge-mate',
      explanation: `${pieceName}이(가) ${moveObj.to}로 돌진하여 상대 킹의 모든 탈출로를 완벽하게 차단하고 즉시 승리를 확정짓는 결정타입니다!`,
      speechSummary: `체크메이트로 즉시 승리하는 최고의 결정타입니다!`
    };
  }

  // 2. Check
  if (testGame.inCheck()) {
    return {
      type: 'check',
      badge: '⚡ 킹 체크 (강제 위협)',
      badgeClass: 'hint-badge-check',
      explanation: `${pieceName}을(를) ${moveObj.to}로 진격시켜 상대 킹을 직접 공격(체크)하며, 상대에게 수비를 강제하고 템포를 빼앗아옵니다.`,
      speechSummary: `상대 킹을 직접 위협하는 강력한 체크 공격수입니다.`
    };
  }

  // 3. Captures
  if (moveObj.captured) {
    const capName = PIECE_NAMES_KO[moveObj.captured.toLowerCase()] || '상대 기물';
    const isEnPassant = moveObj.flags && moveObj.flags.includes('e');

    if (isEnPassant) {
      return {
        type: 'capture',
        badge: '⚔️ 앙파상 (특수 폰 포획)',
        badgeClass: 'hint-badge-attack',
        explanation: `상대 폰이 두 칸 전진한 틈을 타 스쳐 지나간 폰을 앙파상(En Passant) 룰로 잡아내는 절묘한 전술적 포획입니다!`,
        speechSummary: `상대 폰을 앙파상으로 포획하는 전술수입니다.`
      };
    }

    return {
      type: 'capture',
      badge: `⚔️ ${capName} 제압 포획`,
      badgeClass: 'hint-badge-attack',
      explanation: `상대 진영의 ${capName}을(를) 제거하여 기물 우위를 확보하고 상대의 수비 진형을 무너뜨리는 결정적인 공격수입니다.`,
      speechSummary: `상대 ${capName}을 잡아 우위를 점하는 공격수입니다.`
    };
  }

  // 4. Castling
  if (moveObj.flags && (moveObj.flags.includes('k') || moveObj.flags.includes('q'))) {
    return {
      type: 'defense',
      badge: '🛡️ 캐슬링 (킹 보호 & 룩 전개)',
      badgeClass: 'hint-badge-defense',
      explanation: `킹을 안전한 측면 요새로 대피시키는 동시에 구석의 룩을 중앙 전장으로 빠르게 연결하는 정석 수비 전략입니다.`,
      speechSummary: `킹을 안전하게 지키고 룩을 중앙으로 전개하는 캐슬링 방어수입니다.`
    };
  }

  // 5. Strategic Center Control & Piece Development
  const centerCore = ['d4', 'd5', 'e4', 'e5'];
  const centerExtended = ['c4', 'c5', 'f4', 'f5', 'c3', 'f3', 'c6', 'f6'];
  const backRank = moveObj.color === 'w' ? '1' : '8';

  if (centerCore.includes(moveObj.to)) {
    return {
      type: 'strategy',
      badge: '♟️ 핵심 중앙 장악',
      badgeClass: 'hint-badge-strategy',
      explanation: `체스판의 심장부인 ${moveObj.to} 중앙 칸을 선점하여 아군 기물들의 이동 통로를 넓히고 상대의 활동 반경을 억제하는 핵심 전략수입니다.`,
      speechSummary: `중앙 요충지를 장악하여 판세를 유리하게 이끄는 전략수입니다.`
    };
  }

  if ((pieceType === 'n' || pieceType === 'b') && moveObj.from.endsWith(backRank)) {
    return {
      type: 'strategy',
      badge: '🚀 기물 빠른 전개',
      badgeClass: 'hint-badge-strategy',
      explanation: `뒷줄에 잠들어 있던 ${pieceName}을(를) ${moveObj.to} 요충지로 출격시켜 전방 영향력을 높이고 캐슬링을 준비하는 훌륭한 오프닝 전개수입니다.`,
      speechSummary: `${pieceName}을 전장으로 빠르게 전개하는 정석 수입니다.`
    };
  }

  if (pieceType === 'r' && ['c', 'd', 'e', 'f'].includes(moveObj.to[0])) {
    return {
      type: 'strategy',
      badge: '🗼 룩 중앙열 배치',
      badgeClass: 'hint-badge-strategy',
      explanation: `원거리 기물인 룩을 ${moveObj.to[0].toUpperCase()}열 중앙 라인에 배치하여 열린 길을 장악하고 침투를 준비하는 수입니다.`,
      speechSummary: `룩을 중앙 라인에 배치하여 열을 장악하는 전략수입니다.`
    };
  }

  if (centerExtended.includes(moveObj.to)) {
    return {
      type: 'strategy',
      badge: '♟️ 중앙 지원 포석',
      badgeClass: 'hint-badge-strategy',
      explanation: `${pieceName}을(를) ${moveObj.to} 거점에 배치하여 중앙 싸움을 든든하게 지원하고 다음 공격 루트를 준비하는 안정적인 포석입니다.`,
      speechSummary: `중앙 싸움을 지원하는 탄탄한 전략수입니다.`
    };
  }

  return {
    type: 'strategy',
    badge: '♟️ 포지션 강화',
    badgeClass: 'hint-badge-strategy',
    explanation: `${pieceName}의 활동 반경을 넓히고 아군 기물 간 연결고리를 단단하게 만들어 상대가 파고들 틈을 없애는 호수입니다.`,
    speechSummary: `${pieceName}의 활동 범위를 넓히는 포지션 강화수입니다.`
  };
}

export function speakKoreanText(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    console.warn('SpeechSynthesis error:', e);
  }
}
