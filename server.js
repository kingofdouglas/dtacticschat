const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');

let chatHistory = [];
const connectedUsers = {};
const mutedIds = new Set();

// ★ [보안] 환경 변수에서 관리자 아이디를 가져옵니다. 깃허브에는 노출되지 않습니다.
const adminEnv = process.env.ADMIN_IDS || '';
const ADMIN_IDS = adminEnv ? adminEnv.split(',').map(id => id.trim()) : [];

// 유저 목록에 관리자 여부(isAdmin)만 추가해서 보내는 함수
const getUserListWithAdminStatus = () => {
    return Object.values(connectedUsers).map(u => ({
        ...u,
        isAdmin: ADMIN_IDS.includes(u.id)
    }));
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

app.get('/api/emoticons', (req, res) => {
    const emoticonsDir = path.join(__dirname, 'public', 'emoticons');
    fs.readdir(emoticonsDir, (err, files) => {
        if (err) { res.status(500).send([]); return; }
        const imageFiles = files.filter(file => /\.(png|jpe?g|gif)$/i.test(file));
        res.json(imageFiles);
    });
});

io.on('connection', (socket) => {
    socket.on('join', (userData) => {
        socket.user = userData;
        connectedUsers[socket.id] = userData;
        
        // ★ [보안] 해당 유저가 관리자면 조용히 권한을 부여합니다.
        if (ADMIN_IDS.includes(userData.id)) {
            socket.emit('admin auth', true);
        }

        if (chatHistory.length > 0) socket.emit('chat history', chatHistory);
        
        // 입장 메시지 삭제됨
        io.emit('user list', getUserListWithAdminStatus());
    });

    socket.on('chat message', (data) => {
        const senderId = connectedUsers[socket.id]?.id;
        if (mutedIds.has(senderId)) {
            socket.emit('system message', '관리자에 의해 채팅이 금지된 상태입니다.');
            return;
        }
        const msgData = { type: data.type, user: data.user, content: data.content, timestamp: Date.now() };
        chatHistory.push(msgData);
        if (chatHistory.length > 10) chatHistory.shift();
        io.emit('chat message', msgData);
    });

    socket.on('whisper', (data) => {
        let targetSocketId = null;
        for (let sid in connectedUsers) {
            if (connectedUsers[sid].nick === data.targetNick) { targetSocketId = sid; break; }
        }
        if (targetSocketId) {
            const whisperData = { ...data, timestamp: Date.now() };
            io.to(targetSocketId).emit('whisper', whisperData);
            socket.emit('whisper', whisperData); 
        } else {
            socket.emit('system message', '현재 접속해 있지 않은 유저입니다.');
        }
    });

    socket.on('call user', (data) => {
        let targetSocketId = null;
        for (let sid in connectedUsers) {
            if (connectedUsers[sid].nick === data.targetNick) { targetSocketId = sid; break; }
        }
        if (targetSocketId) {
            io.to(targetSocketId).emit('call alert', { sender: data.sender });
            socket.emit('system message', `[안내] ${data.targetNick}님을 호출했습니다.`);
        } else {
            socket.emit('system message', '[안내] 접속 중인 유저가 아닙니다.');
        }
    });

    socket.on('mute user', (targetId) => {
        if (ADMIN_IDS.includes(connectedUsers[socket.id]?.id)) {
            mutedIds.add(targetId);
            socket.emit('system message', `해당 유저의 채팅을 금지했습니다.`);
        }
    });

    socket.on('unmute user', (targetId) => {
        if (ADMIN_IDS.includes(connectedUsers[socket.id]?.id)) {
            mutedIds.delete(targetId);
            socket.emit('system message', `해당 유저의 채팅 금지를 해제했습니다.`);
        }
    });

    socket.on('clear chat', () => {
        if (ADMIN_IDS.includes(connectedUsers[socket.id]?.id)) {
            chatHistory = [];
            io.emit('clear chat');
        }
    });

    socket.on('disconnect', () => {
        if (connectedUsers[socket.id]) {
            delete connectedUsers[socket.id];
            // 퇴장 메시지 삭제됨
            io.emit('user list', getUserListWithAdminStatus());
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 실행 중: ${PORT}`); });
