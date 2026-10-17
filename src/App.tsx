import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Chess, Square, Move } from 'chess.js';
import { initWizardChess } from './wizardChessEngine.js';
import { audio } from './audio';
import { evaluateBoard, findBestMove, computeCapturedPieces } from './chessEngine';
import { generateTacticalExplanation, speakKoreanText, TacticalExplanation } from './tacticalExplanation';

type GameMode = 'ai' | 'online' | 'local';
type EnvTheme = 'cathedral' | 'bluesky' | 'cosmic' | 'studio';

interface RoomInfo {
  id: string;
  name: string;
  status: string;
  host: string;
  players: number;
  timeControl: { initial: number; increment: number };
}

interface ChatMessage {
  sender: string;
  text: string;
  emoji?: string;
  timestamp: number;
}

export default function App() {
  const initializedRef = useRef(false);
  const chessRef = useRef<Chess>(new Chess());
  const wsRef = useRef<WebSocket | null>(null);

  // Core Game State
  const [gameMode, setGameMode] = useState<GameMode>('ai');
  const [theme, setTheme] = useState<EnvTheme>('cathedral');
  const [fen, setFen] = useState(chessRef.current.fen());
  const [turn, setTurn] = useState<'w' | 'b'>('w');
  const [myColor, setMyColor] = useState<'w' | 'b' | 'spectator'>('w');
  const [isCheck, setIsCheck] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [gameResult, setGameResult] = useState<{ winner: string; reason: string } | null>(null);

  // Clocks
  const [whiteTime, setWhiteTime] = useState(600);
  const [blackTime, setBlackTime] = useState(600);
  const [isClockRunning, setIsClockRunning] = useState(false);

  // History & Evaluation
  const [moveHistory, setMoveHistory] = useState<Move[]>([]);
  const [evalScore, setEvalScore] = useState(0);
  const [aiDifficulty, setAiDifficulty] = useState<number>(3); // 1~5
  const [hintMove, setHintMove] = useState<{ san: string; score: number } | null>(null);

  // Captured pieces
  const [capturedState, setCapturedState] = useState<{
    whiteCaptured: string[];
    blackCaptured: string[];
    whiteAdvantage: number;
  }>({ whiteCaptured: [], blackCaptured: [], whiteAdvantage: 0 });

  // Pass & Play options
  const [autoRotateLocal, setAutoRotateLocal] = useState(true);

  // Online Multiplayer State
  const [onlineRooms, setOnlineRooms] = useState<RoomInfo[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState('3D 체스 대국');
  const [playerName, setPlayerName] = useState(() => '플레이어_' + Math.floor(1000 + Math.random() * 9000));
  const [opponentName, setOpponentName] = useState('상대방');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [drawOfferReceived, setDrawOfferReceived] = useState(false);
  const [rematchOfferStatus, setRematchOfferStatus] = useState({ me: false, opp: false });
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');

  // UI Modals & Panels
  const [showLobbyModal, setShowLobbyModal] = useState(false);
  const [lobbyTab, setLobbyTab] = useState<'ai' | 'create' | 'join' | 'local'>('ai');
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [networkUrl, setNetworkUrl] = useState('');
  const [showPromotionModal, setShowPromotionModal] = useState(false);
  const [pendingPromotionMove, setPendingPromotionMove] = useState<{ from: string; to: string } | null>(null);
  const [showChatDrawer, setShowChatDrawer] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Extended Settings State (Persisted in localStorage)
  const [autoHint, setAutoHint] = useState<boolean>(() => {
    const saved = localStorage.getItem('chess3d_auto_hint');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [hintAutoTts, setHintAutoTts] = useState<boolean>(() => {
    const saved = localStorage.getItem('chess3d_hint_auto_tts');
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [showLastMove, setShowLastMove] = useState<boolean>(() => {
    const saved = localStorage.getItem('chess3d_show_last_move');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [boardTileTheme, setBoardTileTheme] = useState<string>(() => {
    return localStorage.getItem('chess3d_board_tile') || 'gothic';
  });
  const [aiDelay, setAiDelay] = useState<number>(() => {
    const saved = localStorage.getItem('chess3d_ai_delay');
    return saved ? parseInt(saved, 10) : 500;
  });
  const [hintLimit, setHintLimit] = useState<number>(() => {
    const saved = localStorage.getItem('chess3d_hint_limit');
    return saved ? parseInt(saved, 10) : -1;
  });
  const [hintCountUsed, setHintCountUsed] = useState<number>(0);

  // Tactical Card State
  const [tacticalCard, setTacticalCard] = useState<{
    san: string;
    from: string;
    to: string;
    score: number;
    explanation: TacticalExplanation;
  } | null>(null);

  // Stable callback refs for Three.js engine callbacks
  const onUserMoveAttemptRef = useRef<any>(null);
  const onMoveCompletedRef = useRef<any>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  // Update evaluation and captured pieces
  const refreshBoardAnalysis = useCallback((chess: Chess) => {
    setFen(chess.fen());
    setTurn(chess.turn());
    setIsCheck(chess.inCheck());
    const score = evaluateBoard(chess);
    setEvalScore(score);
    const captured = computeCapturedPieces(chess);
    setCapturedState(captured);
    setMoveHistory(chess.history({ verbose: true }));
  }, []);

  // 1. Initialize 3D Engine
  // 1. Settings Persistence Effects
  useEffect(() => {
    localStorage.setItem('chess3d_auto_hint', JSON.stringify(autoHint));
  }, [autoHint]);

  useEffect(() => {
    localStorage.setItem('chess3d_hint_auto_tts', JSON.stringify(hintAutoTts));
  }, [hintAutoTts]);

  useEffect(() => {
    localStorage.setItem('chess3d_show_last_move', JSON.stringify(showLastMove));
    if (!showLastMove) {
      (window as any).wizardChess?.setLastMoveHighlight?.(null, null);
    }
  }, [showLastMove]);

  useEffect(() => {
    localStorage.setItem('chess3d_board_tile', boardTileTheme);
    (window as any).wizardChess?.setBoardTileTheme?.(boardTileTheme);
  }, [boardTileTheme]);

  useEffect(() => {
    localStorage.setItem('chess3d_ai_delay', aiDelay.toString());
  }, [aiDelay]);

  useEffect(() => {
    localStorage.setItem('chess3d_hint_limit', hintLimit.toString());
  }, [hintLimit]);

  // Compute and apply best move hint (Learning mode & manual)
  const computeAndApplyHint = useCallback((isAuto = false) => {
    if (chessRef.current.isGameOver()) return;
    const win = window as any;

    if (!isAuto && hintLimit !== -1 && hintCountUsed >= hintLimit) {
      showToast(`대국당 최선수 힌트(${hintLimit}회)를 모두 사용했습니다.`);
      return;
    }

    const searchDepth = Math.max(1, Math.min(4, aiDifficulty));
    const res = findBestMove(chessRef.current, searchDepth);
    if (!res.move) {
      if (!isAuto) showToast('추천 가능한 수가 없습니다.');
      return;
    }

    const tactical = generateTacticalExplanation(chessRef.current, res.move);
    setTacticalCard({
      san: res.move.san,
      from: res.move.from,
      to: res.move.to,
      score: res.score,
      explanation: tactical
    });

    win.wizardChess?.highlightHint?.(res.move.from, res.move.to);

    if (!isAuto) {
      setHintCountUsed(prev => prev + 1);
      showToast(`💡 최선수 추천: ${res.move.san} (${tactical.badge})`);
      speakKoreanText(tactical.speechSummary);
    } else if (hintAutoTts) {
      speakKoreanText(tactical.speechSummary);
    }
  }, [aiDifficulty, hintLimit, hintCountUsed, hintAutoTts, showToast]);

  // Check Game Over
  const checkAndAnnounceGameOver = useCallback(() => {
    const c = chessRef.current;
    if (!c.isGameOver()) return;

    let winner = 'draw';
    let reason = '대국 종료';

    if (c.isCheckmate()) {
      winner = c.turn() === 'w' ? 'b' : 'w';
      reason = '체크메이트 (Checkmate)';
      audio.playGameEnd(winner === myColor);
    } else if (c.isDraw()) {
      winner = 'draw';
      if (c.isStalemate()) reason = '스테일메이트 (무승부)';
      else if (c.isThreefoldRepetition()) reason = '3회 동형 반복 (무승부)';
      else if (c.isInsufficientMaterial()) reason = '기물 부족 (무승부)';
      else reason = '50수 규칙 (무승부)';
      audio.playGameEnd(false);
    }

    setGameOver(true);
    setGameResult({ winner, reason });
  }, [myColor]);

  // AI Move Execution
  const triggerAIMove = useCallback(() => {
    if (chessRef.current.isGameOver()) return;
    const win = window as any;

    setTimeout(() => {
      // Find best move using minimax engine
      const searchDepth = Math.max(1, Math.min(4, aiDifficulty));
      const result = findBestMove(chessRef.current, searchDepth);
      if (!result.move) return;

      const { from, to, promotion } = result.move;
      const executed = chessRef.current.move(result.move);
      if (!executed) return;

      // Animate 3D piece
      win.wizardChess?.makeMove(from, to, promotion || 'queen');

      if (showLastMove) {
        win.wizardChess?.setLastMoveHighlight?.(from, to);
      }

      // Sound
      if (executed.captured) audio.playCapture();
      else if (executed.flags.includes('k') || executed.flags.includes('q')) audio.playCastle();
      else audio.playMove();

      if (chessRef.current.inCheck()) audio.playCheck();

      refreshBoardAnalysis(chessRef.current);

      if (chessRef.current.isGameOver()) {
        checkAndAnnounceGameOver();
      }
    }, aiDelay);
  }, [aiDifficulty, aiDelay, showLastMove, refreshBoardAnalysis, checkAndAnnounceGameOver]);

  // Keep callback refs fresh
  onUserMoveAttemptRef.current = (moveAttempt: any) => {
    const { from, to, isPromotion } = moveAttempt;

    // Turn check
    if (chessRef.current.isGameOver()) return false;
    if (gameMode === 'online') {
      if (myColor !== chessRef.current.turn()) {
        showToast('상대방의 턴입니다.');
        return false;
      }
    } else if (gameMode === 'ai') {
      if (myColor !== chessRef.current.turn()) {
        showToast('AI 연산 중입니다.');
        return false;
      }
    }

    // If pawn promotion needed, show modal
    if (isPromotion) {
      setPendingPromotionMove({ from, to });
      setShowPromotionModal(true);
      return false; // Pause 3D move until promotion piece selected
    }

    // Validate chess move with chess.js
    try {
      const move = chessRef.current.move({ from, to, promotion: 'q' });
      if (!move) return false;

      const win = window as any;
      win.wizardChess?.clearHighlights?.();
      setTacticalCard(null);

      // Play Sound
      if (move.captured) audio.playCapture();
      else if (move.flags.includes('k') || move.flags.includes('q')) audio.playCastle();
      else audio.playMove();

      if (chessRef.current.inCheck()) audio.playCheck();

      refreshBoardAnalysis(chessRef.current);

      if (showLastMove) {
        win.wizardChess?.setLastMoveHighlight?.(from, to);
      }

      // If Online, broadcast move
      if (gameMode === 'online' && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'make_move',
          from,
          to,
          promotion: 'q'
        }));
      }

      // If Local 2P and auto-rotate enabled
      if (gameMode === 'local' && autoRotateLocal) {
        win.wizardChess?.setBoardOrientation?.(chessRef.current.turn());
      }

      if (chessRef.current.isGameOver()) {
        checkAndAnnounceGameOver();
      }

      return true;
    } catch (e) {
      return false;
    }
  };

  onMoveCompletedRef.current = (completed: any) => {
    const win = window as any;
    if (showLastMove && completed?.from && completed?.to) {
      win.wizardChess?.setLastMoveHighlight?.(completed.from, completed.to);
    }

    if (chessRef.current.isGameOver()) {
      checkAndAnnounceGameOver();
      return;
    }

    // Trigger AI response if in AI mode and it's AI turn
    if (gameMode === 'ai') {
      const aiColor = myColor === 'w' ? 'b' : 'w';
      if (chessRef.current.turn() === aiColor) {
        triggerAIMove();
      } else if (chessRef.current.turn() === myColor) {
        // Player's turn: If autoHint is enabled, analyze best move
        if (autoHint) {
          setTimeout(() => {
            computeAndApplyHint(true);
          }, 150);
        }
      }
    }
  };

  // 1. Initialize 3D Engine
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    initWizardChess();

    const win = window as any;
    if (win.wizardChess) {
      win.wizardChess.setBoardTileTheme?.(boardTileTheme);
      win.wizardChess.setOnUserMoveAttempt((moveAttempt: any) => {
        return onUserMoveAttemptRef.current ? onUserMoveAttemptRef.current(moveAttempt) : false;
      });
      win.wizardChess.setOnMoveCompleted((completed: any) => {
        onMoveCompletedRef.current?.(completed);
      });
    }

    // Fetch Network Info & QR Code
    fetch('/chess3d/api/info')
      .then(res => res.json())
      .then(data => {
        if (data.qrCode) setQrCodeUrl(data.qrCode);
        if (data.primaryUrl) setNetworkUrl(data.primaryUrl);
      })
      .catch(() => {});
  }, []);

  // Trigger auto-hint when toggled or turn changes
  useEffect(() => {
    if (gameMode === 'ai' && !chessRef.current.isGameOver() && chessRef.current.turn() === myColor) {
      if (autoHint) {
        const timer = setTimeout(() => computeAndApplyHint(true), 200);
        return () => clearTimeout(timer);
      } else {
        setTacticalCard(null);
        (window as any).wizardChess?.clearHighlights?.();
      }
    }
  }, [autoHint, turn, gameMode, myColor, computeAndApplyHint]);

  // Handle Theme Switching
  const handleThemeChange = (newTheme: EnvTheme) => {
    setTheme(newTheme);
    const win = window as any;
    if (win.wizardChess?.setTheme) {
      win.wizardChess.setTheme(newTheme);
    }
    showToast(`테마 변경: ${newTheme === 'cathedral' ? '중세 대성당' : newTheme === 'bluesky' ? '푸른 하늘' : newTheme === 'cosmic' ? '우주 성운' : '스튜디오'}`);
  };

  // AI Hint Action (Manual)
  const handleShowHint = () => {
    computeAndApplyHint(false);
  };

  // Undo Move Action
  const handleUndoMove = () => {
    if (gameMode === 'online') {
      showToast('온라인 대국에서는 수를 물릴 수 없습니다.');
      return;
    }
    if (moveHistory.length === 0) return;

    const win = window as any;
    // In AI mode, undo 2 moves (AI move + player move)
    if (gameMode === 'ai') {
      chessRef.current.undo();
      chessRef.current.undo();
    } else {
      chessRef.current.undo();
    }

    refreshBoardAnalysis(chessRef.current);
    win.wizardChess?.resetBoard?.();
    win.wizardChess?.clearHighlights?.();
    setTacticalCard(null);

    // Replay remaining history on 3D board
    const moves = chessRef.current.history({ verbose: true });
    for (const m of moves) {
      win.wizardChess?.makeMove(m.from, m.to, m.promotion || 'queen');
    }
    if (moves.length > 0 && showLastMove) {
      const last = moves[moves.length - 1];
      win.wizardChess?.setLastMoveHighlight?.(last.from, last.to);
    } else {
      win.wizardChess?.setLastMoveHighlight?.(null, null);
    }

    if (gameMode === 'ai' && autoHint && chessRef.current.turn() === myColor) {
      setTimeout(() => computeAndApplyHint(true), 150);
    }
    showToast('수를 물렸습니다.');
  };

  // Pawn Promotion Choice
  const handlePromotionSelect = (piece: 'q' | 'r' | 'b' | 'n') => {
    setShowPromotionModal(false);
    if (!pendingPromotionMove) return;

    const { from, to } = pendingPromotionMove;
    const pieceMap: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

    try {
      const move = chessRef.current.move({ from, to, promotion: piece });
      if (move) {
        const win = window as any;
        win.wizardChess?.makeMove(from, to, pieceMap[piece]);

        if (move.captured) audio.playCapture();
        else audio.playMove();

        refreshBoardAnalysis(chessRef.current);

        if (gameMode === 'online' && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'make_move',
            from,
            to,
            promotion: piece
          }));
        }
      }
    } catch (e) {}

    setPendingPromotionMove(null);
  };

  // Connect WebSocket for Online Play
  const connectWebSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const ws = new WebSocket(`${protocol}//${host}/chess3d/`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'list_rooms' }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'room_list') {
          setOnlineRooms(data.rooms || []);
        } else if (data.type === 'room_created') {
          setCurrentRoomId(data.roomId);
          setMyColor(data.yourRole);
          setShowLobbyModal(false);
          showToast(`방 [${data.roomId}] 개설 완료! 상대방 입장을 기다립니다.`);
        } else if (data.type === 'room_joined') {
          setCurrentRoomId(data.roomId);
          setMyColor(data.yourRole);
          setShowLobbyModal(false);
          showToast(`방 [${data.roomId}] 참여 성공!`);
        } else if (data.type === 'room_state') {
          // Sync board state
          const newChess = new Chess();
          if (data.history && data.history.length > 0) {
            for (const h of data.history) {
              newChess.move(h);
            }
          }
          chessRef.current = newChess;
          refreshBoardAnalysis(newChess);

          // Clocks
          if (data.white) {
            setWhiteTime(data.white.timeLeft);
            if (myColor === 'b') setOpponentName(data.white.name);
          }
          if (data.black) {
            setBlackTime(data.black.timeLeft);
            if (myColor === 'w') setOpponentName(data.black.name);
          }

          if (data.drawOffer && data.drawOffer !== myColor) {
            setDrawOfferReceived(true);
          } else {
            setDrawOfferReceived(false);
          }

          if (data.isGameOver) {
            setGameOver(true);
            setGameResult({
              winner: data.winner || 'draw',
              reason: data.endReason || '대국 종료'
            });
          }
        } else if (data.type === 'clock_tick') {
          setWhiteTime(data.whiteTime);
          setBlackTime(data.blackTime);
        } else if (data.type === 'chat_broadcast') {
          setChatMessages(prev => [...prev.slice(-49), data]);
          audio.playNotify();
        } else if (data.type === 'toast') {
          showToast(data.message);
        } else if (data.type === 'error') {
          showToast(data.message || '오류가 발생했습니다.');
        }
      } catch (err) {}
    };

    ws.onclose = () => {
      wsRef.current = null;
    };

    wsRef.current = ws;
  }, [myColor, refreshBoardAnalysis, showToast]);

  // Create Online Room
  const handleCreateRoom = (timeMinutes: number, preferredColor: string) => {
    connectWebSocket();
    setTimeout(() => {
      wsRef.current?.send(JSON.stringify({
        type: 'create_room',
        roomName,
        playerName,
        timeMinutes,
        incrementSeconds: 0,
        preferredColor
      }));
    }, 200);
  };

  // Join Online Room
  const handleJoinRoom = (roomId: string) => {
    connectWebSocket();
    setTimeout(() => {
      wsRef.current?.send(JSON.stringify({
        type: 'join_room',
        roomId,
        playerName
      }));
    }, 200);
  };

  // Resign Action
  const handleResign = () => {
    if (gameMode === 'online') {
      wsRef.current?.send(JSON.stringify({ type: 'resign' }));
    } else {
      setGameOver(true);
      setGameResult({
        winner: myColor === 'w' ? 'b' : 'w',
        reason: '기권패'
      });
      audio.playGameEnd(false);
    }
  };

  // Draw Offer Action
  const handleOfferDraw = () => {
    if (gameMode === 'online') {
      wsRef.current?.send(JSON.stringify({ type: 'offer_draw' }));
      showToast('상대방에게 무승부를 제안했습니다.');
    } else {
      showToast('AI 모드에서는 무승부 제안이 지원되지 않습니다.');
    }
  };

  const handleRespondDraw = (accept: boolean) => {
    setDrawOfferReceived(false);
    if (gameMode === 'online') {
      wsRef.current?.send(JSON.stringify({ type: 'respond_draw', accept }));
    }
  };

  // Rematch Request
  const handleRequestRematch = () => {
    if (gameMode === 'online') {
      wsRef.current?.send(JSON.stringify({ type: 'request_rematch' }));
      showToast('재대국을 요청했습니다.');
    } else {
      handleNewGame();
    }
  };

  // New Game Action
  const handleNewGame = () => {
    chessRef.current = new Chess();
    setGameOver(false);
    setGameResult(null);
    setHintMove(null);
    setTacticalCard(null);
    setHintCountUsed(0);
    refreshBoardAnalysis(chessRef.current);

    const win = window as any;
    win.wizardChess?.resetBoard?.();
    win.wizardChess?.clearHighlights?.();
    win.wizardChess?.setLastMoveHighlight?.(null, null);
    audio.playGameStart();
    showToast('새 게임이 시작되었습니다.');

    if (gameMode === 'ai' && autoHint && myColor === 'w') {
      setTimeout(() => computeAndApplyHint(true), 250);
    }
  };

  // Send Chat Message
  const handleSendChat = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim()) return;

    if (gameMode === 'online' && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat_message',
        text: chatInput.trim()
      }));
      setChatInput('');
    } else {
      showToast('온라인 대국 중에만 채팅이 가능합니다.');
    }
  };

  const handleSendEmoji = (emoji: string) => {
    if (gameMode === 'online' && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat_message',
        emoji
      }));
    }
  };

  // Copy PGN & FEN
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    showToast(`${label} 클립보드에 복사 완료!`);
  };

  // Format Timer
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const evalPercent = Math.min(95, Math.max(5, 50 + (evalScore / 20)));

  return (
    <>
      {/* Three.js 3D Viewport Canvas */}
      <div id="canvas-container"></div>

      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="hud-toast-banner" role="alert">
          {toastMessage}
        </div>
      )}

      {/* Top Glassmorphism Navigation Bar */}
      <header className="hud-top-bar">
        <div className="hud-top-left">
          <div className="brand-badge" onClick={() => setShowLobbyModal(true)}>
            <span className="brand-icon">♟️</span>
            <div className="brand-meta">
              <span className="brand-name">CHESS 3D</span>
              <span className="brand-mode-tag">
                {gameMode === 'online' ? `🌐 온라인 (방 ${currentRoomId || '대기'})` : gameMode === 'ai' ? `🤖 AI 훈련 (Lv.${aiDifficulty})` : '👥 로컬 2P'}
              </span>
            </div>
          </div>

          <div className={`turn-indicator ${turn === 'w' ? 'turn-white' : 'turn-black'}`}>
            <span className="turn-pulse"></span>
            <span className="turn-label">
              {turn === 'w' ? '백(White) 차례' : '흑(Black) 차례'}
              {isCheck && <strong className="check-alert"> · CHECK!</strong>}
            </span>
          </div>

          <button
            type="button"
            className={`quick-chip-btn ${autoHint ? 'active-learning' : ''}`}
            onClick={() => {
              const next = !autoHint;
              setAutoHint(next);
              showToast(next ? '🎓 배움모드 (최선수 항상 분석) 켜짐' : '🎓 배움모드 꺼짐');
            }}
            title="혼자 AI 대국 시 내 차례마다 최선수와 전술 이유를 자동 분석하고 표시합니다."
          >
            <span className="chip-icon">🎓</span>
            <span className="chip-text">배움모드 {autoHint ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        {/* Center: Environment Theme Switcher */}
        <div className="hud-top-center">
          <div className="theme-selector-group">
            <span className="theme-label">배경 테마:</span>
            <button
              type="button"
              className={`theme-chip ${theme === 'cathedral' ? 'active' : ''}`}
              onClick={() => handleThemeChange('cathedral')}
              title="중세 고딕 대성당과 타오르는 화로"
            >
              🏰 중세 성당
            </button>
            <button
              type="button"
              className={`theme-chip ${theme === 'bluesky' ? 'active' : ''}`}
              onClick={() => handleThemeChange('bluesky')}
              title="화창한 푸른 하늘과 맑은 자연광"
            >
              🌤️ 푸른 하늘
            </button>
            <button
              type="button"
              className={`theme-chip ${theme === 'cosmic' ? 'active' : ''}`}
              onClick={() => handleThemeChange('cosmic')}
              title="신비로운 밤하늘 은하수와 별무리"
            >
              🌌 우주 성운
            </button>
            <button
              type="button"
              className={`theme-chip ${theme === 'studio' ? 'active' : ''}`}
              onClick={() => handleThemeChange('studio')}
              title="정갈하고 모던한 미니멀 다크 스튜디오"
            >
              🏛️ 스튜디오
            </button>
          </div>
        </div>

        {/* Top Right: Quick Actions & Tools */}
        <div className="hud-top-right">
          <button
            type="button"
            className="hud-action-btn"
            onClick={() => setShowLobbyModal(true)}
            title="대전 모드 변경 / 온라인 방 만들기 및 참여"
          >
            🎮 모드 / 로비
          </button>

          <button
            type="button"
            className="hud-action-btn"
            onClick={() => setShowQrModal(true)}
            title="스마트폰 접속용 WiFi QR 코드"
          >
            📱 QR 참여
          </button>

          {gameMode === 'online' && (
            <button
              type="button"
              className="hud-action-btn"
              onClick={() => setShowChatDrawer(prev => !prev)}
              title="채팅 및 이모티콘"
            >
              💬 채팅
            </button>
          )}

          <button
            type="button"
            className="hud-action-btn icon-only"
            onClick={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              audio.enabled = next;
              showToast(next ? '효과음 켜짐 🔊' : '효과음 꺼짐 🔇');
            }}
            title={soundEnabled ? '효과음 끄기' : '효과음 켜기'}
          >
            {soundEnabled ? '🔊' : '🔇'}
          </button>

          <button
            type="button"
            className="hud-action-btn"
            onClick={() => setShowSettingsModal(true)}
            title="게임 환경 설정 (배움모드, TTS, 체스판 타일, AI 속도 등)"
          >
            ⚙️ 설정
          </button>
        </div>
      </header>

      {/* Real-time Evaluation Bar (AI / Training mode) */}
      <div className="hud-eval-container" title={`형세 평가: ${(evalScore / 100).toFixed(1)}`}>
        <div className="hud-eval-bar">
          <div className="hud-eval-fill" style={{ height: `${evalPercent}%` }}></div>
          <span className="hud-eval-text">
            {evalScore >= 0 ? `+${(evalScore / 100).toFixed(1)}` : (evalScore / 100).toFixed(1)}
          </span>
        </div>
      </div>

      {/* Left Player HUD: Opponent & User Clocks + Captured Pieces */}
      <div className="hud-players-panel">
        {/* Opponent Card */}
        <div className="player-card opponent-card">
          <div className="player-avatar">
            {gameMode === 'ai' ? '🤖' : '👤'}
          </div>
          <div className="player-info">
            <span className="player-title">{gameMode === 'ai' ? `Chess AI (Lv.${aiDifficulty})` : opponentName}</span>
            <div className="captured-tray">
              {capturedState.blackCaptured.map((p, i) => (
                <span key={i} className="captured-piece" title={p}>
                  {p === 'p' ? '♟' : p === 'n' ? '♞' : p === 'b' ? '♝' : p === 'r' ? '♜' : '♛'}
                </span>
              ))}
              {capturedState.whiteAdvantage < 0 && (
                <span className="advantage-score">+{Math.abs(capturedState.whiteAdvantage)}</span>
              )}
            </div>
          </div>
          <div className={`player-timer ${turn === 'b' ? 'active-timer' : ''}`}>
            {formatTime(blackTime)}
          </div>
        </div>

        {/* User Card */}
        <div className="player-card user-card">
          <div className="player-avatar">👤</div>
          <div className="player-info">
            <span className="player-title">{playerName} (당신)</span>
            <div className="captured-tray">
              {capturedState.whiteCaptured.map((p, i) => (
                <span key={i} className="captured-piece" title={p}>
                  {p === 'p' ? '♙' : p === 'n' ? '♘' : p === 'b' ? '♗' : p === 'r' ? '♖' : '♕'}
                </span>
              ))}
              {capturedState.whiteAdvantage > 0 && (
                <span className="advantage-score">+{capturedState.whiteAdvantage}</span>
              )}
            </div>
          </div>
          <div className={`player-timer ${turn === 'w' ? 'active-timer' : ''}`}>
            {formatTime(whiteTime)}
          </div>
        </div>
      </div>

      {/* Right Drawer: Game History & Tools */}
      <div className="hud-moves-panel">
        <div className="panel-header">
          <span className="panel-title">📜 기보 / 수순 목록</span>
          <div className="panel-tools">
            <button
              type="button"
              className="mini-tool-btn"
              onClick={() => copyToClipboard(chessRef.current.pgn(), 'PGN')}
              title="PGN 기보 복사"
            >
              PGN
            </button>
            <button
              type="button"
              className="mini-tool-btn"
              onClick={() => copyToClipboard(chessRef.current.fen(), 'FEN')}
              title="FEN 위치 복사"
            >
              FEN
            </button>
          </div>
        </div>

        {/* Move Notation List */}
        <div className="move-list-scroll">
          {moveHistory.length === 0 ? (
            <div className="empty-moves">대국이 시작되면 수순이 기록됩니다.</div>
          ) : (
            <table className="move-table">
              <tbody>
                {Array.from({ length: Math.ceil(moveHistory.length / 2) }).map((_, idx) => {
                  const wMove = moveHistory[idx * 2];
                  const bMove = moveHistory[idx * 2 + 1];
                  return (
                    <tr key={idx}>
                      <td className="move-index">{idx + 1}.</td>
                      <td className="move-san white-move">{wMove?.san}</td>
                      <td className="move-san black-move">{bMove?.san || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Tactical In-game Action Buttons */}
        <div className="panel-actions">
          {gameMode !== 'online' && (
            <>
              <button
                type="button"
                className="action-pill hint-pill-btn"
                onClick={handleShowHint}
                title="AI 최선수 힌트 받기"
              >
                💡 최선수 힌트 {hintLimit !== -1 ? `(${Math.max(0, hintLimit - hintCountUsed)}회)` : ''}
              </button>
              <button
                type="button"
                className="action-pill undo-pill-btn"
                onClick={handleUndoMove}
                title="방금 둔 수 물리기"
              >
                ↩️ 수 물리기
              </button>
            </>
          )}

          <button
            type="button"
            className="action-pill draw-pill-btn"
            onClick={handleOfferDraw}
            title="무승부 제안"
          >
            🤝 무승부 제안
          </button>

          <button
            type="button"
            className="action-pill resign-pill-btn"
            onClick={handleResign}
            title="대국 기권하기"
          >
            🏳️ 기권하기
          </button>
        </div>
      </div>

      {/* Dynamic Tactical Explanation Card (배움모드 & 최선수 전술 카드) */}
      {tacticalCard && (
        <div className="tactical-floating-card">
          <div className="tactical-card-header">
            <div className="tactical-badge-group">
              <span className={`tactical-badge ${tacticalCard.explanation.badgeClass}`}>
                {tacticalCard.explanation.badge}
              </span>
              <span className="tactical-move-san">
                추천 수: <strong>{tacticalCard.san}</strong>
              </span>
              <span className="tactical-eval-score">
                평가 {tacticalCard.score >= 0 ? `+${(tacticalCard.score / 100).toFixed(1)}` : (tacticalCard.score / 100).toFixed(1)}
              </span>
            </div>
            <button
              type="button"
              className="tactical-close-btn"
              onClick={() => setTacticalCard(null)}
              title="해설 카드 닫기"
            >
              ✕
            </button>
          </div>
          <p className="tactical-card-body">{tacticalCard.explanation.explanation}</p>
          <div className="tactical-card-footer">
            <button
              type="button"
              className="tactical-voice-btn"
              onClick={() => speakKoreanText(tacticalCard.explanation.speechSummary)}
              title="한국어 음성(TTS)으로 전술 해설 듣기"
            >
              🔊 음성 듣기
            </button>
            <button
              type="button"
              className="tactical-replay-btn"
              onClick={() => (window as any).wizardChess?.highlightHint?.(tacticalCard.from, tacticalCard.to)}
              title="3D 체스판 칸 다시 강조"
            >
              ✨ 3D 칸 보기
            </button>
          </div>
        </div>
      )}

      {/* Floating Bottom Camera & View Switcher */}
      <div className="hud-bottom-camera-bar">
        <button
          type="button"
          className="cam-pill active"
          onClick={() => (window as any).wizardChess?.setCameraPreset('player')}
        >
          👁️ 플레이어 뷰
        </button>
        <button
          type="button"
          className="cam-pill"
          onClick={() => (window as any).wizardChess?.setCameraPreset('top')}
        >
          📐 탑뷰(탑다운)
        </button>
        <button
          type="button"
          className="cam-pill"
          onClick={() => (window as any).wizardChess?.setCameraPreset('side')}
        >
          ↔️ 사이드 뷰
        </button>
        <button
          type="button"
          className="cam-pill"
          onClick={() => (window as any).wizardChess?.setCameraPreset('wide')}
        >
          🏰 와이드 전경
        </button>
        <button
          type="button"
          className="cam-pill"
          onClick={() => {
            const nextSide = myColor === 'w' ? 'b' : 'w';
            setMyColor(nextSide);
            (window as any).wizardChess?.setBoardOrientation(nextSide);
          }}
        >
          🔄 180° 회전
        </button>
      </div>

      {/* MODAL 1: Game Mode & Online Lobby */}
      {showLobbyModal && (
        <div className="modal-backdrop" onClick={() => setShowLobbyModal(false)}>
          <div className="modal-window lobby-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">⚔️ 대국 모드 &amp; 온라인 로비</span>
              <button type="button" className="modal-close" onClick={() => setShowLobbyModal(false)}>✕</button>
            </div>

            <div className="modal-tab-bar">
              <button
                type="button"
                className={`tab-btn ${lobbyTab === 'ai' ? 'active' : ''}`}
                onClick={() => setLobbyTab('ai')}
              >
                🤖 AI 훈련
              </button>
              <button
                type="button"
                className={`tab-btn ${lobbyTab === 'create' ? 'active' : ''}`}
                onClick={() => {
                  setLobbyTab('create');
                  connectWebSocket();
                }}
              >
                🌐 방 만들기
              </button>
              <button
                type="button"
                className={`tab-btn ${lobbyTab === 'join' ? 'active' : ''}`}
                onClick={() => {
                  setLobbyTab('join');
                  connectWebSocket();
                }}
              >
                🚪 방 참여하기
              </button>
              <button
                type="button"
                className={`tab-btn ${lobbyTab === 'local' ? 'active' : ''}`}
                onClick={() => setLobbyTab('local')}
              >
                👥 로컬 2인
              </button>
            </div>

            <div className="modal-body">
              {/* Tab 1: AI Training Mode */}
              {lobbyTab === 'ai' && (
                <div className="tab-pane">
                  <div className="form-group">
                    <label>AI 난이도 선택:</label>
                    <div className="level-buttons">
                      {[1, 2, 3, 4, 5].map(lvl => (
                        <button
                          key={lvl}
                          type="button"
                          className={`level-btn ${aiDifficulty === lvl ? 'active' : ''}`}
                          onClick={() => setAiDifficulty(lvl)}
                        >
                          Lv.{lvl} {lvl === 1 ? '(입문)' : lvl === 3 ? '(중급)' : lvl === 5 ? '(마스터)' : ''}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="form-group">
                    <label>진영(Color) 선택:</label>
                    <div className="color-buttons">
                      <button
                        type="button"
                        className={`color-btn ${myColor === 'w' ? 'active' : ''}`}
                        onClick={() => {
                          setMyColor('w');
                          (window as any).wizardChess?.setBoardOrientation('w');
                        }}
                      >
                        ⚪ 백 (선공)
                      </button>
                      <button
                        type="button"
                        className={`color-btn ${myColor === 'b' ? 'active' : ''}`}
                        onClick={() => {
                          setMyColor('b');
                          (window as any).wizardChess?.setBoardOrientation('b');
                        }}
                      >
                        ⚫ 흑 (후공)
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="modal-action-btn primary"
                    onClick={() => {
                      setGameMode('ai');
                      handleNewGame();
                      setShowLobbyModal(false);
                      showToast(`AI 난이도 Lv.${aiDifficulty} 대국 시작!`);
                    }}
                  >
                    🚀 AI와 대국 시작하기
                  </button>
                </div>
              )}

              {/* Tab 2: Create Online Room */}
              {lobbyTab === 'create' && (
                <div className="tab-pane">
                  <div className="form-group">
                    <label>내 닉네임:</label>
                    <input
                      type="text"
                      className="input-text"
                      value={playerName}
                      onChange={e => setPlayerName(e.target.value)}
                      maxLength={12}
                    />
                  </div>

                  <div className="form-group">
                    <label>방 이름:</label>
                    <input
                      type="text"
                      className="input-text"
                      value={roomName}
                      onChange={e => setRoomName(e.target.value)}
                      maxLength={24}
                    />
                  </div>

                  <div className="form-group">
                    <label>제한 시간:</label>
                    <div className="time-chips">
                      {[3, 5, 10, 15].map(m => (
                        <button
                          key={m}
                          type="button"
                          className="time-chip-btn"
                          onClick={() => {
                            setGameMode('online');
                            handleCreateRoom(m, 'random');
                          }}
                        >
                          ⏱️ {m}분 대국
                        </button>
                      ))}
                      <button
                        type="button"
                        className="time-chip-btn"
                        onClick={() => {
                          setGameMode('online');
                          handleCreateRoom(0, 'random');
                        }}
                      >
                        ♾️ 무제한
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Join Online Room */}
              {lobbyTab === 'join' && (
                <div className="tab-pane">
                  <div className="form-group">
                    <label>4자리 방 코드 입력:</label>
                    <div className="join-code-row">
                      <input
                        type="text"
                        className="input-text code-input"
                        placeholder="예: 4A7B"
                        maxLength={4}
                        value={joinCodeInput}
                        onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                      />
                      <button
                        type="button"
                        className="modal-action-btn primary"
                        disabled={joinCodeInput.length < 4}
                        onClick={() => {
                          setGameMode('online');
                          handleJoinRoom(joinCodeInput);
                        }}
                      >
                        참여
                      </button>
                    </div>
                  </div>

                  <div className="room-list-section">
                    <div className="room-list-header">
                      <span>실시간 열린 방 목록 ({onlineRooms.length})</span>
                      <button
                        type="button"
                        className="refresh-btn"
                        onClick={() => wsRef.current?.send(JSON.stringify({ type: 'list_rooms' }))}
                      >
                        🔄 새로고침
                      </button>
                    </div>

                    <div className="rooms-scroll">
                      {onlineRooms.length === 0 ? (
                        <div className="empty-rooms">현재 대기 중인 공개 방이 없습니다.</div>
                      ) : (
                        onlineRooms.map(r => (
                          <div key={r.id} className="room-card">
                            <div className="room-meta">
                              <span className="room-code">[{r.id}]</span>
                              <span className="room-title">{r.name}</span>
                              <span className="room-host">방장: {r.host}</span>
                            </div>
                            <button
                              type="button"
                              className="join-card-btn"
                              onClick={() => {
                                setGameMode('online');
                                handleJoinRoom(r.id);
                              }}
                            >
                              입장 ({r.players}/2)
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 4: Local Pass & Play */}
              {lobbyTab === 'local' && (
                <div className="tab-pane">
                  <p className="tab-desc">한 기기(PC/태블릿)에서 두 사람이 번갈아 두는 오프라인 대국 모드입니다.</p>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={autoRotateLocal}
                      onChange={e => setAutoRotateLocal(e.target.checked)}
                    />
                    <span>수를 둘 때마다 체스판 시점 180도 자동 회전</span>
                  </label>
                  <button
                    type="button"
                    className="modal-action-btn primary"
                    onClick={() => {
                      setGameMode('local');
                      handleNewGame();
                      setShowLobbyModal(false);
                      showToast('로컬 2인 대전 시작!');
                    }}
                  >
                    🚀 로컬 2인 대국 시작
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: QR Code Connect */}
      {showQrModal && (
        <div className="modal-backdrop" onClick={() => setShowQrModal(false)}>
          <div className="modal-window qr-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">📱 스마트폰 빠른 접속 QR</span>
              <button type="button" className="modal-close" onClick={() => setShowQrModal(false)}>✕</button>
            </div>
            <div className="modal-body text-center">
              <p className="qr-hint">동일 WiFi에 연결된 스마트폰 카메라로 QR 코드를 스캔하세요.</p>
              {qrCodeUrl ? (
                <img src={qrCodeUrl} alt="Connect QR" className="qr-image" />
              ) : (
                <div className="qr-loading">QR 코드 생성 중...</div>
              )}
              <div className="url-copy-box">
                <input type="text" readOnly value={networkUrl} className="input-text readonly" />
                <button
                  type="button"
                  className="modal-action-btn secondary"
                  onClick={() => copyToClipboard(networkUrl, '접속 주소')}
                >
                  복사
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: Pawn Promotion Choice */}
      {showPromotionModal && (
        <div className="modal-backdrop">
          <div className="modal-window promo-modal">
            <div className="modal-header">
              <span className="modal-title">👑 폰 승급 (Pawn Promotion)</span>
            </div>
            <div className="modal-body">
              <p className="promo-desc">승급할 기물을 선택하십시오:</p>
              <div className="promo-choices">
                <button type="button" className="promo-choice-btn" onClick={() => handlePromotionSelect('q')}>
                  <span className="promo-icon">♛</span>
                  <span className="promo-name">퀸 (Queen)</span>
                </button>
                <button type="button" className="promo-choice-btn" onClick={() => handlePromotionSelect('r')}>
                  <span className="promo-icon">♜</span>
                  <span className="promo-name">룩 (Rook)</span>
                </button>
                <button type="button" className="promo-choice-btn" onClick={() => handlePromotionSelect('b')}>
                  <span className="promo-icon">♝</span>
                  <span className="promo-name">비숍 (Bishop)</span>
                </button>
                <button type="button" className="promo-choice-btn" onClick={() => handlePromotionSelect('n')}>
                  <span className="promo-icon">♞</span>
                  <span className="promo-name">나이트 (Knight)</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: Draw Offer Alert */}
      {drawOfferReceived && (
        <div className="modal-backdrop">
          <div className="modal-window draw-offer-modal">
            <div className="modal-header">
              <span className="modal-title">🤝 무승부 제안</span>
            </div>
            <div className="modal-body text-center">
              <p>상대방이 무승부를 제안하였습니다. 수락하시겠습니까?</p>
              <div className="draw-buttons">
                <button
                  type="button"
                  className="modal-action-btn primary"
                  onClick={() => handleRespondDraw(true)}
                >
                  수락 (무승부)
                </button>
                <button
                  type="button"
                  className="modal-action-btn secondary"
                  onClick={() => handleRespondDraw(false)}
                >
                  거절 (계속 두기)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 5: Game Over Banner */}
      {gameOver && gameResult && (
        <div className="modal-backdrop">
          <div className="modal-window game-over-modal">
            <div className="modal-header">
              <span className="modal-title">🏆 대국 종료</span>
            </div>
            <div className="modal-body text-center">
              <div className="game-over-icon">
                {gameResult.winner === 'draw' ? '🤝' : gameResult.winner === myColor ? '👑' : '💀'}
              </div>
              <h2 className="game-over-headline">
                {gameResult.winner === 'draw' ? '무승부 (Draw)' : gameResult.winner === myColor ? '승리하였습니다!' : '패배하였습니다'}
              </h2>
              <p className="game-over-reason">{gameResult.reason}</p>

              <div className="game-over-actions">
                <button
                  type="button"
                  className="modal-action-btn primary"
                  onClick={handleRequestRematch}
                >
                  🔄 재대국 신청
                </button>
                <button
                  type="button"
                  className="modal-action-btn secondary"
                  onClick={() => {
                    setGameOver(false);
                    setShowLobbyModal(true);
                  }}
                >
                  🎮 대전 로비로 이동
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* In-game Chat Drawer */}
      {showChatDrawer && (
        <div className="chat-drawer">
          <div className="chat-header">
            <span>💬 대국 채팅</span>
            <button type="button" className="mini-close" onClick={() => setShowChatDrawer(false)}>✕</button>
          </div>
          <div className="chat-messages">
            {chatMessages.map((msg, i) => (
              <div key={i} className="chat-bubble">
                <span className="chat-sender">{msg.sender}:</span>
                <span className="chat-text">{msg.text || msg.emoji}</span>
              </div>
            ))}
          </div>
          <div className="chat-emojis">
            {['👋', '👍', '🔥', '👏', '🤔', '😭', '✨', '⚡'].map(em => (
              <button key={em} type="button" className="emoji-btn" onClick={() => handleSendEmoji(em)}>
                {em}
              </button>
            ))}
          </div>
          <form className="chat-input-row" onSubmit={handleSendChat}>
            <input
              type="text"
              placeholder="메시지 입력..."
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              className="chat-text-input"
            />
            <button type="submit" className="chat-send-btn">전송</button>
          </form>
        </div>
      )}

      {/* MODAL 6: Game Settings Modal (게임 환경 및 AI 정밀 설정) */}
      {showSettingsModal && (
        <div className="modal-backdrop" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-window settings-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <span className="modal-title">⚙️ 게임 환경 및 AI 정밀 설정</span>
                <span className="modal-subtitle">배움모드(최선수 항상 분석), 음성 안내, 체스판 테마 등 상세 옵션</span>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowSettingsModal(false)}>✕</button>
            </div>

            <div className="modal-body settings-body">
              {/* Section 1: Learning Mode & AI Best Move */}
              <div className="settings-section">
                <div className="settings-section-title">
                  <span>🎓 배움모드 &amp; AI 최선수 보조</span>
                </div>

                {/* 1. Auto Hint (Learning Mode) */}
                <div className="setting-row">
                  <div className="setting-info">
                    <span className="setting-label">🎓 혼자 AI 대국 시 최선수 항상 체크 (배움모드)</span>
                    <span className="setting-desc">
                      내가 둘 차례마다 AI가 최선수를 자동 분석하여 3D 체스판 하이라이트와 전술 카드를 즉시 띄워줍니다.
                    </span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={autoHint}
                      onChange={e => {
                        const val = e.target.checked;
                        setAutoHint(val);
                        showToast(val ? '🎓 배움모드 켜짐' : '🎓 배움모드 꺼짐');
                      }}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {/* 2. TTS Voice */}
                <div className="setting-row">
                  <div className="setting-info">
                    <span className="setting-label">🔊 최선수 한국어 음성(TTS) 자동 읽기</span>
                    <span className="setting-desc">
                      추천 수가 표시될 때 공격수, 방어수, 체크메이트 등 전술적 이유를 한국어 음성으로 실시간 읽어줍니다.
                    </span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={hintAutoTts}
                      onChange={e => {
                        const val = e.target.checked;
                        setHintAutoTts(val);
                        showToast(val ? '🔊 최선수 한국어 음성 안내 켜짐' : '🔊 한국어 음성 안내 꺼짐');
                      }}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {/* 3. Hint Limit */}
                <div className="setting-row stacked">
                  <div className="setting-info">
                    <span className="setting-label">💡 대국당 최선수 힌트 횟수 제한</span>
                    <span className="setting-desc">
                      자유로운 연구를 위해 무제한으로 두거나, 실전 감각 훈련을 위해 횟수를 제한할 수 있습니다.
                    </span>
                  </div>
                  <div className="segmented-control">
                    {[
                      { label: '무제한 (기본)', val: -1 },
                      { label: '5회', val: 5 },
                      { label: '3회', val: 3 },
                      { label: '1회', val: 1 },
                      { label: '끄기', val: 0 }
                    ].map(opt => (
                      <button
                        key={opt.val}
                        type="button"
                        className={`seg-btn ${hintLimit === opt.val ? 'active' : ''}`}
                        onClick={() => {
                          setHintLimit(opt.val);
                          showToast(`힌트 제한: ${opt.label}`);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 4. AI Delay */}
                <div className="setting-row stacked">
                  <div className="setting-info">
                    <span className="setting-label">⏱️ AI 착수 딜레이 (사고 속도)</span>
                    <span className="setting-desc">
                      AI가 수를 결정한 후 실제로 말을 움직이기까지 생각하는 시간입니다.
                    </span>
                  </div>
                  <div className="segmented-control">
                    {[
                      { label: '빠름 (0.2s)', val: 200 },
                      { label: '보통 (0.5s)', val: 500 },
                      { label: '신중 (1.0s)', val: 1000 },
                      { label: '장고 (2.0s)', val: 2000 }
                    ].map(opt => (
                      <button
                        key={opt.val}
                        type="button"
                        className={`seg-btn ${aiDelay === opt.val ? 'active' : ''}`}
                        onClick={() => {
                          setAiDelay(opt.val);
                          showToast(`AI 사고 속도: ${opt.label}`);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Section 2: Board Visual & Visual Guide */}
              <div className="settings-section">
                <div className="settings-section-title">
                  <span>🎨 체스판 비주얼 &amp; 이동 가이드</span>
                </div>

                {/* 5. Board Tile Themes */}
                <div className="setting-row stacked">
                  <div className="setting-info">
                    <span className="setting-label">🎨 체스판 타일 테마</span>
                    <span className="setting-desc">체스판 타일의 재질과 색상을 즉시 변경합니다.</span>
                  </div>
                  <div className="tile-themes-grid">
                    {[
                      { id: 'gothic', name: '고딕 흑요석', desc: '아이보리 & 흑요석 (기본)', colorA: '#dcd3c2', colorB: '#14171f' },
                      { id: 'emerald', name: '에메랄드 그린', desc: '대회용 클래식 그린', colorA: '#eef2e6', colorB: '#2d6a4f' },
                      { id: 'wood', name: '클래식 우드', desc: '따뜻한 원목 마호가니', colorA: '#f5e6c8', colorB: '#78350f' },
                      { id: 'slate', name: '슬레이트 블루', desc: '모던 딥 메탈릭 블루', colorA: '#94a3b8', colorB: '#1e293b' },
                      { id: 'gold', name: '로열 골드', desc: '고급스러운 황금빛 앤틱', colorA: '#fef08a', colorB: '#27272a' },
                      { id: 'marble', name: '대리석 마블', desc: '순백 & 다크 대리석', colorA: '#f8fafc', colorB: '#334155' }
                    ].map(t => (
                      <button
                        key={t.id}
                        type="button"
                        className={`tile-theme-card ${boardTileTheme === t.id ? 'active' : ''}`}
                        onClick={() => {
                          setBoardTileTheme(t.id);
                          showToast(`체스판 테마: ${t.name}`);
                        }}
                      >
                        <div className="tile-preview">
                          <span className="tile-preview-sq" style={{ backgroundColor: t.colorA }}></span>
                          <span className="tile-preview-sq" style={{ backgroundColor: t.colorB }}></span>
                        </div>
                        <div className="tile-card-meta">
                          <span className="tile-card-name">{t.name}</span>
                          <span className="tile-card-desc">{t.desc}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 6. Last Move Highlight */}
                <div className="setting-row">
                  <div className="setting-info">
                    <span className="setting-label">📍 직전 수(이동 경로) 링 하이라이트</span>
                    <span className="setting-desc">
                      방금 착수한 말의 출발 위치(골드 링)와 도착 위치(스카이블루 링)를 3D 체스판에 시각화합니다.
                    </span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={showLastMove}
                      onChange={e => {
                        const val = e.target.checked;
                        setShowLastMove(val);
                        showToast(val ? '📍 직전 수 하이라이트 켜짐' : '📍 직전 수 하이라이트 꺼짐');
                      }}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {/* 7. Sound FX */}
                <div className="setting-row">
                  <div className="setting-info">
                    <span className="setting-label">🔊 이동 및 타격 효과음</span>
                    <span className="setting-desc">말 이동, 기물 포획, 캐슬링, 체크 사운드를 출력합니다.</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={soundEnabled}
                      onChange={e => {
                        const val = e.target.checked;
                        setSoundEnabled(val);
                        audio.enabled = val;
                        showToast(val ? '효과음 켜짐 🔊' : '효과음 꺼짐 🔇');
                      }}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {/* 8. Local Auto Rotate */}
                <div className="setting-row">
                  <div className="setting-info">
                    <span className="setting-label">🔄 로컬 2인 대국 시 체스판 180° 자동 회전</span>
                    <span className="setting-desc">오프라인 친구 대전 시 내 차례마다 체스판 시점을 마주 보게 자동 회전합니다.</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={autoRotateLocal}
                      onChange={e => {
                        const val = e.target.checked;
                        setAutoRotateLocal(val);
                        showToast(val ? '자동 회전 켜짐' : '자동 회전 꺼짐');
                      }}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              </div>

              {/* Section 3: 3D Camera Presets */}
              <div className="settings-section">
                <div className="settings-section-title">
                  <span>🎥 3D 카메라 뷰 프리셋</span>
                </div>
                <div className="cam-presets-grid">
                  <button
                    type="button"
                    className="cam-preset-btn"
                    onClick={() => {
                      (window as any).wizardChess?.setCameraPreset('player');
                      showToast('카메라: 플레이어 정면 뷰');
                    }}
                  >
                    👁️ 플레이어 뷰
                  </button>
                  <button
                    type="button"
                    className="cam-preset-btn"
                    onClick={() => {
                      (window as any).wizardChess?.setCameraPreset('top');
                      showToast('카메라: 탑다운(2D 감각) 뷰');
                    }}
                  >
                    📐 탑다운 뷰 (2D)
                  </button>
                  <button
                    type="button"
                    className="cam-preset-btn"
                    onClick={() => {
                      (window as any).wizardChess?.setCameraPreset('side');
                      showToast('카메라: 측면 사이드 뷰');
                    }}
                  >
                    ↔️ 사이드 뷰
                  </button>
                  <button
                    type="button"
                    className="cam-preset-btn"
                    onClick={() => {
                      (window as any).wizardChess?.setCameraPreset('wide');
                      showToast('카메라: 와이드 전경 뷰');
                    }}
                  >
                    🏰 와이드 전경
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="modal-action-btn primary full-width"
                onClick={() => setShowSettingsModal(false)}
              >
                ✓ 설정 완료 및 대국 계속하기
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
