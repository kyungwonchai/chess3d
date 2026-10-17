import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { networkInterfaces } from 'os';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import QRCode from 'qrcode';
import { Chess } from 'chess.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 10210;

app.use(cors());
app.use(express.json());

// Helper to get local IP addresses for WiFi / LAN play
function getLocalIPs() {
  const nets = networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    const isVirtual = name.startsWith('virbr') || name.startsWith('docker') || name.startsWith('veth') || name.startsWith('br-');
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({
          interface: name,
          address: net.address,
          url: `http://${net.address}:${PORT}/chess3d/`,
          isVirtual,
          isHomeWifi: net.address.startsWith('172.30.') || net.address.startsWith('192.168.')
        });
      }
    }
  }

  results.sort((a, b) => {
    if (a.isHomeWifi && !b.isHomeWifi) return -1;
    if (!a.isHomeWifi && b.isHomeWifi) return 1;
    if (!a.isVirtual && b.isVirtual) return -1;
    if (a.isVirtual && !b.isVirtual) return 1;
    return 0;
  });

  if (results.length === 0) {
    results.push({
      interface: 'localhost',
      address: '127.0.0.1',
      url: `http://127.0.0.1:${PORT}/chess3d/`,
      isVirtual: false,
      isHomeWifi: false
    });
  }
  return results;
}

// Health check endpoint
const healthHandler = (req, res) => {
  res.json({
    status: 'ok',
    service: 'chess3d',
    title: 'Wizard Chess 3D (Network Multiplayer & AI Training)',
    time: new Date().toISOString(),
    activeRooms: Object.keys(rooms).length
  });
};

app.get('/api/health', healthHandler);
app.get('/chess3d/api/health', healthHandler);

// Network Info & QR Code for instant phone joining
const handleInfo = async (req, res) => {
  const ips = getLocalIPs();
  const primaryUrl = ips[0] ? ips[0].url : `http://127.0.0.1:${PORT}/chess3d/`;
  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await QRCode.toDataURL(primaryUrl, {
      margin: 1,
      color: {
        dark: '#1e293b',
        light: '#f8fafc'
      }
    });
  } catch (err) {
    console.error('QR code generation error:', err);
  }

  res.json({
    port: PORT,
    ips,
    primaryUrl,
    duckdnsUrl: 'https://kwopi.duckdns.org/chess3d/',
    qrCode: qrCodeDataUrl,
    activeRooms: Object.keys(rooms).length
  });
};

const handleQr = async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'url parameter required' });
  }
  try {
    const qrCode = await QRCode.toDataURL(targetUrl, {
      margin: 1,
      width: 280,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });
    res.json({ qrCode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
};

app.get('/api/info', handleInfo);
app.get('/chess3d/api/info', handleInfo);
app.get('/api/qr', handleQr);
app.get('/chess3d/api/qr', handleQr);

// =========================================================================
// Real-time WebSocket Room Architecture
// =========================================================================
const rooms = {};
const clientRooms = new Map(); // ws -> { roomId, playerId, role }

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms[id] ? generateRoomId() : id;
}

function broadcastRoomState(room) {
  const state = {
    type: 'room_state',
    roomId: room.id,
    name: room.name,
    fen: room.chess.fen(),
    pgn: room.chess.pgn(),
    history: room.chess.history({ verbose: true }),
    turn: room.chess.turn(),
    isCheck: room.chess.inCheck(),
    isGameOver: room.chess.isGameOver(),
    status: room.status,
    winner: room.winner,
    endReason: room.endReason,
    timeControl: room.timeControl,
    white: room.white ? { id: room.white.id, name: room.white.name, timeLeft: room.white.timeLeft, connected: Boolean(room.white.ws) } : null,
    black: room.black ? { id: room.black.id, name: room.black.name, timeLeft: room.black.timeLeft, connected: Boolean(room.black.ws) } : null,
    spectatorCount: room.spectators.length,
    drawOffer: room.drawOffer,
    rematchOffer: room.rematchOffer
  };

  const payload = JSON.stringify(state);

  if (room.white?.ws?.readyState === WebSocket.OPEN) {
    room.white.ws.send(payload);
  }
  if (room.black?.ws?.readyState === WebSocket.OPEN) {
    room.black.ws.send(payload);
  }
  for (const spec of room.spectators) {
    if (spec.ws?.readyState === WebSocket.OPEN) {
      spec.ws.send(payload);
    }
  }
}

function sendToRoom(room, msg) {
  const payload = JSON.stringify(msg);
  if (room.white?.ws?.readyState === WebSocket.OPEN) room.white.ws.send(payload);
  if (room.black?.ws?.readyState === WebSocket.OPEN) room.black.ws.send(payload);
  for (const spec of room.spectators) {
    if (spec.ws?.readyState === WebSocket.OPEN) spec.ws.send(payload);
  }
}

function startRoomTimer(room) {
  if (room.timeControl.initial <= 0) return; // Unlimited
  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timerInterval = setInterval(() => {
    if (room.status !== 'playing') {
      clearInterval(room.timerInterval);
      return;
    }

    const currentTurn = room.chess.turn(); // 'w' or 'b'
    const player = currentTurn === 'w' ? room.white : room.black;

    if (player) {
      player.timeLeft = Math.max(0, player.timeLeft - 1);

      sendToRoom(room, {
        type: 'clock_tick',
        turn: currentTurn,
        whiteTime: room.white ? room.white.timeLeft : 0,
        blackTime: room.black ? room.black.timeLeft : 0
      });

      if (player.timeLeft <= 0) {
        clearInterval(room.timerInterval);
        room.status = 'ended';
        room.winner = currentTurn === 'w' ? 'b' : 'w';
        room.endReason = '시간 초과 (Time Out)';
        broadcastRoomState(room);
        broadcastRoomList();
      }
    }
  }, 1000);
}

function stopRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function getRoomListData() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    status: r.status,
    host: r.white?.name || r.black?.name || '방장',
    players: (r.white ? 1 : 0) + (r.black ? 1 : 0),
    timeControl: r.timeControl
  }));
}

function broadcastRoomList() {
  const payload = JSON.stringify({ type: 'room_list', rooms: getRoomListData() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({ type: 'room_list', rooms: getRoomListData() }));

  ws.on('message', (messageText) => {
    let data;
    try {
      data = JSON.parse(messageText);
    } catch (e) {
      return;
    }

    const { type } = data;

    // 1. Create Room
    if (type === 'create_room') {
      const roomId = generateRoomId();
      const initialTime = data.timeMinutes ? parseInt(data.timeMinutes) * 60 : 600;
      const increment = data.incrementSeconds ? parseInt(data.incrementSeconds) : 0;
      const playerName = data.playerName || '플레이어 1';
      const preferredColor = data.preferredColor || 'random';

      let assignedColor = preferredColor;
      if (assignedColor === 'random') {
        assignedColor = Math.random() < 0.5 ? 'w' : 'b';
      }

      const room = {
        id: roomId,
        name: data.roomName || `${playerName}의 3D 체스방`,
        chess: new Chess(),
        timeControl: { initial: initialTime, increment },
        white: null,
        black: null,
        spectators: [],
        status: 'waiting',
        winner: null,
        endReason: '',
        turn: 'w',
        timerInterval: null,
        drawOffer: null,
        rematchOffer: { w: false, b: false },
        createdAt: Date.now()
      };

      const playerObj = {
        id: data.playerId || Math.random().toString(36).substring(2, 9),
        name: playerName,
        ws: ws,
        timeLeft: initialTime
      };

      if (assignedColor === 'w') {
        room.white = playerObj;
      } else {
        room.black = playerObj;
      }

      rooms[roomId] = room;
      clientRooms.set(ws, { roomId, playerId: playerObj.id, role: assignedColor });

      ws.send(JSON.stringify({
        type: 'room_created',
        roomId,
        yourRole: assignedColor,
        playerId: playerObj.id
      }));

      broadcastRoomState(room);
      broadcastRoomList();
    }

    // 2. Join Room
    else if (type === 'join_room') {
      const roomId = (data.roomId || '').toUpperCase().trim();
      const room = rooms[roomId];
      const playerName = data.playerName || '게스트';
      const playerId = data.playerId || Math.random().toString(36).substring(2, 9);

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: '방 번호를 찾을 수 없습니다.' }));
        return;
      }

      let role = null;
      if (room.white && room.white.id === playerId) {
        room.white.ws = ws;
        role = 'w';
      } else if (room.black && room.black.id === playerId) {
        room.black.ws = ws;
        role = 'b';
      } else if (!room.white) {
        room.white = { id: playerId, name: playerName, ws, timeLeft: room.timeControl.initial };
        role = 'w';
      } else if (!room.black) {
        room.black = { id: playerId, name: playerName, ws, timeLeft: room.timeControl.initial };
        role = 'b';
      } else {
        role = 'spectator';
        room.spectators.push({ id: playerId, name: playerName, ws });
      }

      clientRooms.set(ws, { roomId, playerId, role });

      if (room.white && room.black && room.status === 'waiting') {
        room.status = 'playing';
        startRoomTimer(room);
      }

      ws.send(JSON.stringify({
        type: 'room_joined',
        roomId,
        yourRole: role,
        playerId
      }));

      broadcastRoomState(room);
      broadcastRoomList();
    }

    // 3. Make Move
    else if (type === 'make_move') {
      const client = clientRooms.get(ws);
      if (!client) return;
      const room = rooms[client.roomId];
      if (!room || room.status !== 'playing') return;

      const currentTurn = room.chess.turn();
      const isPlayerTurn = (currentTurn === 'w' && room.white?.id === client.playerId) ||
                           (currentTurn === 'b' && room.black?.id === client.playerId);

      if (!isPlayerTurn) {
        ws.send(JSON.stringify({ type: 'error', message: '자신의 차례가 아닙니다.' }));
        return;
      }

      try {
        const moveResult = room.chess.move({
          from: data.from,
          to: data.to,
          promotion: data.promotion || 'q'
        });

        if (!moveResult) {
          ws.send(JSON.stringify({ type: 'error', message: '올바르지 않은 수입니다.' }));
          return;
        }

        const player = currentTurn === 'w' ? room.white : room.black;
        if (player && room.timeControl.increment > 0) {
          player.timeLeft += room.timeControl.increment;
        }

        room.drawOffer = null;

        if (room.chess.isGameOver()) {
          stopRoomTimer(room);
          room.status = 'ended';
          if (room.chess.isCheckmate()) {
            room.winner = currentTurn;
            room.endReason = '체크메이트 (Checkmate)';
          } else if (room.chess.isDraw()) {
            room.winner = 'draw';
            if (room.chess.isStalemate()) {
              room.endReason = '스테일메이트 (Stalemate)';
            } else if (room.chess.isThreefoldRepetition()) {
              room.endReason = '3회 동형 반복 무승부 (Threefold Repetition)';
            } else if (room.chess.isInsufficientMaterial()) {
              room.endReason = '기물 부족 무승부 (Insufficient Material)';
            } else {
              room.endReason = '50수 무승부 규칙 (50-move Rule)';
            }
          }
          broadcastRoomList();
        }

        broadcastRoomState(room);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message || '체스 이동 오류' }));
      }
    }

    // 4. Resign
    else if (type === 'resign') {
      const client = clientRooms.get(ws);
      if (!client) return;
      const room = rooms[client.roomId];
      if (!room || room.status !== 'playing') return;

      stopRoomTimer(room);
      room.status = 'ended';
      if (room.white?.id === client.playerId) {
        room.winner = 'b';
        room.endReason = `${room.white.name} 백 기권`;
      } else if (room.black?.id === client.playerId) {
        room.winner = 'w';
        room.endReason = `${room.black.name} 흑 기권`;
      }
      broadcastRoomState(room);
      broadcastRoomList();
    }

    // 5. Draw Offers
    else if (type === 'offer_draw') {
      const client = clientRooms.get(ws);
      if (!client) return;
      const room = rooms[client.roomId];
      if (!room || room.status !== 'playing') return;

      const side = (room.white?.id === client.playerId) ? 'w' : (room.black?.id === client.playerId) ? 'b' : null;
      if (!side) return;

      if (room.drawOffer) {
        ws.send(JSON.stringify({ type: 'toast', message: '이미 무승부 제안이 진행 중입니다.' }));
        return;
      }

      room.drawOffer = side;
      broadcastRoomState(room);
    }
    else if (type === 'respond_draw') {
      const client = clientRooms.get(ws);
      if (!client) return;
      const room = rooms[client.roomId];
      if (!room || room.status !== 'playing') return;

      const side = (room.white?.id === client.playerId) ? 'w' : (room.black?.id === client.playerId) ? 'b' : null;
      if (!side || !room.drawOffer || room.drawOffer === side) return;

      if (data.accept) {
        stopRoomTimer(room);
        room.status = 'ended';
        room.winner = 'draw';
        room.endReason = '상호 합의 무승부 (Draw by Agreement)';
        room.drawOffer = null;
        broadcastRoomState(room);
        broadcastRoomList();
      } else {
        const offeringPlayer = room.drawOffer === 'w' ? room.white : room.black;
        room.drawOffer = null;
        broadcastRoomState(room);
        if (offeringPlayer?.ws?.readyState === WebSocket.OPEN) {
          offeringPlayer.ws.send(JSON.stringify({ type: 'toast', message: '상대방이 무승부 제안을 거절했습니다.' }));
        }
      }
    }

    // 6. Rematch
    else if (type === 'request_rematch') {
      const client = clientRooms.get(ws);
      if (!client) return;
      const room = rooms[client.roomId];
      if (!room || room.status !== 'ended') return;

      const isWhite = room.white?.id === client.playerId;
      const isBlack = room.black?.id === client.playerId;

      if (!isWhite && !isBlack) return;

      if (isWhite) room.rematchOffer.w = true;
      if (isBlack) room.rematchOffer.b = true;

      if (room.rematchOffer.w && room.rematchOffer.b) {
        room.chess = new Chess();
        room.status = 'playing';
        room.winner = null;
        room.endReason = '';
        room.drawOffer = null;
        room.rematchOffer = { w: false, b: false };

        const prevWhite = room.white;
        const prevBlack = room.black;

        room.white = { ...prevBlack, timeLeft: room.timeControl.initial };
        room.black = { ...prevWhite, timeLeft: room.timeControl.initial };

        if (room.white?.ws) {
          const cw = clientRooms.get(room.white.ws);
          if (cw) cw.role = 'w';
        }
        if (room.black?.ws) {
          const cb = clientRooms.get(room.black.ws);
          if (cb) cb.role = 'b';
        }

        startRoomTimer(room);
        broadcastRoomList();
      }

      broadcastRoomState(room);
    }

    // 7. In-game Chat & Emojis
    else if (type === 'chat_message') {
      const client = clientRooms.get(ws);
      if (!client) return;
      const room = rooms[client.roomId];
      if (!room) return;

      const senderName = (room.white?.id === client.playerId) ? room.white.name :
                         (room.black?.id === client.playerId) ? room.black.name : '관전자';

      sendToRoom(room, {
        type: 'chat_broadcast',
        sender: senderName,
        text: (data.text || '').substring(0, 100),
        emoji: data.emoji || null,
        timestamp: Date.now()
      });
    }

    // 8. Public Room List
    else if (type === 'list_rooms') {
      ws.send(JSON.stringify({ type: 'room_list', rooms: getRoomListData() }));
    }

    // 9. Leave Room
    else if (type === 'leave_room') {
      const client = clientRooms.get(ws);
      if (client) {
        const room = rooms[client.roomId];
        if (room) {
          if (room.white?.ws === ws) room.white.ws = null;
          if (room.black?.ws === ws) room.black.ws = null;
          room.spectators = room.spectators.filter(s => s.ws !== ws);

          if (room.status === 'waiting' && !room.white?.ws && !room.black?.ws) {
            stopRoomTimer(room);
            delete rooms[room.id];
          } else {
            broadcastRoomState(room);
          }
          broadcastRoomList();
        }
        clientRooms.delete(ws);
      }
    }
  });

  ws.on('close', () => {
    const client = clientRooms.get(ws);
    if (client) {
      const room = rooms[client.roomId];
      if (room) {
        if (room.white?.ws === ws) room.white.ws = null;
        if (room.black?.ws === ws) room.black.ws = null;
        room.spectators = room.spectators.filter(s => s.ws !== ws);

        if (!room.white?.ws && !room.black?.ws && room.spectators.length === 0) {
          setTimeout(() => {
            if (!room.white?.ws && !room.black?.ws && room.spectators.length === 0) {
              stopRoomTimer(room);
              delete rooms[room.id];
              broadcastRoomList();
            }
          }, 300000);
        } else {
          broadcastRoomState(room);
        }
        broadcastRoomList();
      }
      clientRooms.delete(ws);
    }
  });
});

// Periodic heartbeat to prevent dead connections
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30000);

// Static assets serving (Dual routing: /chess3d and /)
const distPath = path.join(__dirname, 'dist');

if (fs.existsSync(distPath)) {
  app.use('/chess3d', express.static(distPath));
  app.use(express.static(distPath));

  app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  console.warn('⚠️ dist directory not found! Run npm run build first.');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`♟️ Wizard Chess 3D Server running on port ${PORT}`);
  console.log(`🔗 Local URL:  http://localhost:${PORT}/chess3d/`);
  console.log(`🌐 DuckDNS:    https://kwopi.duckdns.org/chess3d/`);
  console.log(`📡 WebSocket:  ws://localhost:${PORT}/chess3d/`);
  console.log(`=================================================`);
});
