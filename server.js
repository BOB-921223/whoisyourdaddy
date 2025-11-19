const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require("socket.io");
const path = require('path'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const WORDS_DB = require('./words');

let rooms = {}; 

io.on('connection', (socket) => {
    
    socket.on('createRoom', (nickname) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        
        let safeName = (nickname || "玩家1").trim().substring(0, 10);
        if (!safeName) safeName = "玩家1";

        rooms[roomId] = {
            id: roomId,
            hostId: socket.id,
            players: [], 
            status: 'waiting', 
            gameData: {}       
        };
        joinRoomLogic(socket, roomId, safeName, true);
    });

    socket.on('joinRoom', ({ roomId, nickname }) => {
        const room = rooms[roomId];
        if (room && room.status === 'waiting' && room.players.length < 8) {
            
            let defaultName = `玩家${room.players.length + 1}`;
            let safeName = (nickname || defaultName).trim().substring(0, 10);
            if (!safeName) safeName = defaultName;

            joinRoomLogic(socket, roomId, safeName, false);
        } else {
            socket.emit('errorMessage', '房間不存在、已滿或遊戲已開始！');
        }
    });

    // ★★★ 新增：離開房間邏輯 ★★★
    socket.on('leaveRoom', (roomId) => {
        const room = rooms[roomId];
        if (room) {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                // 移除玩家
                room.players.splice(index, 1);
                // 通知其他人
                io.in(roomId).emit('updatePlayerList', room.players);
                // 讓 Socket 離開房間頻道
                socket.leave(roomId);
            }
        }
    });

    socket.on('toggleReady', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.isHost && room.status === 'waiting') {
            player.isReady = !player.isReady;
            io.in(roomId).emit('updatePlayerList', room.players);
        }
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const allReady = room.players.every(p => p.isHost || p.isReady);
        
        if (room.hostId === socket.id && room.players.length >= 3 && allReady) {
            startGameLogic(roomId);
        }
    });

    socket.on('submitDescription', ({ roomId, msg }) => {
        const room = rooms[roomId];
        if(room && room.status === 'speaking' && 
           room.players[room.gameData.currentTurnIndex].id === socket.id) {
            nextTurn(roomId); 
        }
    });

    socket.on('skipTurn', (roomId) => {
        const room = rooms[roomId];
        if (room && room.status === 'speaking') {
            const currentPlayer = room.players[room.gameData.currentTurnIndex];
            if (currentPlayer && currentPlayer.id === socket.id) {
                nextTurn(roomId);
            }
        }
    });

    socket.on('votePlayer', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if(room && room.status === 'voting') {
            const voter = room.players.find(p => p.id === socket.id);
            const target = room.players.find(p => p.id === targetId);

            if (voter && voter.isAlive && target && target.isAlive) {
                room.gameData.votes[socket.id] = targetId;
                const aliveCount = room.players.filter(p => p.isAlive).length;
                const votedCount = Object.keys(room.gameData.votes).length;
                
                if(votedCount >= aliveCount) {
                    if (room.voteTimer) clearInterval(room.voteTimer);
                    calculateVoteResult(roomId);
                }
            }
        }
    });

    socket.on('disbandRoom', (roomId) => disbandRoom(roomId));
    socket.on('disconnect', () => handleDisconnect(socket));
});

function joinRoomLogic(socket, roomId, name, isHost) {
    const room = rooms[roomId];
    socket.join(roomId);
    room.players.push({
        id: socket.id,
        name: name,
        isReady: isHost, 
        isHost: isHost,
        isAlive: true 
    });
    socket.emit('roomJoined', { roomId, isHost });
    io.in(roomId).emit('updatePlayerList', room.players);
}

function getUnusedWordPair(room) {
    if (!room.gameData.usedWordIndices) {
        room.gameData.usedWordIndices = [];
    }
    const allIndices = WORDS_DB.map((_, i) => i);
    const availableIndices = allIndices.filter(i => !room.gameData.usedWordIndices.includes(i));
    let selectedIndex;
    if (availableIndices.length === 0) {
        room.gameData.usedWordIndices = [];
        selectedIndex = Math.floor(Math.random() * WORDS_DB.length);
    } else {
        selectedIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
    }
    room.gameData.usedWordIndices.push(selectedIndex);
    return WORDS_DB[selectedIndex];
}

function startGameLogic(roomId) {
    const room = rooms[roomId];
    room.status = 'reveal';
    room.gameData.usedWordIndices = []; 

    const wordPair = getUnusedWordPair(room);
    const undercoverIndex = Math.floor(Math.random() * room.players.length);
    const undercoverId = room.players[undercoverIndex].id;

    room.gameData.wordPair = wordPair;
    room.gameData.undercoverId = undercoverId;
    room.gameData.currentTurnIndex = -1;
    room.gameData.votes = {};

    room.players.forEach(p => {
        p.isAlive = true;
        const word = (p.id === undercoverId) ? wordPair.undercover : wordPair.normal;
        const role = (p.id === undercoverId) ? "帥潮" : "哥布林";
        io.to(p.id).emit('gameStarted', { role: role, word: word });
    });

    let count = 10;
    io.in(roomId).emit('systemMessage', `請確認身分，遊戲將在 ${count} 秒後開始...`);
    const timer = setInterval(() => {
        count--;
        io.in(roomId).emit('timerUpdate', count);
        if(count <= 0) {
            clearInterval(timer);
            io.in(roomId).emit('hideOverlay'); 
            startSpeakingPhase(roomId);
        }
    }, 1000);
}

function startSpeakingPhase(roomId) {
    const room = rooms[roomId];
    room.status = 'speaking';
    room.gameData.currentTurnIndex = -1; 
    nextTurn(roomId); 
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if(room.turnTimer) clearTimeout(room.turnTimer);

    let nextIndex = room.gameData.currentTurnIndex + 1;
    while(nextIndex < room.players.length && !room.players[nextIndex].isAlive) {
        nextIndex++;
    }
    if (nextIndex >= room.players.length) {
        startVotingPhase(roomId);
        return;
    }
    room.gameData.currentTurnIndex = nextIndex;
    const currentPlayer = room.players[nextIndex];
    io.in(roomId).emit('playerTurn', { playerId: currentPlayer.id, duration: 30 });

    let timeLeft = 30;
    io.in(roomId).emit('timerUpdate', timeLeft);
    
    room.turnTimer = setInterval(() => {
        timeLeft--;
        if(!rooms[roomId] || rooms[roomId].status !== 'speaking' || rooms[roomId].gameData.currentTurnIndex !== nextIndex) {
            clearInterval(room.turnTimer);
            return;
        }
        io.in(roomId).emit('timerUpdate', timeLeft);
        if(timeLeft <= 0) {
            clearInterval(room.turnTimer);
            nextTurn(roomId);
        }
    }, 1000);
}

function startVotingPhase(roomId) {
    const room = rooms[roomId];
    room.status = 'voting';
    room.gameData.votes = {}; 
    io.in(roomId).emit('startVoting', { alivePlayers: room.players.filter(p => p.isAlive) });
    
    let timeLeft = 20;
    io.in(roomId).emit('systemMessage', `發言結束，請開始投票！ (${timeLeft}s)`);
    io.in(roomId).emit('timerUpdate', timeLeft);

    if (room.voteTimer) clearInterval(room.voteTimer);

    room.voteTimer = setInterval(() => {
        timeLeft--;
        
        if(!rooms[roomId] || rooms[roomId].status !== 'voting') {
            clearInterval(room.voteTimer);
            return;
        }

        io.in(roomId).emit('timerUpdate', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(room.voteTimer);
            calculateVoteResult(roomId);
        }
    }, 1000);
}

function calculateVoteResult(roomId) {
    const room = rooms[roomId];
    
    room.status = 'calculating'; 

    const votes = room.gameData.votes;
    const voteCounts = {};

    for (let voterId in votes) {
        const targetId = votes[voterId];
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let maxCandidates = []; 

    for (let pid in voteCounts) {
        if (voteCounts[pid] > maxVotes) {
            maxVotes = voteCounts[pid];
            maxCandidates = [pid];
        } else if (voteCounts[pid] === maxVotes) {
            maxCandidates.push(pid);
        }
    }

    if (maxVotes === 0 || maxCandidates.length > 1) {
        io.in(roomId).emit('showResult', { msg: "今晚沒抓到帥潮", duration: 8 });
        
        setTimeout(() => {
             if(room.status !== 'waiting') startSpeakingPhase(roomId);
        }, 8000);
    } 
    else {
        const targetId = maxCandidates[0];
        const player = room.players.find(p => p.id === targetId);
        player.isAlive = false; 
        
        io.in(roomId).emit('updatePlayerList', room.players);
        
        checkWinCondition(roomId, player.id, player.name);
    }
}

function startNextRoundWithNewWords(roomId) {
    const room = rooms[roomId];
    const newWordPair = getUnusedWordPair(room);
    room.gameData.wordPair = newWordPair;
    room.players.forEach(p => {
        if (p.isAlive) {
            const word = (p.id === room.gameData.undercoverId) ? newWordPair.undercover : newWordPair.normal;
            io.to(p.id).emit('updateWord', { word: word });
        }
    });
    io.in(roomId).emit('systemMessage', '題目已更新！發言階段開始');
    startSpeakingPhase(roomId);
}

function checkWinCondition(roomId, deadPlayerId, deadPlayerName) {
    const room = rooms[roomId];
    const undercoverId = room.gameData.undercoverId;
    const alivePlayers = room.players.filter(p => p.isAlive);
    const isUndercoverAlive = alivePlayers.some(p => p.id === undercoverId);

    let winMsg = "";
    let isGameOver = false;

    if (deadPlayerId === undercoverId) {
        winMsg = `淘汰者是：${deadPlayerName} (帥潮)！這是屬於哥布林的勝利！`;
        isGameOver = true;
    }
    else if (alivePlayers.length <= 2 && isUndercoverAlive) {
        winMsg = `淘汰者是：${deadPlayerName} (哥布林)。要贏帥潮還是太難了，帥潮獲勝！`;
        isGameOver = true;
    }
    else {
        io.in(roomId).emit('showResult', { msg: `淘汰者是：${deadPlayerName}。更換題目繼續...`, duration: 8 });
        setTimeout(() => {
             if(room.status !== 'waiting') startNextRoundWithNewWords(roomId);
        }, 8000);
        return;
    }

    if (isGameOver) {
        io.in(roomId).emit('showResult', { msg: winMsg, duration: 10 });
        room.status = 'waiting'; 
        room.players.forEach(p => { p.isReady = p.isHost; p.isAlive = true; });
        setTimeout(() => {
             io.in(roomId).emit('gameReset'); 
             io.in(roomId).emit('updatePlayerList', room.players);
        }, 10000);
    }
}

function disbandRoom(roomId) {
    if(rooms[roomId]) {
        io.in(roomId).emit('roomDisbanded');
        io.socketsLeave(roomId);
        delete rooms[roomId];
    }
}

function handleDisconnect(socket) {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const index = room.players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            if (room.players[index].isHost) {
                disbandRoom(roomId);
            } else {
                room.players.splice(index, 1);
                io.in(roomId).emit('updatePlayerList', room.players);
            }
            break;
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

const RENDER_URL = "https://whoisyourdaddy.onrender.com"; 
setInterval(() => {
    https.get(RENDER_URL, (res) => {
        console.log(`Keep-alive ping sent: ${res.statusCode}`);
    }).on('error', (e) => {
        console.error(`Keep-alive error: ${e.message}`);
    });
}, 14 * 60 * 1000);