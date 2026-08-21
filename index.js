const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 文件路径
const USER_FILE = './users.json';
const MSG_FILE = './messages.json';
const UPLOAD_DIR = './public/uploads';

// 初始化文件
if (!fs.existsSync(USER_FILE)) fs.writeFileSync(USER_FILE, JSON.stringify([]));
if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, JSON.stringify([]));
if (!fs.existsSync('./public')) fs.mkdirSync('./public');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// multer图片上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const name = Date.now() + "-" + Math.random().toString(36).slice(2) + path.extname(file.originalname);
        cb(null, name);
    }
})
const upload = multer({ storage: storage });

// 读取用户
function loadUsers() { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); }
function saveUser(u) {
    let arr = loadUsers();
    arr.push(u);
    fs.writeFileSync(USER_FILE, JSON.stringify(arr));
}

// 消息读写
function loadMessages() { return JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); }
function saveMessage(msg) {
    let list = loadMessages();
    list.push(msg);
    if(list.length>80) list = list.slice(-80);
    fs.writeFileSync(MSG_FILE, JSON.stringify(list));
}

// 接口：注册
app.use(express.json());
app.post('/api/register', (req,res)=>{
    const {username,password} = req.body;
    const users = loadUsers();
    if(!username||!password) return res.json({ok:false,msg:"用户名密码不能为空"});
    if(users.find(x=>x.username===username)) return res.json({ok:false,msg:"用户名已存在"});
    saveUser({username,password});
    res.json({ok:true,msg:"注册成功"});
})

// 接口：登录
app.post('/api/login', (req,res)=>{
    const {username,password} = req.body;
    const users = loadUsers();
    const u = users.find(x=>x.username===username && x.password===password);
    if(!u) return res.json({ok:false,msg:"账号密码错误"});
    res.json({ok:true,username});
})

// 图片上传接口
app.post('/api/upload', upload.single('img'), (req,res)=>{
    if(!req.file) return res.json({ok:false});
    res.json({ok:true,url:"/uploads/"+req.file.filename});
})

app.use(express.static(__dirname));
app.use('/uploads',express.static(UPLOAD_DIR));
app.get('/', (req,res)=>res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    socket.emit('history', loadMessages());

    socket.on('chat', (data)=>{
        saveMessage(data);
        io.emit('chat', data);
    })
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>{
    console.log("服务启动 port:"+PORT);
})
