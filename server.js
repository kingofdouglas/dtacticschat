const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// 1. 미들웨어 및 환경변수
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const adminEnv = process.env.ADMIN_IDS || '';
const ADMIN_IDS = adminEnv ? adminEnv.split(',').map(id => id.trim()) : [];
const ADMIN_PW = process.env.ADMIN_PASSWORD || '1234';

// 2. MongoDB 연결
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ DB 연결 성공'))
    .catch(err => console.error('❌ DB 연결 실패:', err));

// 3. DB 스키마 정의
const Report = mongoose.model('Report', new mongoose.Schema({
    targetNick: String, targetId: String, targetIp: String,
    reporter: String, date: { type: Date, default: Date.now }
}));

const Ban = mongoose.model('Ban', new mongoose.Schema({
    ip: String, id: String, nick: String,
    reason: String, date: { type: Date, default: Date.now }
}));

const Chat = mongoose.model('Chat', new mongoose.Schema({
    type: String, 
    user: Object, 
    ip: String,   
    content: String,
    targetNick: String, // 오프라인 귓속말용
    timestamp: { type: Date, default: Date.now, expires: 2592000 }
}));

const UserSetting = mongoose.model('UserSetting', new mongoose.Schema({
    id: String,
    notify: { type: Boolean, default: true },
    whisper: { type: Boolean, default: true }
}));

const quitUsers = new Map();
const connectedUsers = {};
let mutedUsers = {}; 

// 🚨 [수정됨] 접속자 목록을 묶어서(유령/다중접속 제거) 유니크한 닉네임만 표시합니다.
const getUserListWithAdminStatus = () => {
    const uniqueUsers = [];
    const seenNicks = new Set();
    for (const u of Object.values(connectedUsers)) {
        if (!seenNicks.has(u.nick)) {
            seenNicks.add(u.nick);
            uniqueUsers.push({ ...u, isAdmin: ADMIN_IDS.includes(u.id) });
        }
    }
    return uniqueUsers;
};

const adminAuth = (req, res, next) => {
    const clientPw = req.query.pw || req.body.pw;
    if (clientPw === ADMIN_PW) next();
    else res.status(403).json({ error: "접근 권한이 없습니다." });
};

// 4. HTTP 관리자 API 라우트
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

app.get('/admin', (req, res) => {
    if (req.query.pw === ADMIN_PW) res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    else res.status(403).send(`<script>const pw=prompt("비밀번호:"); if(pw)location.href="/admin?pw="+pw; else location.href="/";</script>`);
});

app.get('/api/admin/chats', adminAuth, async (req, res) => {
    try { res.json(await Chat.find().sort({ timestamp: -1 }).limit(1000)); } catch (err) { res.status(500).json({ error: "에러" }); }
});

app.get('/api/admin/reports', adminAuth, async (req, res) => { res.json(await Report.find().sort({ date: -1 })); });
app.delete('/api/admin/report/:id', adminAuth, async (req, res) => { await Report.findByIdAndDelete(req.params.id); res.json({ success: true }); });

app.get('/api/admin/bans', adminAuth, async (req, res) => {
    let bans = await Ban.find().sort({ date: -1 }).lean();
    res.json(bans.map(ban => ({ ...ban, ip: ban.ip.includes(',') ? ban.ip.split(',')[0].trim() : ban.ip })));
});
app.post('/api/admin/ban', adminAuth, async (req, res) => {
    const { ip, id, nick, reason } = req.body;
    await Ban.create({ ip, id, nick, reason });
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
        let sIp = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
        if (sIp.includes(ip)) { s.emit('system message', '관리자에 의해 차단되었습니다.'); s.disconnect(); }
    }
    res.json({ success: true });
});
app.delete('/api/admin/ban/:id', adminAuth, async (req, res) => { await Ban.findByIdAndDelete(req.params.id); res.json({ success: true }); });

app.get('/api/admin/mutes', adminAuth, (req, res) => {
    res.json(Object.keys(mutedUsers).map(id => ({ id: id, nick: mutedUsers[id].nick, date: mutedUsers[id].date })));
});
app.post('/api/admin/mute', adminAuth, (req, res) => {
    const { id, nick } = req.body;
    mutedUsers[id] = { nick: nick || 'Unknown', date: new Date() };
    io.emit('system message', `[관리] ${nick}님을 뮤트했습니다.`);
    res.json({ success: true });
});
app.delete('/api/admin/mute/:id', adminAuth, (req, res) => {
    if (mutedUsers[req.params.id]) { delete mutedUsers[req.params.id]; res.json({ success: true }); } 
    else { res.status(404).json({ error: "찾을 수 없습니다." }); }
});

app.get('/api/emoticons', (req, res) => {
    fs.readdir(path.join(__dirname, 'public', 'emoticons'), (err, files) => {
        if (err) return res.status(500).send([]);
        res.json(files.filter(file => /\.(png|jpe?g|gif)$/i.test(file)));
    });
});

// 5. Socket.io 실시간 통신
io.on('connection', async (socket) => {
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

    try {
        const isBanned = await Ban.findOne({ ip: clientIp });
        if (isBanned) {
            socket.emit('system message', `차단된 IP입니다. (사유: ${isBanned.reason})`);
            socket.emit('banned user', {reason: isBanned.reason});
            socket.disconnect(true);
            return;
        }
    } catch (err) {}
    
    socket.on('join', async (userData) => { 
        // 🚨 [수정됨] 불필요한 중복 번호_(1) 추가 로직을 완전히 삭제했습니다. (위의 unique 필터가 알아서 정리함)
        const finalUserData = { ...userData, ip: clientIp };
        
        try {
            let settings = await UserSetting.findOne({ id: userData.id });
            if (!settings) settings = await UserSetting.create({ id: userData.id, notify: true, whisper: true });
            finalUserData.settings = { notify: settings.notify, whisper: settings.whisper };
            socket.emit('load settings', finalUserData.settings); 
        } catch(e) {
            finalUserData.settings = { notify: true, whisper: true };
        }

        socket.user = finalUserData;
        connectedUsers[socket.id] = finalUserData;
        
        if (ADMIN_IDS.includes(userData.id)) socket.emit('admin auth', true);
    
        // 과거 오프라인 귓속말 및 일반채팅 30개 불러오기
        Chat.find({
            $or: [
                { type: { $ne: 'whisper' } }, 
                { type: 'whisper', targetNick: userData.nick }, 
                { type: 'whisper', 'user.nick': userData.nick } 
            ]
        }).sort({ timestamp: -1 }).limit(30).then(history => {
            if (history.length > 0) socket.emit('chat history', history.reverse()); 
        }).catch(err => {});
        
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

    socket.on('whisper', async (data) => {
        let targetSocketId = Object.keys(connectedUsers).find(sid => connectedUsers[sid].nick === data.targetNick);
        
        const whisperData = { type: 'whisper', user: data.user, targetNick: data.targetNick, content: data.content, timestamp: Date.now() };
        try { await Chat.create(whisperData); } catch(e) {}

        if (targetSocketId) {
            const targetUser = connectedUsers[targetSocketId];
            if (targetUser.settings && targetUser.settings.whisper === false) {
                return socket.emit('system message', `[안내] ${data.targetNick}님은 귓속말을 거부하고 있습니다.`);
            }
            io.to(targetSocketId).emit('whisper', whisperData); 
        } else {
            socket.emit('system message', `[안내] ${data.targetNick}님은 현재 오프라인입니다. (메시지는 남겨집니다)`);
        }
        socket.emit('whisper', whisperData); 
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
        if (ADMIN_IDS.includes(socket.user?.id)) {
            let targetId = target.id || target;
            let targetNick = target.nick || ([...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId)?.user.nick || targetId);
            if (!targetId) return;
            mutedUsers[targetId] = { nick: targetNick || 'Unknown', date: new Date() };
            socket.emit('system message', `[관리] ${targetNick}님을 뮤트했습니다.`);
        }
    });

    socket.on('unmute user', (targetId) => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
            delete mutedUsers[targetId];
            socket.emit('system message', `[관리] 해당 유저의 뮤트를 해제했습니다.`);
        }
    });

    socket.on('get ip for ban', async (targetId) => { 
        if (ADMIN_IDS.includes(socket.user?.id)) {
            const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
            let targetIp = targetSocket ? (targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address).split(',')[0].trim() : quitUsers.get(targetId);
            let targetNick = targetSocket ? targetSocket.user.nick : targetId + " (최근 퇴장)";

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
        if (ADMIN_IDS.includes(socket.user?.id)) {
            const targetSocket = [...io.sockets.sockets.values()].find(s => s.user && s.user.id === targetId);
            let targetIp = targetSocket ? (targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address).split(',')[0].trim() : quitUsers.get(targetId);
            let targetNick = targetSocket ? targetSocket.user.nick : targetId + " (최근 퇴장)";

            if (!targetIp) {
                try {
                    const pastChat = await Chat.findOne({ "user.id": targetId }).sort({ timestamp: -1 });
                    if (pastChat && pastChat.ip) { targetIp = pastChat.ip; targetNick = pastChat.user.nick + " (과거 기록)"; }
                } catch (err) {}
            }
            if (targetIp) socket.emit('system message', `[보안] ${targetNick}님의 IP: ${targetIp}`);
            else socket.emit('system message', `[오류] 정보 없음.`);
        }
    });
    
    socket.on('clear chat', async () => {
        if (ADMIN_IDS.includes(socket.user?.id)) {
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
