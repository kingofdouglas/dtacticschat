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

// DB 스키마 채팅내역 (오프라인 귓말 지원)
const Chat = mongoose.model('Chat', new mongoose.Schema({
    type: String, 
    user: Object, 
    ip: String,   
    content: String,
    targetNick: String, 
    timestamp: { type: Date, default: Date.now, expires: 2592000 }
}));

// 개인설정 저장
const UserSetting = mongoose.model('UserSetting', new mongoose.Schema({
    id: String,
    notify: { type: Boolean, default: true },
    whisper: { type: Boolean, default: true }
}));



const quitUsers = new Map();
const connectedUsers = {};
let mutedUsers = {}; 

const getUserListWithAdminStatus = () => {
    return Object.values(connectedUsers).map(u => ({
        ...u, 
        isAdmin: u.isAdmin
    }));
};

const adminAuth = (req, res, next) => {
    const clientPw = req.query.pw || req.body.pw;
    if (clientPw === ADMIN_PW) next();
    else res.status(403).json({ error: "접근 권한이 없습니다." });
};

// 공지
const Notice = mongoose.model('Notice', new mongoose.Schema({
    content: { type: String, default: "" }
}));
let currentNotice = "";
// 서버 켜질 때 DB에서 기존 공지 불러오기
Notice.findOne().then(n => { if (n) currentNotice = n.content; }).catch(()=>{});

// --- HTTP Route ---
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

app.get('/api/admin/chats', adminAuth, async (req, res) => {
    try {
        const allChats = await Chat.find().sort({ timestamp: -1 }).limit(1000); 
        res.json(allChats);
    } catch (err) { res.status(500).json({ error: "채팅 기록 에러" }); }
});

app.get('/api/admin/reports', adminAuth, async (req, res) => {
    const reports = await Report.find().sort({ date: -1 });
    res.json(reports);
});

app.delete('/api/admin/report/:id', adminAuth, async (req, res) => {
    await Report.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.get('/api/admin/bans', adminAuth, async (req, res) => {
    let bans = await Ban.find().sort({ date: -1 }).lean();
    bans = bans.map(ban => ({ ...ban, ip: ban.ip.includes(',') ? ban.ip.split(',')[0].trim() : ban.ip }));
    res.json(bans);
});

app.post('/api/admin/ban', adminAuth, async (req, res) => {
    const { ip, id, nick, reason } = req.body;
    await Ban.create({ ip, id, nick, reason });
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

app.delete('/api/admin/ban/:id', adminAuth, async (req, res) => {
    await Ban.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.get('/api/admin/mutes', adminAuth, (req, res) => {
    const muteList = Object.keys(mutedUsers).map(id => ({
        id: id, nick: mutedUsers[id].nick, date: mutedUsers[id].date
    }));
    res.json(muteList);
});

app.post('/api/admin/mute', adminAuth, (req, res) => {
    const { id, nick } = req.body;
    mutedUsers[id] = { nick: nick || 'Unknown', date: new Date() };
    io.emit('system message', `[관리] ${nick}님을 뮤트했습니다.`);
    res.json({ success: true });
});

app.delete('/api/admin/mute/:id', adminAuth, (req, res) => {
    const targetId = req.params.id;
    if (mutedUsers[targetId]) {
        delete mutedUsers[targetId];
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "대상자를 찾을 수 없습니다." });
    }
});

// 공지
app.get('/api/admin/notice', adminAuth, (req, res) => {
    res.json({ notice: currentNotice });
});
app.post('/api/admin/notice', adminAuth, async (req, res) => {
    currentNotice = req.body.notice || "";
    await Notice.findOneAndUpdate({}, { content: currentNotice }, { upsert: true });
    if (currentNotice) io.emit('notice message', currentNotice);
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

// --- Socket.io ---
io.on('connection', async (socket) => {
    
    // IP 처리 로직
    let clientIp = socket.handshake.headers['x-forwarded-for'] || 
                   socket.handshake.headers['x-real-ip'] || 
                   socket.handshake.address || 
                   "unknown";
                   
    if (typeof clientIp === 'string' && clientIp.includes(',')) {
        clientIp = clientIp.split(',')[0].trim();
    }

    try {
        const isBanned = await Ban.findOne({ ip: clientIp });
        if (isBanned) {
            socket.emit('system message', `차단된 IP입니다. (사유: ${isBanned.reason})`);
            socket.emit('banned user', {reason: isBanned.reason,date: isBanned.date});
            socket.disconnect(true);
            return;
        }
    } catch (err) {}
    
socket.on('join', async (userData) => { 
        // 1. 보안 검증 (기존 동일)
        const providedAid = userData.aid ? userData.aid.trim() : "";
        if (providedAid !== "" && !ADMIN_IDS.includes(providedAid)) {
            socket.emit('system message', '⚠️ 잘못된 접근 입니다.');
            socket.disconnect();
            return; 
        }

        const isAdminUser = providedAid !== "" && ADMIN_IDS.includes(providedAid);
        const existingSocketId = Object.keys(connectedUsers).find(sid => connectedUsers[sid].id === userData.id);
        
        if (existingSocketId && existingSocketId !== socket.id) {
            // 이전 소켓(창)에 메시지를 보내고 강제로 끊어버립니다.
            const oldSocket = io.sockets.sockets.get(existingSocketId);
            if (oldSocket) {
                oldSocket.emit('duplicate login'); 
                oldSocket.emit('system message', '⚠️ 다른 곳에서 로그인하여 연결이 끊어졌습니다.');
                oldSocket.disconnect(true);
            }
            // 접속자 목록에서 삭제하여 새 연결에 찌꺼기가 남지 않게 합니다.
            delete connectedUsers[existingSocketId];
            console.log(`[중복 접속 처리] ID: ${userData.id} 의 이전 연결을 끊었습니다.`);
        }
        let finalNick = userData.nick;
        const currentActiveUsers = Object.values(connectedUsers);
        const duplicates = currentActiveUsers.filter(u => 
            u.nick === userData.nick || 
            (u.ip === clientIp && clientIp !== "unknown" && !clientIp.startsWith("10.") && !clientIp.startsWith("127."))
        ).length;
        if (duplicates > 0) {
            finalNick = `${userData.nick}_(${duplicates})`;
        }

        // 3. 최종 유저 데이터 생성
        const finalUserData = { 
            ...userData, 
            nick: finalNick, 
            ip: clientIp, 
            isAdmin: isAdminUser 
        };
        
        // 4. 소켓 및 접속자 목록에 저장
        socket.user = finalUserData;
        connectedUsers[socket.id] = finalUserData;
        
        // 5. 권한 부여 (클라이언트에 알림)
        if (isAdminUser) socket.emit('admin auth', true);

        // 6. 개인 설정 로드
        try {
            let settings = await UserSetting.findOne({ id: userData.id });
            if (!settings) settings = await UserSetting.create({ id: userData.id, notify: true, whisper: true });
            finalUserData.settings = { notify: settings.notify, whisper: settings.whisper };
            socket.emit('load settings', finalUserData.settings); 
        } catch(e) {
            finalUserData.settings = { notify: true, whisper: true };
        }

        // 7. 히스토리 불러오기
        Chat.find({
            $or: [
                { type: { $ne: 'whisper' } },
                { type: 'whisper', 'user.id': userData.id },
                { type: 'whisper', targetId: userData.id },
                { type: 'whisper', targetNick: userData.nick }
            ]
        }).sort({ timestamp: -1 }).limit(50).then(history => {
            if (history.length > 0) socket.emit('chat history', history.reverse()); 
            if (currentNotice.trim() !== "") { socket.emit('notice message', currentNotice); }
        }).catch(err => {});
        
        // 8. 전체 유저 목록 갱신
        io.emit('user list', getUserListWithAdminStatus());
    });
    
    socket.on('update settings', async (settings) => {
        if (!socket.user) return;
        socket.user.settings = settings; 
        if(connectedUsers[socket.id]) connectedUsers[socket.id].settings = settings;
        try { await UserSetting.updateOne({ id: socket.user.id }, { $set: settings }, { upsert: true }); } catch(e) {}
    });

    socket.on('chat message', async (data) => {
        if (data.user.id === 'guest') return socket.emit('system message', '게스트는 채팅을 할 수 없습니다.');
        if (mutedUsers[data.user.id]) return socket.emit('system message', '관리자에 의해 채팅이 금지된 상태입니다.');
    
        const msgData = { type: data.type, user: data.user, ip: clientIp, content: data.content, timestamp: Date.now() };
        io.emit('chat message', msgData);
        Chat.create(msgData).catch(err => {});
    });              

    socket.on('report user', async (target) => {
        const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === target.id);
        let rawIp = targetSocket ? (targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address) : 'Unknown';
        const targetIp = rawIp.includes(',') ? rawIp.split(',')[0].trim() : rawIp;
    
        await new Report({ targetNick: target.nick, targetId: target.id, targetIp: targetIp, reporter: socket.user ? socket.user.nick : 'Unknown' }).save();
        socket.emit('system message', `[알림] ${target.nick}님에 대한 신고가 접수되었습니다.`);
    });

    socket.on('whisper', (data) => { 
            // 닉네임으로 상대방 소켓 찾기
            let targetSocketId = Object.keys(connectedUsers).find(sid => connectedUsers[sid].nick === data.targetNick);
            let targetUser = targetSocketId ? connectedUsers[targetSocketId] : null;
            
            const whisperData = { 
                type: 'whisper', 
                user: socket.user, 
                targetNick: data.targetNick, 
                ip: clientIp, 
                targetId: targetUser ? targetUser.id : null, // 🚨 상대방의 고유 ID도 함께 저장!
                content: data.content, 
                timestamp: Date.now() 
            };
    
            if (targetSocketId) {
                if (targetUser.settings && targetUser.settings.whisper === false) {
                    return socket.emit('system message', `[안내] ${data.targetNick}님은 귓속말을 거부하고 있습니다.`);
                }
                io.to(targetSocketId).emit('whisper', whisperData); 
            } else {
                socket.emit('system message', `[안내] ${data.targetNick}님은 현재 오프라인입니다. (메시지는 남겨집니다)`);
            }
            
            socket.emit('whisper', whisperData); 
            Chat.create(whisperData).catch(e => { console.error("귓말 저장 에러:", e); });
        });

    socket.on('call user', (data) => {
        let targetSocketId = Object.keys(connectedUsers).find(sid => connectedUsers[sid].nick === data.targetNick);
        
        if (targetSocketId) {
            const targetUser = connectedUsers[targetSocketId];
            if (targetUser.settings && targetUser.settings.notify === false) {
                return socket.emit('system message', `[안내] ${data.targetNick}님은 알람(호출)을 거부하고 있습니다.`);
            }
            io.to(targetSocketId).emit('call alert', { sender: data.sender });
            socket.emit('system message', `[안내] ${data.targetNick}님을 호출했습니다.`);
        } else {
            socket.emit('system message', '[안내] 접속 중인 유저가 아닙니다.');
        }
    });

    socket.on('mute user', (target) => { 
        if (socket.user && socket.user.isAdmin) {
            let targetId, targetNick;
            if (target && typeof target === 'object') { targetId = target.id; targetNick = target.nick; } 
            else {
                targetId = target;
                const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
                targetNick = targetSocket ? targetSocket.user.nick : targetId;
            }
            if (!targetId) return;
            mutedUsers[targetId] = { nick: targetNick || 'Unknown', date: new Date() };
            socket.emit('system message', `[관리] ${targetNick}님을 뮤트했습니다.`);
        }
    });

    socket.on('unmute user', (targetId) => {
        if (socket.user && socket.user.isAdmin) {
            delete mutedUsers[targetId];
            socket.emit('system message', `[관리] 해당 유저의 뮤트를 해제했습니다.`);
        }
    });

    socket.on('get ip for ban', async (targetId) => { 
        if (socket.user && socket.user.isAdmin) {
            const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
            let targetIp = null; let targetNick = targetId;

            if (targetSocket) {
                let rawIp = targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address;
                targetIp = rawIp.includes(',') ? rawIp.split(',')[0].trim() : rawIp;
                targetNick = targetSocket.user.nick;
            } else {
                targetIp = quitUsers.get(targetId);
                targetNick = targetId + " (최근 퇴장)";
            }

            if (!targetIp) {
                try {
                    const pastChat = await Chat.findOne({ "user.id": targetId }).sort({ timestamp: -1 });
                    if (pastChat && pastChat.ip) { targetIp = pastChat.ip; targetNick = pastChat.user.nick + " (과거 기록)"; }
                } catch (err) {}
            }

            if (targetIp) socket.emit('open ban page', { ip: targetIp, id: targetId, nick: targetNick });
            else socket.emit('system message', "[오류] 퇴장한 지 너무 오래되어 IP 정보를 찾을 수 없습니다.");
        }
    });
    
    socket.on('get user ip', async (targetId) => { 
        if (socket.user && socket.user.isAdmin) {
            const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
            let targetIp = null; let targetNick = targetId;

            if (targetSocket) {
                let rawIp = targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address;
                targetIp = rawIp.includes(',') ? rawIp.split(',')[0].trim() : rawIp;
                targetNick = targetSocket.user.nick;
            } else {
                targetIp = quitUsers.get(targetId);
                targetNick = targetId + " (최근 퇴장)";
            }

            if (!targetIp) {
                try {
                    const pastChat = await Chat.findOne({ "user.id": targetId }).sort({ timestamp: -1 });
                    if (pastChat && pastChat.ip) { targetIp = pastChat.ip; targetNick = pastChat.user.nick + " (과거 기록)"; }
                } catch (err) {}
            }

            if (targetIp) socket.emit('system message', `[보안] ${targetNick}님의 IP: ${targetIp}`);
            else socket.emit('system message', `[오류] 대상 유저 정보를 찾을 수 없습니다. (채팅 기록 없음)`);
        }
    });
    
    socket.on('clear chat', async () => {
        if (socket.user && socket.user.isAdmin) {
            await Chat.deleteMany({});
            io.emit('clear chat');     
        }
    });

    socket.on('disconnect', () => {
        if (socket.id && connectedUsers[socket.id]) {
            const u = connectedUsers[socket.id];
            quitUsers.set(u.id, u.ip);
            setTimeout(() => quitUsers.delete(u.id), 86400000); 

            delete connectedUsers[socket.id];
            io.emit('user list', getUserListWithAdminStatus());
        }
    });
    
}); 

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`🚀 서버 실행 중: ${PORT}`); });
