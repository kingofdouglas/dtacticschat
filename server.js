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

// DB 스키마 채팅내역
const Chat = mongoose.model('Chat', new mongoose.Schema({
    type: String, // 'text' 또는 'image'
    user: Object, // { id, nick, icon }
    content: String,
    timestamp: { type: Date, default: Date.now, expires: 2592000 }
}));

const quitUsers = new Map();

const connectedUsers = {};
// 뮤트 관리를 Set에서 Object로 변경 (ID: {nick, date} 형태)
let mutedUsers = {}; 

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
// 7. HTTP 경로 (Route) 및 관리자 API
// ------------------------------------------------------------------

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

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

// [API] 신고 내역 조회
app.get('/api/admin/reports', adminAuth, async (req, res) => {
    const reports = await Report.find().sort({ date: -1 });
    res.json(reports);
});

// [API] 신고 내역 기각(삭제)
app.delete('/api/admin/report/:id', adminAuth, async (req, res) => {
    await Report.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// [API] 밴 목록 조회
app.get('/api/admin/bans', adminAuth, async (req, res) => {
    let bans = await Ban.find().sort({ date: -1 }).lean();
    bans = bans.map(ban => ({
        ...ban,
        ip: ban.ip.includes(',') ? ban.ip.split(',')[0].trim() : ban.ip
    }));
    
    res.json(bans);
});

// [API] 밴 실행
app.post('/api/admin/ban', adminAuth, async (req, res) => {
    const { ip, id, nick, reason } = req.body;
    await Ban.create({ ip, id, nick, reason });
    
    // 현재 접속자 중 해당 IP를 쓰는 소켓들 다 찾아내서 쫓아내기
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
        let sIp = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
        if (sIp.includes(ip)) {
            s.emit('system message', '관리자에 의해 차단되었습니다.');
            s.disconnect();
        }
    }
    res.json({ success: true });
});

// [API] 밴 해제
app.delete('/api/admin/ban/:id', adminAuth, async (req, res) => {
    await Ban.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// [API] 실시간 뮤트 목록 조회 (Set 대신 객체 사용)
app.get('/api/admin/mutes', adminAuth, (req, res) => {
    const muteList = Object.keys(mutedUsers).map(id => ({
        id: id,
        nick: mutedUsers[id].nick,
        date: mutedUsers[id].date
    }));
    res.json(muteList);
});

// [API] 뮤트 해제
app.delete('/api/admin/mute/:id', adminAuth, (req, res) => {
    const targetId = req.params.id;
    if (mutedUsers[targetId]) {
        delete mutedUsers[targetId];
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "대상자를 찾을 수 없습니다." });
    }
});

// 이모티콘 목록
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
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

    try {
        const isBanned = await Ban.findOne({ ip: clientIp });
        if (isBanned) {
            socket.emit('system message', `차단된 IP입니다. (사유: ${isBanned.reason})`);
            socket.emit('banned user', {reason: isBanned.reason,date: isBanned.date});
            socket.disconnect(true); // true를 넣어 강제 종료
            return; // 이후 로직 실행 방지
        }
    } catch (err) { console.error("Ban check error:", err); }
    
    // B. 유저 입장 (수정본)
    socket.on('join', (userData) => {
        // 1. 중복 닉네임 처리 로직 추가
        let finalNick = userData.nick;
        const currentUsers = Object.values(connectedUsers);
        
        // 동일 ID 혹은 동일 IP를 사용하는 유저 수 계산
        const duplicates = currentUsers.filter(u => 
            u.id === userData.id || u.ip === clientIp
        ).length;
    
        if (duplicates > 0) {
            finalNick = `${userData.nick} (${duplicates})`;
        }
    
        // 최종 유저 정보 저장 (ip 포함)
        const finalUserData = { ...userData, nick: finalNick, ip: clientIp };
        
        socket.user = finalUserData;
        connectedUsers[socket.id] = finalUserData;
        
        if (ADMIN_IDS.includes(userData.id)) {
            socket.emit('admin auth', true);
        }
    
        Chat.find().sort({ timestamp: -1 }).limit(50).then(history => {
        if (history.length > 0) {
            // 최신 글이 밑으로 가야 하므로 배열을 뒤집어서(reverse) 클라이언트에 전달
            socket.emit('chat history', history.reverse()); 
        }
        }).catch(err => console.error("채팅 로딩 에러:", err));
        
        io.emit('user list', getUserListWithAdminStatus());
        });

        // C. 일반 채팅 (DB 연동 버전)
        socket.on('chat message', async (data) => {
            if (data.user.id === 'guest') {
                return socket.emit('system message', '게스트는 채팅을 할 수 없습니다.');
            }
    
            if (mutedUsers[data.user.id]) {
                return socket.emit('system message', '관리자에 의해 채팅이 금지된 상태입니다.');
            }
    
            const msgData = { 
                type: data.type, 
                user: data.user, 
                content: data.content, 
                timestamp: Date.now() 
            };
            
            // 1. DB에 저장
            try {
                await Chat.create(msgData);
            } catch (err) {
                console.error("채팅 저장 에러:", err);
            }
    
            // 2. 접속 중인 모두에게 전송
            io.emit('chat message', msgData);
        });                        

    

   // D. 신고 접수 부분
    socket.on('report user', async (target) => {
        const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === target.id);
        
        // 수정: rawIp에서 첫 번째 IP만 추출
        let rawIp = targetSocket ? (targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address) : 'Unknown';
        const targetIp = rawIp.includes(',') ? rawIp.split(',')[0].trim() : rawIp;
    
        const newReport = new Report({
            targetNick: target.nick,
            targetId: target.id,
            targetIp: targetIp, // 이제 깔끔한 IP가 저장됨
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

    // G. 관리자 전용 제어 (Mute 수정본)
socket.on('mute user', (target) => { 
    if (ADMIN_IDS.includes(socket.user?.id)) {
        let targetId, targetNick;

        // target이 객체 {id, nick}인 경우
        if (target && typeof target === 'object') {
            targetId = target.id;
            targetNick = target.nick;
        } 
        // target이 단순 ID 문자열인 경우 (구형 방식 대응)
        else {
            targetId = target;
            const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
            targetNick = targetSocket ? targetSocket.user.nick : targetId;
        }

        if (!targetId) return;

        mutedUsers[targetId] = {
            nick: targetNick || 'Unknown',
            date: new Date()
        };
        socket.emit('system message', `[관리] ${targetNick}님을 뮤트했습니다.`);
    }
});

    socket.on('unmute user', (targetId) => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            delete mutedUsers[targetId];
            socket.emit('system message', `[관리] 해당 유저의 뮤트를 해제했습니다.`);
        }
    });
        socket.on('get ip for ban', (targetId) => {
    if (ADMIN_IDS.includes(socket.user?.id)) {
        // 1. 현재 접속자 확인
        const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
        
        let targetIp = null;
        let targetNick = targetId;

        if (targetSocket) {
            let rawIp = targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address;
            targetIp = rawIp.includes(',') ? rawIp.split(',')[0].trim() : rawIp;
            targetNick = targetSocket.user.nick;
        } else {
            // 2. 접속자가 없으면 퇴장 유저 목록(quitUsers)에서 가져오기
            targetIp = quitUsers.get(targetId);
            targetNick = targetId + " (퇴장)"; // 닉네임 대신 ID에 퇴장 표시
        }

        if (targetIp) {
            socket.emit('open ban page', {
                ip: targetIp,
                id: targetId,
                nick: targetNick
            });
        } else {
            socket.emit('system message', "[오류] 퇴장한 지 너무 오래되어 IP 정보를 찾을 수 없습니다.");
        }
    }
});
    socket.on('get user ip', (targetId) => {
    if (ADMIN_IDS.includes(socket.user?.id)) {
        // 1. 현재 접속자 확인
        const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
        
        let targetIp = null;
        let targetNick = targetId;

        if (targetSocket) {
            let rawIp = targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address;
            targetIp = rawIp.includes(',') ? rawIp.split(',')[0].trim() : rawIp;
            targetNick = targetSocket.user.nick;
        } else {
            // 2. 접속자가 없으면 퇴장 유저 목록에서 확인
            targetIp = quitUsers.get(targetId);
        }

        if (targetIp) {
            socket.emit('system message', `[보안] ${targetNick}님의 IP: ${targetIp}${targetSocket ? '' : ' (퇴장한 유저)'}`);
        } else {
            socket.emit('system message', `[오류] 대상 유저 정보를 찾을 수 없습니다.`);
        }
    }
});
   // 전체 청소 기능 (DB에서도 삭제)
    socket.on('clear chat', async () => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            await Chat.deleteMany({}); // DB 채팅 내역 전부 삭제
            io.emit('clear chat');     // 화면 청소
        }
    });
    // H. 접속 종료
    socket.on('disconnect', () => {
    if (socket.id && connectedUsers[socket.id]) {
        const u = connectedUsers[socket.id];
        // 퇴장 시 IP 정보를 10분간 보관 (ID를 키로 저장)
        quitUsers.set(u.id, u.ip);
        setTimeout(() => quitUsers.delete(u.id), 86400000); 

        delete connectedUsers[socket.id];
        io.emit('user list', getUserListWithAdminStatus());
    }
});
    
});
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`🚀 서버 실행 중: ${PORT}`); });
