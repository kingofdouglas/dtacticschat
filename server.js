const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

// 접속 중인 유저 정보를 담아둘 공간
const connectedUsers = {};

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    // 1. 유저가 처음 들어와서 자기 정보를 보낼 때
    socket.on('join', (userData) => {
        // 소켓 ID를 키값으로 유저 정보(닉네임, 아이디, 아이콘) 저장
        connectedUsers[socket.id] = userData;
        // 전체 방에 갱신된 접속자 목록 전송
        io.emit('user list', Object.values(connectedUsers));
    });

    // 2. 메시지를 보냈을 때
    socket.on('chat message', (data) => {
        io.emit('chat message', data);
    });

    // 3. 유저가 나갔을 때 (창을 닫거나 새로고침 시)
    socket.on('disconnect', () => {
        if (connectedUsers[socket.id]) {
            delete connectedUsers[socket.id]; // 명단에서 삭제
            io.emit('user list', Object.values(connectedUsers)); // 갱신된 명단 다시 전송
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`);
});
