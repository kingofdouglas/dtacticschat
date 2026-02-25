const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');

let chatHistory = [];
const connectedUsers = {};
const mutedIds = new Set();
const ADMIN_IDS = ['dirtyass', 'dirtyass2', 'master']; 

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
        if (chatHistory.length > 0) socket.emit('chat history', chatHistory);
        io.emit('system message', `${userData.nick}님이 입장하셨습니다.`);
        io.emit('user list', Object.values(connectedUsers));
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

    // ★ [신규] 호출 기능 처리
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
            const nick = connectedUsers[socket.id].nick;
            delete connectedUsers[socket.id];
            io.emit('system message', `${nick}님이 퇴장하셨습니다.`);
            io.emit('user list', Object.values(connectedUsers));
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 실행 중: ${PORT}`); });
