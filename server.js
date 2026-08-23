const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = 'your_super_secret_jwt_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 内存数据存储 ---
const users = []; // { id, username, passwordHash, avatar, role: 'admin'|'user', isBanned: false, isMuted: false }
const friendships = []; // { id, requesterId, receiverId, status: 'pending'|'accepted' }
const groups = []; // { id, name, code, ownerId, members: [userId] }
const messages = []; // { id, senderId, senderName, senderAvatar, targetType: 'public'|'direct'|'group', targetId, content, createdAt }

// 默认初始化一个管理员账号 (admin / admin123)
(async () => {
  const hash = await bcrypt.hash('admin123', 10);
  users.push({
    id: 'admin_1',
    username: 'admin',
    passwordHash: hash,
    avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=admin',
    role: 'admin',
    isBanned: false,
    isMuted: false
  });
})();

// --- 鉴权中间件 ---
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供认证 Token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.find(u => u.id === decoded.id);
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

// --- 身份与用户路由 ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: '用户名已存在' });

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = {
    id: 'u_' + Date.now() + Math.random().toString(36).substr(2, 4),
    username,
    passwordHash,
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
    role: users.length === 0 ? 'admin' : 'user',
    isBanned: false,
    isMuted: false
  };
  users.push(newUser);
  const token = jwt.sign({ id: newUser.id, username: newUser.username, role: newUser.role }, JWT_SECRET);
  res.json({ token, user: { id: newUser.id, username: newUser.username, avatar: newUser.avatar, role: newUser.role } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(400).json({ error: '用户不存在或密码错误' });
  if (user.isBanned) return res.status(403).json({ error: '该账号已被管理员封禁' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(400).json({ error: '用户不存在或密码错误' });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, role: user.role, isMuted: user.isMuted } });
});

// --- 管理员操作接口 ---
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const sanitized = users.map(u => ({ id: u.id, username: u.username, role: u.role, isBanned: u.isBanned, isMuted: u.isMuted }));
  res.json(sanitized);
});

app.post('/api/admin/toggle-mute', authMiddleware, adminMiddleware, (req, res) => {
  const { targetUserId } = req.body;
  const target = users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ error: '目标用户不存在' });
  target.isMuted = !target.isMuted;
  io.emit('user_status_changed', { userId: target.id, isMuted: target.isMuted, isBanned: target.isBanned });
  res.json({ success: true, isMuted: target.isMuted });
});

app.post('/api/admin/toggle-ban', authMiddleware, adminMiddleware, (req, res) => {
  const { targetUserId } = req.body;
  const target = users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ error: '目标用户不存在' });
  if (target.role === 'admin') return res.status(400).json({ error: '不能封禁管理员' });
  target.isBanned = !target.isBanned;
  io.emit('user_status_changed', { userId: target.id, isMuted: target.isMuted, isBanned: target.isBanned });
  res.json({ success: true, isBanned: target.isBanned });
});

// --- 好友与群聊接口 ---
app.post('/api/friends/request', authMiddleware, (req, res) => {
  const { targetUsername } = req.body;
  const target = users.find(u => u.username === targetUsername);
  if (!target) return res.status(404).json({ error: '未找到该用户' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' });

  const exists = friendships.find(f => 
    (f.requesterId === req.user.id && f.receiverId === target.id) ||
    (f.requesterId === target.id && f.receiverId === req.user.id)
  );
  if (exists) return res.status(400).json({ error: '好友关系已存在或正在申请中' });

  const request = { id: 'fr_' + Date.now(), requesterId: req.user.id, receiverId: target.id, status: 'pending' };
  friendships.push(request);
  io.to(`user_${target.id}`).emit('friend_request_received', { request, fromUser: req.user });
  res.json({ success: true, request });
});

app.post('/api/friends/respond', authMiddleware, (req, res) => {
  const { requestId, accept } = req.body;
  const reqItem = friendships.find(f => f.id === requestId && f.receiverId === req.user.id);
  if (!reqItem) return res.status(404).json({ error: '申请不存在' });

  reqItem.status = accept ? 'accepted' : 'rejected';
  io.to(`user_${reqItem.requesterId}`).emit('friend_request_updated', reqItem);
  io.to(`user_${reqItem.receiverId}`).emit('friend_request_updated', reqItem);
  res.json({ success: true });
});

app.get('/api/initial-data', authMiddleware, (req, res) => {
  const myFriends = friendships
    .filter(f => (f.requesterId === req.user.id || f.receiverId === req.user.id) && f.status === 'accepted')
    .map(f => {
      const friendId = f.requesterId === req.user.id ? f.receiverId : f.requesterId;
      return users.find(u => u.id === friendId);
    }).filter(Boolean);

  const pendingRequests = friendships
    .filter(f => f.receiverId === req.user.id && f.status === 'pending')
    .map(f => ({ ...f, requester: users.find(u => u.id === f.requesterId) }));

  const myGroups = groups.filter(g => g.members.includes(req.user.id));
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
  groups.push(group);
  res.json(group);
});

app.post('/api/groups/join', authMiddleware, (req, res) => {
  const { code } = req.body;
  const group = groups.find(g => g.code === code.toUpperCase());
  if (!group) return res.status(404).json({ error: '群聊邀请码无效' });
  if (!group.members.includes(req.user.id)) {
    group.members.push(req.user.id);
  }
  res.json(group);
});

// --- WebSocket 实时通信与房间管理 ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.find(u => u.id === decoded.id);
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

  socket.on('join_group_room', (groupId) => {
    socket.join(`room:group_${groupId}`);
  });

  socket.on('send_message', (data) => {
    const sender = users.find(u => u.id === currentUser.id);
    if (!sender || sender.isBanned) {
      return socket.emit('error_message', '您已被封禁，无法发送消息');
    }
    if (sender.isMuted) {
      return socket.emit('error_message', '您当前已被禁言');
    }

    const { targetType, targetId, content } = data;
    if (!content || !content.trim()) return;

    const newMsg = {
      id: 'msg_' + Date.now(),
      senderId: sender.id,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetType,
      targetId,
      content,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    messages.push(newMsg);

    if (targetType === 'public') {
      io.to('room:public').emit('new_message', newMsg);
    } else if (targetType === 'direct') {
      io.to(`user_${targetId}`).emit('new_message', newMsg);
      socket.emit('new_message', newMsg);
    } else if (targetType === 'group') {
      io.to(`room:group_${targetId}`).emit('new_message', newMsg);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
