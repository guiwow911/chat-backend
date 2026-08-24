const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // 支持大图传输
});

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_2026';

// 填入专属 MongoDB Atlas 数据库连接串
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://eending29_db_user:0fhDF8J7YwlSvKcM@cluster0.nq7pnec.mongodb.net/im_chat?retryWrites=true&w=majority&appName=Cluster0';

// --- 数据模型定义 ---
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  avatar: { type: String, default: '' },
  role: { type: String, default: 'user' }, // 'admin' | 'user'
  isBanned: { type: Boolean, default: false },
  isMuted: { type: Boolean, default: false }
});

const FriendshipSchema = new mongoose.Schema({
  requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, default: 'pending' } // 'pending' | 'accepted' | 'rejected'
});

const GroupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, unique: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

const MessageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  senderName: String,
  senderAvatar: String,
  targetType: String, // 'public' | 'direct' | 'group'
  targetId: String,
  messageType: { type: String, default: 'text' },
  content: String,
  createdAt: { type: String, default: () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
});

const User = mongoose.model('User', UserSchema);
const Friendship = mongoose.model('Friendship', FriendshipSchema);
const Group = mongoose.model('Group', GroupSchema);
const Message = mongoose.model('Message', MessageSchema);

// --- 连接云端 MongoDB ---
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log(' MongoDB Atlas 云端数据库连接成功！');
    const adminExists = await User.findOne({ username: 'admin' });
    if (!adminExists) {
      const hash = await bcrypt.hash('admin123', 10);
      await User.create({
        username: 'admin',
        passwordHash: hash,
        avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=admin',
        role: 'admin'
      });
      console.log(' 默认管理员已就绪 (admin / admin123)');
    }
  })
  .catch(err => console.error(' MongoDB 连接失败:', err));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- 鉴权中间件 ---
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供认证 Token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
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
  
  const exists = await User.findOne({ username });
  if (exists) return res.status(400).json({ error: '用户名已存在' });

  const count = await User.countDocuments();
  const passwordHash = await bcrypt.hash(password, 10);
  const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;

  const newUser = await User.create({
    username,
    passwordHash,
    avatar: avatar || defaultAvatar,
    role: count === 0 ? 'admin' : 'user'
  });

  const token = jwt.sign({ id: newUser._id, username: newUser.username, role: newUser.role }, JWT_SECRET);
  res.json({ token, user: { id: newUser._id, username: newUser.username, avatar: newUser.avatar, role: newUser.role } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ error: '用户不存在或密码错误' });
  if (user.isBanned) return res.status(403).json({ error: '该账号已被管理员封禁' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(400).json({ error: '用户不存在或密码错误' });

  const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user._id, username: user.username, avatar: user.avatar, role: user.role, isMuted: user.isMuted } });
});

app.post('/api/user/avatar', authMiddleware, async (req, res) => {
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: '头像数据不能为空' });
  req.user.avatar = avatar;
  await req.user.save();
  res.json({ success: true, avatar });
});

// --- 管理员操作接口 ---
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const users = await User.find({}, 'username role isBanned isMuted');
  const mapped = users.map(u => ({ id: u._id, username: u.username, role: u.role, isBanned: u.isBanned, isMuted: u.isMuted }));
  res.json(mapped);
});

app.post('/api/admin/toggle-mute', authMiddleware, adminMiddleware, async (req, res) => {
  const { targetUserId } = req.body;
  const target = await User.findById(targetUserId);
  if (!target) return res.status(404).json({ error: '目标用户不存在' });
  target.isMuted = !target.isMuted;
  await target.save();
  io.emit('user_status_changed', { userId: target._id, isMuted: target.isMuted, isBanned: target.isBanned });
  res.json({ success: true, isMuted: target.isMuted });
});

app.post('/api/admin/toggle-ban', authMiddleware, adminMiddleware, async (req, res) => {
  const { targetUserId } = req.body;
  const target = await User.findById(targetUserId);
  if (!target) return res.status(404).json({ error: '目标用户不存在' });
  if (target.role === 'admin') return res.status(400).json({ error: '不能封禁管理员' });
  target.isBanned = !target.isBanned;
  await target.save();
  io.emit('user_status_changed', { userId: target._id, isMuted: target.isMuted, isBanned: target.isBanned });
  res.json({ success: true, isBanned: target.isBanned });
});

// --- 消息与好友/群聊业务 ---
app.get('/api/messages', authMiddleware, async (req, res) => {
  const { type, id } = req.query;
  let query = {};

  if (type === 'public') {
    query = { targetType: 'public' };
  } else if (type === 'direct') {
    query = {
      targetType: 'direct',
      $or: [
        { senderId: req.user._id, targetId: id },
        { senderId: id, targetId: req.user._id.toString() }
      ]
    };
  } else if (type === 'group') {
    query = { targetType: 'group', targetId: id };
  }

  const history = await Message.find(query).sort({ _id: 1 }).limit(100);
  const mapped = history.map(m => ({
    id: m._id,
    senderId: m.senderId.toString(),
    senderName: m.senderName,
    senderAvatar: m.senderAvatar,
    targetType: m.targetType,
    targetId: m.targetId,
    messageType: m.messageType,
    content: m.content,
    createdAt: m.createdAt
  }));
  res.json(mapped);
});

app.post('/api/friends/request', authMiddleware, async (req, res) => {
  const { targetUsername } = req.body;
  const target = await User.findOne({ username: targetUsername });
  if (!target) return res.status(404).json({ error: '未找到该用户' });
  if (target._id.equals(req.user._id)) return res.status(400).json({ error: '不能添加自己为好友' });

  const exists = await Friendship.findOne({
    $or: [
      { requesterId: req.user._id, receiverId: target._id },
      { requesterId: target._id, receiverId: req.user._id }
    ]
  });
  if (exists) return res.status(400).json({ error: '好友关系已存在或正在申请中' });

  const request = await Friendship.create({
    requesterId: req.user._id,
    receiverId: target._id,
    status: 'pending'
  });

  io.to(`user_${target._id}`).emit('friend_request_received', { request, fromUser: req.user });
  res.json({ success: true, request });
});

app.post('/api/friends/respond', authMiddleware, async (req, res) => {
  const { requestId, accept } = req.body;
  const reqItem = await Friendship.findOne({ _id: requestId, receiverId: req.user._id });
  if (!reqItem) return res.status(404).json({ error: '申请不存在' });

  reqItem.status = accept ? 'accepted' : 'rejected';
  await reqItem.save();

  io.to(`user_${reqItem.requesterId}`).emit('friend_request_updated', reqItem);
  io.to(`user_${reqItem.receiverId}`).emit('friend_request_updated', reqItem);
  res.json({ success: true });
});

app.get('/api/initial-data', authMiddleware, async (req, res) => {
  const ships = await Friendship.find({
    $or: [{ requesterId: req.user._id }, { receiverId: req.user._id }],
    status: 'accepted'
  }).populate('requesterId receiverId', 'username avatar');

  const friends = ships.map(s => {
    const isRequester = s.requesterId._id.equals(req.user._id);
    const f = isRequester ? s.receiverId : s.requesterId;
    return { id: f._id, username: f.username, avatar: f.avatar };
  });

  const pendingDocs = await Friendship.find({ receiverId: req.user._id, status: 'pending' }).populate('requesterId', 'username');
  const pendingRequests = pendingDocs.map(p => ({
    id: p._id,
    requester: { username: p.requesterId.username }
  }));

  const myGroups = await Group.find({ members: req.user._id });
  const groups = myGroups.map(g => ({ id: g._id, name: g.name, code: g.code }));

  res.json({ friends, pendingRequests, groups });
});

app.post('/api/groups/create', authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '群聊名称不能为空' });
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const group = await Group.create({
    name,
    code,
    ownerId: req.user._id,
    members: [req.user._id]
  });
  res.json({ id: group._id, name: group.name, code: group.code });
});

app.post('/api/groups/join', authMiddleware, async (req, res) => {
  const { code } = req.body;
  const group = await Group.findOne({ code: code.toUpperCase() });
  if (!group) return res.status(404).json({ error: '群聊邀请码无效' });
  if (!group.members.includes(req.user._id)) {
    group.members.push(req.user._id);
    await group.save();
  }
  res.json({ id: group._id, name: group.name, code: group.code });
});

// --- WebSocket 实时通信 ---
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || user.isBanned) return next(new Error('User unauthorized or banned'));
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', async (socket) => {
  const currentUser = socket.user;
  socket.join(`user_${currentUser._id}`);
  socket.join('room:public');

  const userGroups = await Group.find({ members: currentUser._id }, '_id');
  userGroups.forEach(g => socket.join(`room:group_${g._id}`));

  socket.on('join_group_room', (groupId) => {
    socket.join(`room:group_${groupId}`);
  });

  socket.on('send_message', async (data) => {
    const sender = await User.findById(currentUser._id);
    if (!sender || sender.isBanned) {
      return socket.emit('error_message', '您已被封禁，无法发送消息');
    }
    if (sender.isMuted) {
      return socket.emit('error_message', '您当前已被禁言');
    }

    const { targetType, targetId, content, messageType = 'text', tempId } = data;
    if (!content || !content.trim()) return;

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // 先存库入 MongoDB
    const savedMsg = await Message.create({
      senderId: sender._id,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetType,
      targetId,
      messageType,
      content,
      createdAt: timeStr
    });

    const broadcastPayload = {
      id: savedMsg._id,
      tempId,
      senderId: sender._id.toString(),
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetType,
      targetId,
      messageType,
      content,
      createdAt: timeStr
    };

    // 毫秒级广播给房间其他成员
    if (targetType === 'public') {
      socket.broadcast.to('room:public').emit('new_message', broadcastPayload);
    } else if (targetType === 'direct') {
      socket.to(`user_${targetId}`).emit('new_message', broadcastPayload);
    } else if (targetType === 'group') {
      socket.broadcast.to(`room:group_${targetId}`).emit('new_message', broadcastPayload);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
