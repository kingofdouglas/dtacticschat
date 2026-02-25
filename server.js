const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" } // 웹게임 서버에서 접속할 수 있게 허용
});

// index.html 파일을 메인 화면으로 보여줌
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 누군가 웹소켓으로 접속했을 때
io.on('connection', (socket) => {
    console.log('유저가 접속했습니다.');

    // 클라이언트로부터 'chat message'를 받으면
    socket.on('chat message', (data) => {
        // 접속한 '모든' 사람에게 다시 쏴줍니다.
        io.emit('chat message', data);
    });

    socket.on('disconnect', () => {
        console.log('유저가 나갔습니다.');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`);
});