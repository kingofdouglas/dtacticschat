const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// 1. 미들웨어 설정 (순서 중요!)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 2. 환경 변수 및 DB 연결
const adminEnv = process.env.ADMIN_IDS || '';
const ADMIN_IDS = adminEnv ? adminEnv.split(',').map(id => id.trim()) : [];
const ADMIN_PW = process.env.ADMIN_PASSWORD || '1234';

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ DB 연결 성공'))
    .catch(err => console.error('❌ DB 연결 실패:', err));

// DB 모델
const Report = mongoose.model('Report', new mongoose.Schema({
    targetNick: String, targetId: String, targetIp: String,
    reporter: String, date: { type: Date, default: Date.now }
}));

const Ban = mongoose.model('Ban', new mongoose.Schema({
    ip: String, id: String, nick: String,
    reason: String, date: { type: Date, default: Date.now }
}));

// 3. 변수 관리
let chatHistory = [];
const connectedUsers = {};
const mutedIds = new Set(); // 서버 메모리에 유지 (재시작 시 초기화됨)

// 4. 보안 미들웨어
const adminAuth = (req, res, next) => {
    const clientPw = req.query.pw || req.body.pw;
    if (clientPw === ADMIN_PW) {
        next();
    } else {
        res.status(403).json({ error: "접근 권한이 없습니다." });
    }
};

// 5. API 및 라우팅
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

app.get('/admin', (req, res) => {
    const clientPw = req.query.pw;
    if (clientPw === ADMIN_PW) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.status(403).send(`
            <script>
                const pw = prompt("관리자 비밀번호를 입력하세요.");
                if(pw) location.href = "/admin?pw=" + pw;
                else location.href = "/";
            </script>
        `);
    }
});

// 관리자용 데이터 API (보안 적용)
app.get('/api/admin/reports', adminAuth, async (req, res) => {
    const reports = await Report.find().sort({ date: -1 });
    res.json(reports);
});

app.get('/api/admin/bans', adminAuth, async (req, res) => {
    const bans = await Ban.find().sort({ date: -1 });
    res.json(bans);
});

// Mute 목록 확인 API 추가
app.get('/api/admin/mutes', adminAuth, (req, res) => {
    res.json(Array.from(mutedIds)); 
});

app.post('/api/admin/ban', adminAuth, async (req, res) => {
    const { ip, id, nick, reason } = req.body;
    await Ban.create({ ip, id, nick, reason });
    res.json({ success: true });
});

app.delete('/api/admin/ban/:id', adminAuth, async (req, res) => {
    await Ban.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.get('/api/emoticons', (req, res) => {
    const emoticonsDir = path.join(__dirname, 'public', 'emoticons');
    fs.readdir(emoticonsDir, (err, files) => {
        if (err) { res.status(500).send([]); return; }
        const imageFiles = files.filter(file => /\.(png|jpe?g|gif)$/i.test(file));
        res.json(imageFiles);
    });
});

// 6. 소켓 로직
const getUserListWithAdminStatus = () => {
    return Object.values(connectedUsers).map(u => ({
        ...u, isAdmin: ADMIN_IDS.includes(u.id)
    }));
};

io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // 접속 시 IP 차단 체크
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
        if (ADMIN_IDS.includes(userData.id)) socket.emit('admin auth', true);
        if (chatHistory.length > 0) socket.emit('chat history', chatHistory);
        io.emit('user list', getUserListWithAdminStatus());
    });

    socket.on('chat message', (data) => {
        if (data.user.id === 'guest') return socket.emit('system message', '게스트는 채팅을 할 수 없습니다.');
        
        // Mute 체크
        if (mutedIds.has(data.user.id)) {
            return socket.emit('system message', '관리자에 의해 채팅이 금지된 상태입니다.');
        }

        const msgData = { ...data, timestamp: Date.now() };
        chatHistory.push(msgData);
        if (chatHistory.length > 30) chatHistory.shift();
        io.emit('chat message', msgData);
    });

    socket.on('report user', async (target) => {
        const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === target.id);
        const targetIp = targetSocket ? (targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address) : 'Unknown';

        await Report.create({
            targetNick: target.nick,
            targetId: target.id,
            targetIp: targetIp,
            reporter: socket.user ? socket.user.nick : 'Unknown'
        });
        socket.emit('system message', `[알림] ${target.nick}님 신고가 접수되었습니다.`);
    });

    // 관리자 전용 실시간 제어 (Mute 등)
    socket.on('mute user', (targetId) => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            mutedIds.add(targetId);
            io.emit('system message', `알림: 일부 사용자의 채팅이 제한되었습니다.`);
        }
    });

    socket.on('unmute user', (targetId) => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            mutedIds.delete(targetId);
        }
    });

    // ... (귓속말, 호출, clear chat 등 나머지 기존 소켓 코드는 여기에 그대로 유지)

    socket.on('disconnect', () => {
        if (connectedUsers[socket.id]) {
            delete connectedUsers[socket.id];
            io.emit('user list', getUserListWithAdminStatus());
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 실행 중: ${PORT}`); });
