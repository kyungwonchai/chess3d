import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Chess, Square, Move } from 'chess.js';
import { initWizardChess } from './wizardChessEngine.js';
import { audio } from './audio';
import { evaluateBoard, findBestMove, computeCapturedPieces } from './chessEngine';

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
  const [showControlsDrawer, setShowControlsDrawer] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

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
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    initWizardChess();

    // Hook user move attempt from 3D board
    const win = window as any;
    if (win.wizardChess) {
      win.wizardChess.setOnUserMoveAttempt((moveAttempt: any) => {
        const { from, to, isPromotion, color } = moveAttempt;

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

          // Play Sound
          if (move.captured) audio.playCapture();
          else if (move.flags.includes('k') || move.flags.includes('q')) audio.playCastle();
          else audio.playMove();

          if (chessRef.current.inCheck()) audio.playCheck();

          refreshBoardAnalysis(chessRef.current);

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
            win.wizardChess.setBoardOrientation(chessRef.current.turn());
          }

          return true;
        } catch (e) {
          return false;
        }
      });

      win.wizardChess.setOnMoveCompleted((completed: any) => {
        // Trigger AI response if in AI mode and it's AI turn
        if (gameMode === 'ai' && !chessRef.current.isGameOver()) {
          const aiColor = myColor === 'w' ? 'b' : 'w';
          if (chessRef.current.turn() === aiColor) {
            triggerAIMove();
          }
        }
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
  }, [gameMode, myColor, autoRotateLocal, refreshBoardAnalysis, showToast]);

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

      // Sound
      if (executed.captured) audio.playCapture();
      else if (executed.flags.includes('k') || executed.flags.includes('q')) audio.playCastle();
      else audio.playMove();

      if (chessRef.current.inCheck()) audio.playCheck();

      refreshBoardAnalysis(chessRef.current);

      if (chessRef.current.isGameOver()) {
        checkAndAnnounceGameOver();
      }
    }, 380);
  }, [aiDifficulty, refreshBoardAnalysis]);

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

  // Handle Theme Switching
  const handleThemeChange = (newTheme: EnvTheme) => {
    setTheme(newTheme);
    const win = window as any;
    if (win.wizardChess?.setTheme) {
      win.wizardChess.setTheme(newTheme);
    }
    showToast(`테마 변경: ${newTheme === 'cathedral' ? '중세 대성당' : newTheme === 'bluesky' ? '푸른 하늘' : newTheme === 'cosmic' ? '우주 성운' : '스튜디오'}`);
  };

  // AI Hint Action
  const handleShowHint = () => {
    if (chessRef.current.isGameOver()) return;
    const res = findBestMove(chessRef.current, 3);
    if (res.move) {
      setHintMove({ san: res.move.san, score: res.score });
      const win = window as any;
      win.wizardChess?.highlightHint(res.move.from, res.move.to);
      showToast(`추천 수: ${res.move.san} (평가치: ${(res.score / 100).toFixed(1)})`);
    }
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
    win.wizardChess?.resetBoard();

    // Replay remaining history on 3D board
    const moves = chessRef.current.history({ verbose: true });
    for (const m of moves) {
      win.wizardChess?.makeMove(m.from, m.to, m.promotion || 'queen');
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
    refreshBoardAnalysis(chessRef.current);

    const win = window as any;
    win.wizardChess?.resetBoard();
    audio.playGameStart();
    showToast('새 게임이 시작되었습니다.');
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
            onClick={() => setShowControlsDrawer(prev => !prev)}
            title="카메라 및 게임 컨트롤"
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
                💡 최선수 힌트
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
    </>
  );
}
