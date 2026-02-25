const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// ★ 여기에 실제 웹게임의 관리자 ID(아이디 검사용)를 적어주세요!
const ADMIN_ID = 'master'; 

const connectedUsers = {};
const mutedIds = new Set(); // 채팅이 금지된 유저 ID를 기억하는 공간

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

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
        connectedUsers[socket.id] = userData;
        io.emit('user list', Object.values(connectedUsers));
    });

    // 일반 채팅 메시지 처리
    socket.on('chat message', (data) => {
        const senderId = connectedUsers[socket.id]?.id;
        
        // 만약 보낸 사람이 금지(Mute) 명단에 있다면? -> 본인에게만 시스템 메시지 전송
        if (mutedIds.has(senderId)) {
            socket.emit('system message', '관리자에 의해 채팅이 금지된 상태입니다.');
            return;
        }
        io.emit('chat message', data);
    });

    // ★ 귓속말 기능 처리
    socket.on('whisper', (data) => {
        let targetSocketId = null;
        // 닉네임으로 대상의 소켓 ID 찾기
        for (let sid in connectedUsers) {
            if (connectedUsers[sid].nick === data.targetNick) {
                targetSocketId = sid;
                break;
            }
        }
        if (targetSocketId) {
            // 상대방과 나 자신에게 귓속말 전송
            io.to(targetSocketId).emit('whisper', data);
            socket.emit('whisper', data); 
        } else {
            socket.emit('system message', '현재 접속해 있지 않은 유저입니다.');
        }
    });

    // ★ 관리자
