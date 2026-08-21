const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const USER_FILE = './users.json';
const MSG_FILE = './messages.json';
const MUTE_FILE = './mutes.json';
const UPLOAD_DIR = './public/uploads';

//初始化全部文件
if (!fs.existsSync(USER_FILE)) fs.writeFileSync(USER_FILE, JSON.stringify([]));
if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, JSON.stringify([]));
if (!fs.existsSync(MUTE_FILE)) fs.writeFileSync(MUTE_FILE, JSON.stringify([]));
if (!fs.existsSync('./public')) fs.mkdirSync('./public');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const name = Date.now() + "-" + Math.random().toString(36).slice(2) + path.extname(file.originalname);
        cb(null, name);
    }
})
const upload = multer({ storage: storage });

//用户
function loadUsers() { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); }
function saveUser(u) {
    let arr = loadUsers();
    arr.push(u);
    fs.writeFileSync(USER_FILE, JSON.stringify(arr));
}

//禁言管理
function loadMutes(){ return JSON.parse(fs.readFileSync(MUTE_FILE,'utf8')); }
function saveMutes(arr){ fs.writeFileSync(MUTE_FILE, JSON.stringify(arr)); }
//检查是否被禁言
function isMuted(username){
    const mutes = loadMutes();
    const item = mutes.find(x=>x.username===username);
    if(!item) return false;
    if(item.expire === -1) return true; //永久禁言
    if(Date.now() < item.expire) return true;
    //过期自动删除
    saveMutes(mutes.filter(x=>!(x.username===username && Date.now()>x.expire)));
    return false;
}

//消息
function loadMessages() { return JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); }
function saveMessage(msg) {
    let list = loadMessages();
    list.push(msg);
    if(list.length>80) list = list.slice(-80);
    fs.writeFileSync(MSG_FILE, JSON.stringify(list));
}

app.use(express.json());

//注册
app.post('/api/register', (req,res)=>{
    const {username,password} = req.body;
    const users = loadUsers();
    if(!username||!password) return res.json({ok:false,msg:"用户名密码不能为空"});
    if(users.find(x=>x.username===username)) return res.json({ok:false,msg:"用户名已存在"});
    const isAdmin = username.toLowerCase() === "admin";
    saveUser({username,password,isAdmin});
    res.json({ok:true,msg:"注册成功",isAdmin});
})

//登录
app.post('/api/login', (req,res)=>{
    const {username,password} = req.body;
    const users = loadUsers();
    const u = users.find(x=>x.username===username && x.password===password);
    if(!u) return res.json({ok:false,msg:"账号密码错误"});
    res.json({ok:true,username,isAdmin:u.isAdmin||false});
})

//图片上传
app.post('/api/upload', upload.single('img'), (req,res)=>{
    if(!req.file) return res.json({ok:false});
    res.json({ok:true,url:"/uploads/"+req.file.filename});
})

//管理员禁言接口
app.post('/api/mute', (req,res)=>{
    const {adminName, targetUser, durationMs} = req.body;
    const users = loadUsers();
    const admin = users.find(u=>u.username===adminName && u.isAdmin);
    if(!admin) return res.json({ok:false,msg:"不是管理员"});
    if(targetUser.toLowerCase()==="admin") return res.json({ok:false,msg:"不能禁言管理员"});
    let mutes = loadMutes();
    mutes = mutes.filter(x=>x.username!==targetUser);
    mutes.push({username:targetUser,expire:durationMs});
    saveMutes(mutes);
    io.emit("systemNotice",{msg:`管理员 ${adminName} 将用户【${targetUser}】设置禁言`});
    res.json({ok:true});
})

app.use(express.static(__dirname));
app.use('/uploads',express.static(UPLOAD_DIR));
app.get('/', (req,res)=>res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    socket.emit('history', loadMessages());

    socket.on('chat', (data)=>{
        if(isMuted(data.sender)){
            socket.emit("systemNotice",{msg:"你已被禁言，无法发送消息"});
            return;
        }
        saveMessage(data);
        io.emit('chat', data);
    })
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>{
    console.log("服务启动 port:"+PORT);
})
