const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');

let chatHistory = [];

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

    // ★ 관리자 기능 (채팅 금지, 해제, 지우기)
    socket.on('mute user', (targetId) => {
        if (connectedUsers[socket.id]?.id === ADMIN_ID) {
            mutedIds.add(targetId);
            socket.emit('system message', `해당 유저의 채팅을 금지했습니다.`);
        }
    });

    socket.on('unmute user', (targetId) => {
        if (connectedUsers[socket.id]?.id === ADMIN_ID) {
            mutedIds.delete(targetId);
            socket.emit('system message', `해당 유저의 채팅 금지를 해제했습니다.`);
        }
    });

    socket.on('clear chat', () => {
        if (connectedUsers[socket.id]?.id === ADMIN_ID) {
            io.emit('clear chat'); // 접속한 모든 사람의 채팅창을 지움
        }
    });

    socket.on('disconnect', () => {
        if (connectedUsers[socket.id]) {
            delete connectedUsers[socket.id];
            io.emit('user list', Object.values(connectedUsers));
        }
    });
});

// 접속시 채팅기록
io.on('connection', (socket) => {
    // 유저가 접속(join)했을 때
    socket.on('join', (user) => {
        socket.user = user;
        
        // [추가] 새로 들어온 유저에게만 이전 기록 10개를 전송
        if (chatHistory.length > 0) {
            socket.emit('chat history', chatHistory);
        }

        io.emit('system message', `${user.nick}님이 입장하셨습니다.`);
        updateUserList();
    });

    socket.on('chat message', (data) => {
        // 메시지 데이터 저장
        const msgData = {
            type: data.type,
            user: data.user,
            content: data.content,
            timestamp: Date.now()
        };

        // 기록 배열에 추가하고 10개만 남기기
        chatHistory.push(msgData);
        if (chatHistory.length > 10) {
            chatHistory.shift(); // 제일 오래된 첫 번째 요소 삭제
        }

        io.emit('chat message', data);
    });

    // 관리자가 채팅 청소할 때 기록도 삭제
    socket.on('clear chat', () => {
        chatHistory = [];
        io.emit('clear chat');
    });
});
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`);
});
