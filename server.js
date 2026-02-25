const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 최근 메시지 저장용 배열
let chatHistory = []; 
const MAX_HISTORY = 10;

app.use(express.static('public'));

app.get('/api/emoticons', (req, res) => {
    const emoPath = path.join(__dirname, 'public', 'emoticons');
    fs.readdir(emoPath, (err, files) => {
        if (err) return res.status(500).json([]);
        const images = files.filter(f => /\.(png|jpg|gif|jpeg)$/i.test(f));
        res.json(images);
    });
});

let users = [];

io.on('connection', (socket) => {
    socket.on('join', (userInfo) => {
        socket.user = userInfo;
        users.push(userInfo);

        // [추가] 입장한 유저에게만 이전 대화 기록 전송
        if (chatHistory.length > 0) {
            socket.emit('chat history', chatHistory);
        }

        io.emit('system message', `${userInfo.nick}님이 입장하셨습니다.`);
        io.emit('user list', users);
    });

    socket.on('chat message', (data) => {
        // 메시지에 타임스탬프 추가 및 기록 저장
        const msgData = {
            ...data,
            timestamp: Date.now()
        };

        chatHistory.push(msgData);
        if (chatHistory.length > MAX_HISTORY) chatHistory.shift();

        io.emit('chat message', msgData);
    });

    socket.on('whisper', (data) => {
        const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.nick === data.targetNick);
        if (targetSocket) {
            targetSocket.emit('whisper', data);
            socket.emit('whisper', data);
        } else {
            socket.emit('system message', '해당 사용자를 찾을 수 없습니다.');
        }
    });

    socket.on('clear chat', () => {
        chatHistory = []; // 기록 삭제
        io.emit('clear chat');
    });

    socket.on('disconnect', () => {
        if (socket.user) {
            users = users.filter(u => u.nick !== socket.user.nick);
            io.emit('system message', `${socket.user.nick}님이 퇴장하셨습니다.`);
            io.emit('user list', users);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
