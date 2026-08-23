const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // 支持大图传输
});

const JWT_SECRET = 'your_super_secret_jwt_key_2026';
const DB_FILE = path.join(__dirname, 'data.json');

// --- 数据持久化与异步非阻塞写入 ---
let db = {
  users: [],
  friendships: [],
  groups: [],
  messages: []
};

function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
    } catch (e) {
      console.error('读取数据库文件失败，重置结构', e);
    }
  }
  if (!db.users.find(u => u.username === 'admin')) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.users.push({
      id: 'admin_1',
      username: 'admin',
      passwordHash: hash,
      avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=admin',
      role: 'admin',
      isBanned: false,
      isMuted: false
    });
    saveDatabaseImmediately();
  }
}

let saveTimer = null;
function saveDatabase() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8', (err) => {
      if (err) console.error('异步落盘失败', err);
    });
  }, 100);
}

function saveDatabaseImmediately() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('同步保存失败', e);
  }
}

loadDatabase();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- 鉴权中间件 ---
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供认证 Token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (user.isBanned) return res.status(403).json({ error: '账号已被封禁' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token 无效或过期' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限拒绝：需要管理员身份' });
  }
  next();
}

// --- 身份路由 ---
app.post('/api/register', async (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: '用户名已存在' });

  const passwordHash = await bcrypt.hash(password, 10);
  const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
  
  const newUser = {
    id: 'u_' + Date.now() + Math.random().toString(36).substr(2, 4),
    username,
    passwordHash,
    avatar: avatar || defaultAvatar,
    role: db.users.length === 0 ? 'admin' : 'user',
    isBanned: false,
    isMuted: false
  };
  db.users.push(newUser);
  saveDatabaseImmediately();

  const token = jwt.sign({ id: newUser.id, username: newUser.username, role: newUser.role }, JWT_SECRET);
  res.json({ token, user: { id: newUser.id, username: newUser.username, avatar: newUser.avatar, role: newUser.role } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(400).json({ error: '用户不存在或密码错误' });
  if (user.isBanned) return res.status(403).json({ error: '该账号已被封禁' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(400).json({ error: '用户不存在或密码错误' });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, role: user.role, isMuted: user.isMuted } });
});

app.post('/api/user/avatar', authMiddleware, (req, res) => {
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: '头像数据不能为空' });
  req.user.avatar = avatar;
  saveDatabase();
  res.json({ success: true, avatar });
});

// --- 管理员操作接口 ---
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const sanitized = db.users.map(u => ({ id: u.id, username: u.username, role: u.role, isBanned: u.isBanned, isMuted: u.isMuted }));
  res.json(sanitized);
});

app.post('/api/admin/toggle-mute', authMiddleware, adminMiddleware, (req, res) => {
  const { targetUserId } = req.body;
  const target = db.users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ error: '目标用户不存在' });
  target.isMuted = !target.isMuted;
  saveDatabase();
  io.emit('user_status_changed', { userId: target.id, isMuted: target.isMuted, isBanned: target.isBanned });
  res.json({ success: true, isMuted: target.isMuted });
});

app.post('/api/admin/toggle-ban', authMiddleware, adminMiddleware, (req, res) => {
  const { targetUserId } = req.body;
  const target = db.users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ error: '目标用户不存在' });
  if (target.role === 'admin') return res.status(400).json({ error: '不能封禁管理员' });
  target.isBanned = !target.isBanned;
  saveDatabase();
  io.emit('user_status_changed', { userId: target.id, isMuted: target.isMuted, isBanned: target.isBanned });
  res.json({ success: true, isBanned: target.isBanned });
});

// --- 消息与好友系统 ---
app.get('/api/messages', authMiddleware, (req, res) => {
  const { type, id } = req.query;
  let history = [];

  if (type === 'public') {
    history = db.messages.filter(m => m.targetType === 'public');
  } else if (type === 'direct') {
    history = db.messages.filter(m => 
      m.targetType === 'direct' && 
      ((m.senderId === req.user.id && m.targetId === id) || (m.senderId === id && m.targetId === req.user.id))
    );
  } else if (type === 'group') {
    history = db.messages.filter(m => m.targetType === 'group' && m.targetId === id);
  }

  res.json(history.slice(-100));
});

app.post('/api/friends/request', authMiddleware, (req, res) => {
  const { targetUsername } = req.body;
  const target = db.users.find(u => u.username === targetUsername);
  if (!target) return res.status(404).json({ error: '未找到该用户' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' });

  const exists = db.friendships.find(f => 
    (f.requesterId === req.user.id && f.receiverId === target.id) ||
    (f.requesterId === target.id && f.receiverId === req.user.id)
  );
  if (exists) return res.status(400).json({ error: '好友关系已存在或正在申请中' });

  const request = { id: 'fr_' + Date.now(), requesterId: req.user.id, receiverId: target.id, status: 'pending' };
  db.friendships.push(request);
  saveDatabase();

  io.to(`user_${target.id}`).emit('friend_request_received', { request, fromUser: req.user });
  res.json({ success: true, request });
});

app.post('/api/friends/respond', authMiddleware, (req, res) => {
  const { requestId, accept } = req.body;
  const reqItem = db.friendships.find(f => f.id === requestId && f.receiverId === req.user.id);
  if (!reqItem) return res.status(404).json({ error: '申请不存在' });

  reqItem.status = accept ? 'accepted' : 'rejected';
  saveDatabase();

  io.to(`user_${reqItem.requesterId}`).emit('friend_request_updated', reqItem);
  io.to(`user_${reqItem.receiverId}`).emit('friend_request_updated', reqItem);
  res.json({ success: true });
});

app.get('/api/initial-data', authMiddleware, (req, res) => {
  const myFriends = db.friendships
    .filter(f => (f.requesterId === req.user.id || f.receiverId === req.user.id) && f.status === 'accepted')
    .map(f => {
      const friendId = f.requesterId === req.user.id ? f.receiverId : f.requesterId;
      return db.users.find(u => u.id === friendId);
    }).filter(Boolean);

  const pendingRequests = db.friendships
    .filter(f => f.receiverId === req.user.id && f.status === 'pending')
    .map(f => ({ ...f, requester: db.users.find(u => u.id === f.requesterId) }));

  const myGroups = db.groups.filter(g => g.members.includes(req.user.id));
  res.json({ friends: myFriends, pendingRequests, groups: myGroups });
});

app.post('/api/groups/create', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '群聊名称不能为空' });
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const group = {
    id: 'grp_' + Date.now(),
    name,
    code,
    ownerId: req.user.id,
    members: [req.user.id]
  };
  db.groups.push(group);
  saveDatabase();
  res.json(group);
});

app.post('/api/groups/join', authMiddleware, (req, res) => {
  const { code } = req.body;
  const group = db.groups.find(g => g.code === code.toUpperCase());
  if (!group) return res.status(404).json({ error: '群聊邀请码无效' });
  if (!group.members.includes(req.user.id)) {
    group.members.push(req.user.id);
    saveDatabase();
  }
  res.json(group);
});

// --- WebSocket 实时路由（低延迟广播） ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === decoded.id);
    if (!user || user.isBanned) return next(new Error('User unauthorized or banned'));
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  const currentUser = socket.user;
  socket.join(`user_${currentUser.id}`);
  socket.join('room:public');

  db.groups.filter(g => g.members.includes(currentUser.id)).forEach(g => {
    socket.join(`room:group_${g.id}`);
  });

  socket.on('join_group_room', (groupId) => {
    socket.join(`room:group_${groupId}`);
  });

  socket.on('send_message', (data) => {
    const sender = db.users.find(u => u.id === currentUser.id);
    if (!sender || sender.isBanned) {
      return socket.emit('error_message', '您已被封禁，无法发送消息');
    }
    if (sender.isMuted) {
      return socket.emit('error_message', '您当前已被禁言');
    }

    const { targetType, targetId, content, messageType = 'text', tempId } = data;
    if (!content || !content.trim()) return;

    const newMsg = {
      id: 'msg_' + Date.now() + Math.random().toString(36).substr(2, 4),
      tempId,
      senderId: sender.id,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetType,
      targetId,
      messageType,
      content,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // 优先广播，保证其他客户端毫秒级接收
    if (targetType === 'public') {
      socket.broadcast.to('room:public').emit('new_message', newMsg);
    } else if (targetType === 'direct') {
      socket.to(`user_${targetId}`).emit('new_message', newMsg);
    } else if (targetType === 'group') {
      socket.broadcast.to(`room:group_${targetId}`).emit('new_message', newMsg);
    }

    // 异步非阻塞落盘
    db.messages.push(newMsg);
    saveDatabase();
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
