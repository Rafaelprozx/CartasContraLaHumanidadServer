const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const MAX_HAND_SIZE = 6;
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';

  do {
    code = '';
    for (let i = 0; i < 6; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms[code]);

  return code;
}

function shuffle(array) {
  const clone = [...array];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

function sanitizePlayers(players) {
  return players.map(player => ({
    id: player.id,
    name: player.name,
    score: player.score
  }));
}

function getRoomBySocket(socketId) {
  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    if (room.players.some(player => player.id === socketId)) {
      return { roomCode, room };
    }
  }
  return null;
}

function emitLobbyUpdate(roomCode) {
	console.log("lobbyupdate");
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit('lobby_update', {
    room_code: roomCode,
    room_name: room.roomName,
    players: sanitizePlayers(room.players),
    host_id: room.hostId,
    judge_id: room.players[room.judgeIndex]?.id || null,
    state: room.state
  });
}

function emitRoomList(socket) {
  const roomList = Object.entries(rooms).map(([roomCode, room]) => ({
    room_code: roomCode,
    room_name: room.roomName,
    host_name: room.players.find(player => player.id === room.hostId)?.name || 'Host',
    player_count: room.players.length,
    max_players: MAX_PLAYERS,
    state: room.state
  }));

  socket.emit('room_list', {
    rooms: roomList
  });
}

function emitHands(room) {
  for (const player of room.players) {
		  io.to(player.id).emit('hand_updated', {
		cards: player.hand,
		blackcards: player.blackhand
		});
  }
}

function beginChoosingBlack(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.state = 'choosing_black';
  room.currentBlackCard = null;
  room.submissions = [];

  io.to(roomCode).emit('new_judge', {
    judge_id: room.players[room.judgeIndex]?.id || null
  });
  const judge = room.players[room.judgeIndex];
	if (!judge) return;
	judge.blackhand = getRandomBlackCards(room,5);
	updateJudgeFlags(room);
  io.to(judge.id).emit("your_turn_as_judge", {
      judge_id: judge.id,
      black_choices: judge.blackhand
    });
  io.to(roomCode).emit('game_started', {
      judge_id: room.players[room.judgeIndex]?.id || null
    });
  io.to(judge.id).emit('unlock_card_send');
}

function getRandomBlackCards(room, count = 5) {
  if (!room.usedBlackCards) {
    room.usedBlackCards = [];
  }

  const cards = [];

  while (cards.length < count) {
    const num = Math.floor(Math.random() * 394);
    const cardId = formatCardId("B", num);

    if (
      !room.usedBlackCards.includes(cardId) &&
      !cards.includes(cardId)
    ) {
      cards.push(cardId);
    }
  }

  return cards;
}

function getRandomWhiteCard(room,player) {
    const num = Math.floor(Math.random() * 1924);
    const cardId = formatCardId("W", num);
	const hand = player.hand
    if (
      !room.usedWhiteCards.includes(cardId) &&
      !hand.includes(cardId)
    ) {
      hand.push(cardId);
      room.usedWhiteCards.push(cardId);
    }

  return cardId;
}

function getRandomWhiteCards(room, count = 5) {
	console.log("getRandomWhiteCards");
  const hand = [];

  while (hand.length < count) {
    const num = Math.floor(Math.random() * 1924);
    const cardId = formatCardId("W", num);

    if (
      !room.usedWhiteCards.includes(cardId) &&
      !hand.includes(cardId)
    ) {
      hand.push(cardId);
      room.usedWhiteCards.push(cardId);
    }
  }

  return hand;
}

function refillHand(player, room, targetSize = 5) {
  if (!player.hand) {
    player.hand = [];
  }

  player.hand = getRandomWhiteCards(room);
}

function formatCardId(prefix, num) {
  return `${prefix}${String(num).padStart(3, '0')}`;
}

function removePlayerFromRoom(roomCode, socketId) {
  const room = rooms[roomCode];
if (room.state === 'answering') {
  maybeShowSubmissions(roomCode);
}
  if (!room) return;

  const leavingIndex = room.players.findIndex(player => player.id === socketId);
  if (leavingIndex === -1) return;

  room.players = room.players.filter(player => player.id !== socketId);
  room.submissions = room.submissions.filter(sub => sub.playerId !== socketId);

  if (room.players.length === 0) {
    delete rooms[roomCode];
    return;
  }

  if (room.hostId === socketId) {
    room.hostId = room.players[0].id;
  }

  if (leavingIndex <= room.judgeIndex && room.judgeIndex > 0) {
    room.judgeIndex -= 1;
  }

  room.judgeIndex = Math.min(room.judgeIndex, room.players.length - 1);
  maybeShowSubmissions(roomCode);
  emitLobbyUpdate(roomCode);
}

function updateJudgeFlags(room) {
  room.players.forEach((player, index) => {
    player.isJudge = index === room.judgeIndex;
  });
}


function maybeShowSubmissions(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'answering') return;

  const expected = room.players.length - 1;
  if (room.submissions.length < expected) return;

  room.state = 'judging';
  const judge = room.players[room.judgeIndex];
  if (!judge) return;

  const shuffled = shuffle(room.submissions).map(submission => ({
    submission_id: submission.submission_id,
    card_id: submission.card_id
  }));

  io.to(judge.id).emit('show_submissions', {
    cards: shuffled
  });
}

io.on('connection', (socket) => {
  console.log('Jugador conectado:', socket.id);

  socket.on('create_room', data => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      hostId: socket.id,
      roomName: data?.room_name || `Sala de ${data?.name || 'Host'}`,
      judgeIndex: 0,
      state: 'lobby',
      currentBlackCard: null,
      submissions: [],
	  usedBlackCards: [],
	  usedWhiteCards: [],
      players: [
        {
          id: socket.id,
          name: data?.name || 'Host',
          score: 0,
          hand: [],
		  blackhand: [],
		  isJudge: true
        }
      ]
    };

    console.log('[ROOM CREATED]', {
      room_code: roomCode,
      room_name: rooms[roomCode].roomName,
      host_id: socket.id,
      host_name: data?.name || 'Host'
    });

    refillHand(rooms[roomCode].players[0], rooms[roomCode]);
    socket.join(roomCode);

    socket.emit('room_created', {
      room_code: roomCode,
      room_name: rooms[roomCode].roomName,
      player_id: socket.id
    });

    io.to(socket.id).emit('hand_updated', {
      cards: rooms[roomCode].players[0].hand,
	  blackcards: rooms[roomCode].players[0].blackhand
    });

    emitLobbyUpdate(roomCode);
  });
  
socket.on("request_game_state", () => {
  const roomData = getRoomBySocket(socket.id);
  if (!roomData) return;

  const { room, roomCode } = roomData;

  if (!room.players || typeof room.judgeIndex !== "number") {
    return;
  }

  const judge = room.players[room.judgeIndex];
  const player = room.players.find(p => p.id === socket.id);

  if (!player) return;

  io.to(socket.id).emit("hand_updated", {
    cards: player.hand || [],
	blackcards: player.blackhand || []
  });
  

  if (room.state === "choosing_black" && judge?.id === socket.id) {
    judge.blackhand = getRandomBlackCards(room, 5);


	for (const player of room.players) {
		if (player.isJudge){
			io.to(player.id).emit("your_turn_as_judge", {
      judge_id: judge.id,
      black_choices: judge.blackhand
    });
		}else{
	io.to(player.id).emit("your_turn_as_player");
		}
  }
  }
});

  socket.on('join_room', data => {
    const roomCode = data?.room_code;
    const room = rooms[roomCode];

    if (!room) {
      socket.emit('server_error', {
        message: 'La sala no existe.'
      });
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('server_error', {
        message: 'La sala está llena.'
      });
      return;
    }

    const player = {
      id: socket.id,
      name: data?.name || 'Jugador',
      score: 0,
      hand: [],
	  blackhand: [],
	  isJudge: false
    };

    room.players.push(player);
    refillHand(player, room);
    socket.join(roomCode);

    socket.emit('joined_room', {
      room_code: roomCode,
      room_name: room.roomName,
      player_id: socket.id
    });

    io.to(socket.id).emit('hand_updated', {
      cards: player.hand,
	  blackcards: player.blackhand
    });

    emitLobbyUpdate(roomCode);
  });

  socket.on('list_rooms', () => {
    emitRoomList(socket);
  });

  socket.on('close_room', () => {
    const roomData = getRoomBySocket(socket.id);
    if (!roomData) return;

    const { roomCode, room } = roomData;
    if (room.hostId !== socket.id) return;

    io.to(roomCode).emit('room_closed', {
      room_code: roomCode,
      room_name: room.roomName
    });

    delete rooms[roomCode];
  });

  socket.on('leave_room', () => {
    const roomData = getRoomBySocket(socket.id);
    if (!roomData) return;

    const { roomCode } = roomData;
    socket.leave(roomCode);
    removePlayerFromRoom(roomCode, socket.id);
  });

  socket.on('start_game', () => {
    const roomData = getRoomBySocket(socket.id);
    if (!roomData) return;
	const { roomCode, room } = roomData;
	
	if(room.players.length < 2){
		console.log("cannot start server of just one player");
		socket.emit('server_error', {
        message: 'No se puede iniciar con menos de dos jugadores'
      });
	  return;
	}
	
    if (room.hostId !== socket.id) {
      socket.emit('server_error', {
        message: 'Solo el host puede iniciar la partida.'
      });
      return;
    }
	const judge = room.players[room.judgeIndex];
	if (!judge) return;
    room.submissions = [];
	updateJudgeFlags(room);
	beginChoosingBlack(roomCode);
  });

  socket.on('select_black_card', (data) => {
  const roomData = getRoomBySocket(socket.id);
  if (!roomData) return;

  const { room, roomCode } = roomData;
	
  const judge = room.players[room.judgeIndex];
  if (!judge) return;

  if (judge.id !== socket.id) {
    socket.emit('server_error', {
      message: 'No sos el juez.'
    });
    return;
  }

  if (room.state !== 'choosing_black') {
    socket.emit('server_error', {
      message: 'No es momento de elegir carta negra.'
    });
    return;
  }
  const cardId = data?.card_id;

  room.currentBlackCard = cardId;
  room.usedBlackCards.push(cardId);
  room.state = 'answering';
  room.submissions = [];
	
  console.log('[BLACK SELECTED]', cardId);

  // Actualizar manos blancas si hace falta
  emitHands(room);
  
  for (const player of room.players) {
	io.to(player.id).emit("await_answers");
	if (player.id !== judge.id){
		io.to(player.id).emit('unlock_card_send');
	} else {
		io.to(player.id).emit('lock_card_send');
	}
	
  }
  
  
  io.to(roomCode).emit('round_started', {
    black_card_id: room.currentBlackCard,
    judge_id: judge.id
  });
});

  socket.on('ask_card', () => {
	  const roomData = getRoomBySocket(socket.id);
	  if (!roomData) return;
	  const { room, roomCode } = roomData;
	  const player = room.players.find(p => p.id === socket.id);
	  if (player.hand.length <= 5){
		  const cardId = getRandomWhiteCard(room,player);
		  io.to(player.id).emit("white_card_received",{card_id:cardId});
		  emitHands(room);
	  }
  });

  socket.on('submit_white_card', (data) => {
  const roomData = getRoomBySocket(socket.id);

	if (!roomData) {
      return callback?.({
        ok: false,
        message: 'No estás en una sala'
      });
    }

  const { room, roomCode } = roomData;
	
  if (room.state !== 'answering') {
    socket.emit('server_error', {
      message: 'No es momento de responder.'
    });
    return;
  }

  const judge = room.players[room.judgeIndex];
  if (!judge) return;

  if (judge.id === socket.id) {
    socket.emit('server_error', {
      message: 'El juez no responde.'
    });
    return;
  }

  const player = room.players.find(p => p.id === socket.id);
  if (!player) return;

	if (!player) {
      return callback?.({
        ok: false,
        message: 'Jugador no encontrado'
      });
    }

  const cardId = data?.card_id;
  
  // validar que la carta esté en mano
  if (!player.hand.includes(cardId)) {
    socket.emit('server_error', {
      message: 'No tenés esa carta.'
    });
    return;
  }

  // evitar doble submit
  const alreadySubmitted = room.submissions.some(
    sub => sub.playerId === socket.id
  );

  if (alreadySubmitted) {
    socket.emit('server_error', {
      message: 'Ya respondiste.'
    });
    return;
  }
  

  // sacar carta de mano
  player.hand = player.hand.filter(card => card !== cardId);

  room.submissions.push({
    submission_id: `S${Date.now()}_${socket.id}`,
    playerId: socket.id,
    card_id: cardId
  });

  console.log('[WHITE SUBMIT]', player.name, cardId);

  const expectedAnswers = room.players.length - 1;
  const currentAnswers = room.submissions.length;

	console.log(expectedAnswers);

  io.to(roomCode).emit('waiting_submissions', {
    remaining: Math.max(0, expectedAnswers - currentAnswers)
  });

	io.to(player.id).emit('lock_card_send');

  // pasar a judging
  if (currentAnswers >= expectedAnswers) {
    room.state = 'judging';

    const shuffled = [...room.submissions].sort(
      () => Math.random() - 0.5
    );

    io.to(judge.id).emit('show_submissions', {
      submissions: shuffled.map(sub => ({
        submission_id: sub.submission_id,
        card_id: sub.card_id
      }))
    });

    console.log('[JUDGING START]');
  }
});

  socket.on('pick_winner', data => {
    const roomData = getRoomBySocket(socket.id);
    if (!roomData) return;

    const { roomCode, room } = roomData;
    if (room.state !== 'judging') return;

    const judge = room.players[room.judgeIndex];
    if (judge?.id !== socket.id) return;

    const payload = Array.isArray(data) ? data[0] : data;

	const winnerSubmission = room.submissions.find( sub => sub.submission_id === payload?.submission_id);
	
    if (!winnerSubmission) return;

    const winner = room.players.find(player => player.id === winnerSubmission.playerId);
    if (!winner) return;

    winner.score += 1;

	io.to(roomCode).emit('round_winner', {
	winner_player_id: winner.id,
	winner_player_name: winner.name,
	winner_card_id: winnerSubmission.card_id,

	submissions: room.submissions.map(sub => ({
    submission_id: sub.submission_id,
    card_id: sub.card_id,
    is_winner: sub.submission_id === winnerSubmission.submission_id
	})),

  scores: room.players.map(player => ({
    id: player.id,
    name: player.name,
    score: player.score
  }))
});

    setTimeout(() => {
	console.log("next round");
      room.judgeIndex = (room.judgeIndex + 1) % room.players.length;
      emitHands(room);
      beginChoosingBlack(roomCode);
      emitLobbyUpdate(roomCode);
    }, 5000);
  });

  socket.on('disconnect', () => {
    console.log('Jugador desconectado:', socket.id);

    const roomData = getRoomBySocket(socket.id);
    if (!roomData) return;

    const { roomCode } = roomData;
    removePlayerFromRoom(roomCode, socket.id);
  });
});

app.get('/', (req, res) => {
  res.send('Servidor de cartas funcionando');
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});