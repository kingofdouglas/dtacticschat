const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// 1. 미들웨어 설정
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 2. 환경 변수 및 보안 설정
const adminEnv = process.env.ADMIN_IDS || '';
const ADMIN_IDS = adminEnv ? adminEnv.split(',').map(id => id.trim()) : [];
const ADMIN_PW = process.env.ADMIN_PASSWORD || '1234';

// 3. MongoDB 연결
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ DB 연결 성공'))
    .catch(err => console.error('❌ DB 연결 실패:', err));

// DB 스키마 정의
const Report = mongoose.model('Report', new mongoose.Schema({
    targetNick: String, targetId: String, targetIp: String,
    reporter: String, date: { type: Date, default: Date.now }
}));

const Ban = mongoose.model('Ban', new mongoose.Schema({
    ip: String, id: String, nick: String,
    reason: String, date: { type: Date, default: Date.now }
}));

// 4. 서버 내부 변수
let chatHistory = [];
const connectedUsers = {};
const mutedIds = new Set(); // Mute는 서버 메모리에서 관리 (서버 재시작 시 초기화)

// 5. 유틸리티 함수
const getUserListWithAdminStatus = () => {
    return Object.values(connectedUsers).map(u => ({
        ...u, isAdmin: ADMIN_IDS.includes(u.id)
    }));
};

// 6. 보안 미들웨어 (관리자 API용)
const adminAuth = (req, res, next) => {
    const clientPw = req.query.pw || req.body.pw;
    if (clientPw === ADMIN_PW) {
        next();
    } else {
        res.status(403).json({ error: "접근 권한이 없습니다." });
    }
};

// ------------------------------------------------------------------
// 7. HTTP 경로 (Route) 설정
// ------------------------------------------------------------------

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// 관리자 페이지 접속 (비밀번호 확인 루프 포함)
app.get('/admin', (req, res) => {
    if (req.query.pw === ADMIN_PW) {
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

// 관리자 API 전용
app.get('/api/admin/reports', adminAuth, async (req, res) => {
    const reports = await Report.find().sort({ date: -1 });
    res.json(reports);
});

app.get('/api/admin/bans', adminAuth, async (req, res) => {
    const bans = await Ban.find().sort({ date: -1 });
    res.json(bans);
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

// 이모티콘 목록 불러오기
app.get('/api/emoticons', (req, res) => {
    const emoticonsDir = path.join(__dirname, 'public', 'emoticons');
    fs.readdir(emoticonsDir, (err, files) => {
        if (err) { res.status(500).send([]); return; }
        const imageFiles = files.filter(file => /\.(png|jpe?g|gif)$/i.test(file));
        res.json(imageFiles);
    });
});

// ------------------------------------------------------------------
// 8. 실시간 소켓 로직 (Socket.io)
// ------------------------------------------------------------------

io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // A. 접속 시 즉시 IP 차단 체크
    try {
        const isBanned = await Ban.findOne({ ip: clientIp });
        if (isBanned) {
            socket.emit('system message', `차단된 IP입니다. (사유: ${isBanned.reason})`);
            return socket.disconnect();
        }
    } catch (err) { console.error("Ban check error:", err); }

    // B. 유저 입장
    socket.on('join', (userData) => {
        socket.user = userData;
        connectedUsers[socket.id] = userData;
        
        if (ADMIN_IDS.includes(userData.id)) {
            socket.emit('admin auth', true);
        }

        if (chatHistory.length > 0) socket.emit('chat history', chatHistory);
        io.emit('user list', getUserListWithAdminStatus());
    });

    // C. 일반 채팅 (게스트/뮤트 체크 포함)
    socket.on('chat message', (data) => {
        if (data.user.id === 'guest') {
            return socket.emit('system message', '게스트는 채팅을 할 수 없습니다.');
        }

        if (mutedIds.has(data.user.id)) {
            return socket.emit('system message', '관리자에 의해 채팅이 금지된 상태입니다.');
        }

        const msgData = { 
            type: data.type, 
            user: data.user, 
            content: data.content, 
            timestamp: Date.now() 
        };
        
        chatHistory.push(msgData);
        if (chatHistory.length > 30) chatHistory.shift();
        io.emit('chat message', msgData);
    });

    // D. 신고 접수 (DB 저장)
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

    // E. 귓속말
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

    // F. 호출
    socket.on('call user', (data) => {
        let targetSocketId = Object.keys(connectedUsers).find(sid => connectedUsers[sid].nick === data.targetNick);
        if (targetSocketId) {
            io.to(targetSocketId).emit('call alert', { sender: data.sender });
            socket.emit('system message', `[안내] ${data.targetNick}님을 호출했습니다.`);
        } else {
            socket.emit('system message', '[안내] 접속 중인 유저가 아닙니다.');
        }
    });

    // G. 관리자 전용 제어 (Mute, Clear)
    socket.on('mute user', (targetId) => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            mutedIds.add(targetId);
            socket.emit('system message', `[관리] 해당 유저(${targetId})를 뮤트했습니다.`);
        }
    });

    socket.on('unmute user', (targetId) => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            mutedIds.delete(targetId);
            socket.emit('system message', `[관리] 해당 유저의 뮤트를 해제했습니다.`);
        }
    });

    socket.on('clear chat', () => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            chatHistory = [];
            io.emit('clear chat');
        }
    });

    // H. 접속 종료
    socket.on('disconnect', () => {
        if (connectedUsers[socket.id]) {
            delete connectedUsers[socket.id];
            io.emit('user list', getUserListWithAdminStatus());
        }
    });
});

// 서버 실행
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`🚀 서버 실행 중: ${PORT}`); });
