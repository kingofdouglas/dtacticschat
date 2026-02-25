const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// 미들웨어 설정
app.use(express.json()); // 관리자 기능을 위한 JSON 파싱
app.use(express.static(path.join(__dirname, 'public')));

// --- [환경 변수 설정] ---
const adminEnv = process.env.ADMIN_IDS || '';
const ADMIN_IDS = adminEnv ? adminEnv.split(',').map(id => id.trim()) : [];

// --- [MongoDB 연결] ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ DB 연결 성공'))
    .catch(err => console.error('❌ DB 연결 실패:', err));

const Report = mongoose.model('Report', new mongoose.Schema({
    targetNick: String, targetId: String, targetIp: String,
    reporter: String, date: { type: Date, default: Date.now }
}));

const Ban = mongoose.model('Ban', new mongoose.Schema({
    ip: String, id: String, nick: String,
    reason: String, date: { type: Date, default: Date.now }
}));

// --- [변수 및 도우미 함수] ---
let chatHistory = [];
const connectedUsers = {};
const mutedIds = new Set();

const getUserListWithAdminStatus = () => {
    return Object.values(connectedUsers).map(u => ({
        ...u,
        isAdmin: ADMIN_IDS.includes(u.id)
    }));
};

// --- [API 경로] ---
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// 관리자 페이지 (나중에 admin.html 만드시면 됩니다)
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// 신고 목록 가져오기 API (관리자용)
app.get('/api/admin/reports', async (req, res) => {
    try {
        const reports = await Report.find().sort({ date: -1 });
        res.json(reports);
    } catch (e) { res.status(500).send(e); }
});

app.get('/api/emoticons', (req, res) => {
    const emoticonsDir = path.join(__dirname, 'public', 'emoticons');
    fs.readdir(emoticonsDir, (err, files) => {
        if (err) { res.status(500).send([]); return; }
        const imageFiles = files.filter(file => /\.(png|jpe?g|gif)$/i.test(file));
        res.json(imageFiles);
    });
});

// --- [Socket.io 로직] ---
io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // 1. 접속 시 IP 차단 체크 (await 사용을 위해 async 필수)
    try {
        const isBanned = await Ban.findOne({ ip: clientIp });
        if (isBanned) {
            socket.emit('system message', `차단된 IP입니다. (사유: ${isBanned.reason})`);
            return socket.disconnect();
        }
    } catch (err) { console.error("Ban check error:", err); }

    socket.on('join', (userData) => {
        socket.user = userData;
        connectedUsers[socket.id] = userData;
        
        if (ADMIN_IDS.includes(userData.id)) {
            socket.emit('admin auth', true);
        }

        if (chatHistory.length > 0) socket.emit('chat history', chatHistory);
        io.emit('user list', getUserListWithAdminStatus());
    });

    // 2. 통합된 채팅 메시지 핸들러 (게스트 차단 + 뮤트 체크 + 히스토리)
    socket.on('chat message', (data) => {
        if (data.user.id === 'guest') {
            return socket.emit('system message', '게스트는 채팅을 할 수 없습니다.');
        }

        const senderId = connectedUsers[socket.id]?.id;
        if (mutedIds.has(senderId)) {
            return socket.emit('system message', '관리자에 의해 채팅이 금지된 상태입니다.');
        }

        const msgData = { 
            type: data.type, 
            user: data.user, 
            content: data.content, 
            timestamp: Date.now() 
        };
        
        chatHistory.push(msgData);
        if (chatHistory.length > 30) chatHistory.shift(); // 히스토리 개수 약간 늘림
        io.emit('chat message', msgData);
    });

    // 3. 신고 접수 로직
    socket.on('report user', async (target) => {
        const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === target.id);
        const targetIp = targetSocket ? (targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address) : 'Unknown';

        const newReport = new Report({
            targetNick: target.nick,
            targetId: target.id,
            targetIp: targetIp,
            reporter: socket.user ? socket.user.nick : 'Unknown'
        });
        await newReport.save();
        socket.emit('system message', `[알림] ${target.nick}님에 대한 신고가 접수되었습니다.`);
    });

    // --- [기타 기능: 귓속말, 호출, 뮤트 등] ---
    socket.on('whisper', (data) => {
        let targetSocketId = Object.keys(connectedUsers).find(sid => connectedUsers[sid].nick === data.targetNick);
        if (targetSocketId) {
            const whisperData = { ...data, timestamp: Date.now() };
            io.to(targetSocketId).emit('whisper', whisperData);
            socket.emit('whisper', whisperData); 
        } else {
            socket.emit('system message', '현재 접속해 있지 않은 유저입니다.');
        }
    });

    socket.on('call user', (data) => {
        let targetSocketId = Object.keys(connectedUsers).find(sid => connectedUsers[sid].nick === data.targetNick);
        if (targetSocketId) {
            io.to(targetSocketId).emit('call alert', { sender: data.sender });
            socket.emit('system message', `[안내] ${data.targetNick}님을 호출했습니다.`);
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
            io.emit('user list', getUserListWithAdminStatus());
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 실행 중: ${PORT}`); });
