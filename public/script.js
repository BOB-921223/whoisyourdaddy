const socket = io();

// DOM 元素
const screens = {
    login: document.getElementById('login-screen'),
    lobby: document.getElementById('lobby-screen'),
    game: document.getElementById('game-screen')
};
const overlay = {
    el: document.getElementById('overlay'),
    title: document.getElementById('overlay-title'),
    msg: document.getElementById('overlay-msg')
};

let currentRoomId = null;
let myId = null;
let isVoteMode = false;
let myIsHost = false;
let currentPlayers = []; 

// --- 1. 基礎按鈕 ---
document.getElementById('btn-create').addEventListener('click', () => {
    const name = document.getElementById('nickname').value;
    if (name.length > 10) return alert("暱稱請勿超過 10 個字！");
    socket.emit('createRoom', name);
});

document.getElementById('btn-join').addEventListener('click', () => {
    const name = document.getElementById('nickname').value;
    const roomId = document.getElementById('room-input').value;
    if(!roomId) return alert("請輸入房號");
    if (name.length > 10) return alert("暱稱請勿超過 10 個字！");
    socket.emit('joinRoom', { roomId, nickname: name });
});

document.getElementById('btn-ready').addEventListener('click', () => socket.emit('toggleReady', currentRoomId));
document.getElementById('btn-start').addEventListener('click', () => socket.emit('startGame', currentRoomId));
document.getElementById('btn-disband').addEventListener('click', () => {
    if(confirm("確定解散?")) socket.emit('disbandRoom', currentRoomId);
});

// ★★★ 新增：離開房間按鈕 ★★★
document.getElementById('btn-leave').addEventListener('click', () => {
    // 1. 通知伺服器 (雖然 reload 也會觸發 disconnect，但這樣更保險)
    if(currentRoomId) {
        socket.emit('leaveRoom', currentRoomId);
    }
    // 2. 直接重整頁面回到主畫面 (不跳通知)
    location.reload();
});

document.getElementById('btn-skip').addEventListener('click', () => {
    socket.emit('skipTurn', currentRoomId);
});

// --- 2. Socket 事件 ---
socket.on('connect', () => { myId = socket.id; });

socket.on('roomJoined', (data) => {
    currentRoomId = data.roomId;
    myIsHost = data.isHost;
    
    showScreen('lobby');
    document.getElementById('display-room-id').innerText = data.roomId;
    
    document.getElementById('host-controls').classList.toggle('hidden', !myIsHost);
    document.getElementById('guest-controls').classList.toggle('hidden', myIsHost);
});

socket.on('updatePlayerList', (players) => {
    currentPlayers = players; 

    // A. 大廳更新
    if (!screens.lobby.classList.contains('hidden')) {
        const container = document.getElementById('lobby-players-container');
        container.innerHTML = '';
        const allReady = players.every(p => p.isHost || p.isReady);

        for (let i = 0; i < 8; i++) {
            const p = players[i];
            const slot = document.createElement('div');
            slot.className = 'player-slot';

            if (p) {
                slot.classList.add('occupied');
                if (p.isReady) slot.classList.add('is-ready');
                slot.innerHTML = `
                    <div class="ready-mark">✅</div>
                    <div style="font-size: 1.5rem;">👤</div>
                    <div style="font-weight:bold;">${p.name}</div>
                    ${p.isHost ? '<small style="color:#e74c3c">房主</small>' : ''}
                `;
                
                if(p.id === myId && !p.isHost) {
                    const btn = document.getElementById('btn-ready');
                    // 這裡只處理準備按鈕文字，離開按鈕是獨立的
                    btn.innerText = p.isReady ? "取消準備" : "準備";
                    btn.className = p.isReady ? "btn danger" : "btn secondary";
                }
            } else {
                slot.innerHTML = `<div style="color:#bdc3c7;">空位</div>`;
            }
            container.appendChild(slot);
        }

        if(myIsHost) {
            const btnStart = document.getElementById('btn-start');
            if (players.length >= 3 && allReady) {
                btnStart.disabled = false;
                btnStart.innerText = "開始遊戲";
                btnStart.classList.remove('disabled-btn');
            } else {
                btnStart.disabled = true;
                btnStart.classList.add('disabled-btn');
                if (players.length < 3) {
                    btnStart.innerText = `需滿3人 (${players.length}/3)`;
                } else {
                    btnStart.innerText = "等待準備中...";
                }
            }
        }
    }

    // B. 遊戲中更新
    if (!screens.game.classList.contains('hidden')) {
        renderGamePlayers(players);
    }
});

// --- 遊戲流程 ---

socket.on('gameStarted', ({ role, word }) => {
    showScreen('game');
    showOverlay(`你的詞是：${word} <br> (10秒後開始)`);
    document.getElementById('my-word').innerText = word;
    renderGamePlayers(currentPlayers);
});

socket.on('updateWord', ({ word }) => {
    document.getElementById('my-word').innerText = word;
    const wordEl = document.getElementById('my-word');
    wordEl.style.transform = "scale(1.5)";
    wordEl.style.color = "red";
    setTimeout(() => {
        wordEl.style.transform = "scale(1)";
        wordEl.style.color = "#f1c40f";
    }, 500);
});

socket.on('timerUpdate', (time) => {
    document.getElementById('game-timer').innerText = time;
});

socket.on('systemMessage', (msg) => {
    document.getElementById('status-text').innerText = msg;
});

socket.on('hideOverlay', () => {
    overlay.el.classList.add('hidden');
});

socket.on('playerTurn', ({ playerId, duration }) => {
    document.querySelectorAll('.game-player-card').forEach(card => card.classList.remove('active-turn'));
    
    const activeCard = document.getElementById(`card-${playerId}`);
    if(activeCard) activeCard.classList.add('active-turn');

    const player = currentPlayers.find(p => p.id === playerId);
    const name = player ? player.name : "某人";
    
    const btnSkip = document.getElementById('btn-skip');

    if (playerId === myId) {
        document.getElementById('status-text').innerText = `輪到你了！請發言...`;
        document.getElementById('status-text').style.color = "#f1c40f"; 
        btnSkip.classList.remove('hidden'); 
    } else {
        document.getElementById('status-text').innerText = `目前是 ${name} 發言中...`;
        document.getElementById('status-text').style.color = "#ecf0f1"; 
        btnSkip.classList.add('hidden'); 
    }
});

socket.on('startVoting', ({ alivePlayers }) => {
    isVoteMode = true;
    document.getElementById('vote-area').classList.remove('hidden');
    document.getElementById('btn-skip').classList.add('hidden'); 
    
    document.querySelectorAll('.game-player-card').forEach(card => card.classList.remove('active-turn'));
    
    alivePlayers.forEach(p => {
        if(p.id !== myId) {
            const card = document.getElementById(`card-${p.id}`);
            if(card) card.classList.add('vote-mode');
        }
    });
});

socket.on('showResult', ({ msg, duration }) => {
    isVoteMode = false;
    document.getElementById('vote-area').classList.add('hidden');
    document.getElementById('btn-skip').classList.add('hidden');
    document.querySelectorAll('.game-player-card').forEach(c => c.classList.remove('vote-mode'));
    showOverlay("本輪結果", msg);
    setTimeout(() => { overlay.el.classList.add('hidden'); }, duration * 1000);
});

socket.on('gameReset', () => {
    showScreen('lobby');
    overlay.el.classList.add('hidden');
});

socket.on('roomDisbanded', () => {
    alert("房間已解散");
    location.reload();
});
socket.on('errorMessage', alert);

// --- 輔助函數 ---
function showScreen(name) {
    Object.values(screens).forEach(el => el.classList.add('hidden'));
    screens[name].classList.remove('hidden');
}

function showOverlay(title, msg) {
    overlay.title.innerText = title;
    overlay.msg.innerHTML = msg;
    overlay.el.classList.remove('hidden');
}

function renderGamePlayers(players) {
    const container = document.getElementById('game-players-container');
    container.innerHTML = '';
    
    players.forEach(p => {
        const div = document.createElement('div');
        div.id = `card-${p.id}`;
        div.className = `game-player-card ${p.isAlive ? '' : 'dead'}`;
        
        const nameColor = (p.id === myId) ? 'color: #1e3799; font-weight: 900;' : ''; 

        div.innerHTML = `
            <div style="font-size:2.5rem;">👤</div>
            <div style="font-weight:bold; font-size:1.2rem; ${nameColor}">${p.name}</div>
        `;
        
        div.addEventListener('click', () => {
            const me = currentPlayers.find(player => player.id === myId);

            if (isVoteMode) {
                if (!me || !me.isAlive) {
                    alert("你已淘汰，無法投票！");
                    return;
                }
                if (!p.isAlive) {
                    alert("無法投給已淘汰的玩家！");
                    return;
                }
                if (p.id === myId) return;

                if(confirm(`確定要投給 ${p.name} 嗎？`)) {
                    socket.emit('votePlayer', { roomId: currentRoomId, targetId: p.id });
                    document.getElementById('status-text').innerText = "已投票，等待其他人...";
                    isVoteMode = false; 
                    document.querySelectorAll('.game-player-card').forEach(c => c.classList.remove('vote-mode'));
                }
            }
        });
        container.appendChild(div);
    });
}

// 音樂控制
const bgm = document.getElementById('bgm');
const musicBtn = document.getElementById('music-toggle');
const musicIcon = document.getElementById('music-icon');
const musicText = document.getElementById('music-text');

bgm.volume = 0.04; 

musicBtn.addEventListener('click', (e) => {
    e.stopPropagation(); 
    if (bgm.paused) {
        bgm.play().then(() => {
            updateMusicUI(false);
        }).catch(err => console.log("播放失敗", err));
    } else {
        bgm.muted = !bgm.muted;
        updateMusicUI(bgm.muted);
    }
});

function updateMusicUI(isMuted) {
    if (isMuted) {
        musicIcon.innerText = "🔇";
        musicText.innerText = "靜音";
        musicBtn.classList.add('muted');
    } else {
        musicIcon.innerText = "🎵";
        musicText.innerText = "播放中";
        musicBtn.classList.remove('muted');
    }
}

function tryPlayMusic() {
    if(bgm.paused) {
        bgm.play().then(() => {
            updateMusicUI(false);
        }).catch(e => console.log("等待互動"));
    }
}
document.body.addEventListener('click', tryPlayMusic, { once: true });