const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs'); // 파일 시스템 다루는 도구 추가
const path = require('path'); // 경로 다루는 도구 추가

// [중요] 'public' 폴더를 외부에서 접근 가능한 정적 폴더로 설정
app.use(express.static(path.join(__dirname, 'public')));

// 접속 중인 유저 정보를 담아둘 공간
const connectedUsers = {};

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// [신규 기능] 이모티콘 폴더의 파일 목록을 알려주는 API 주소
app.get('/api/emoticons', (req, res) => {
    const emoticonsDir = path.join(__dirname, 'public', 'emoticons');
    // 폴더를 읽어서 파일 목록을 배열로 반환
    fs.readdir(emoticonsDir, (err, files) => {
        if (err) {
            console.error("이모티콘 폴더 읽기 실패:", err);
            res.status(500).send([]);
            return;
        }
        // 이미지 파일만 골라내기 (혹시 모를 이상한 파일 제외)
        const imageFiles = files.filter(file => /\.(png|jpe?g|gif)$/i.test(file));
        res.json(imageFiles);
    });
});

io.on('connection', (socket) => {
    // 1. 유저 입장 (기존 동일)
    socket.on('join', (userData) => {
        connectedUsers[socket.id] = userData;
        io.emit('user list', Object.values(connectedUsers));
    });

    // 2. 메시지 전송 (기존 동일 - 데이터 구조는 클라이언트에서 변경 예정)
    socket.on('chat message', (data) => {
        io.emit('chat message', data);
    });

    // 3. 유저 퇴장 (기존 동일)
    socket.on('disconnect', () => {
        if (connectedUsers[socket.id]) {
            delete connectedUsers[socket.id];
            io.emit('user list', Object.values(connectedUsers));
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`);
});
