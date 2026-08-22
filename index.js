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
const BAN_FILE = './bans.json';
const FRIEND_FILE = './friends.json';
const GROUP_FILE = './groups.json';
const UPLOAD_DIR = './public/uploads';

//安全初始化文件
function initFile(filePath, defaultData){
    if(!fs.existsSync(filePath)){
        fs.writeFileSync(filePath, JSON.stringify(defaultData));
    }
}
initFile(USER_FILE, []);
initFile(MSG_FILE, []);
initFile(MUTE_FILE, []);
initFile(BAN_FILE, []);
initFile(FRIEND_FILE, []);
initFile(GROUP_FILE, []);
if(!fs.existsSync('./public')) fs.mkdirSync('./public');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const name = Date.now() + "-" + Math.random().toString(36).slice(2) + path.extname(file.originalname);
        cb(null, name);
    }
})
const upload = multer({ storage: storage });

//文件读写工具
function loadUsers() { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); }
function saveUser(u) {
    let arr = loadUsers();
    arr.push(u);
    fs.writeFileSync(USER_FILE, JSON.stringify(arr));
}
function loadMutes(){ return JSON.parse(fs.readFileSync(MUTE_FILE,'utf8')); }
function saveMutes(arr){ fs.writeFileSync(MUTE_FILE, JSON.stringify(arr)); }
function isMuted(username){
    const mutes = loadMutes();
    const item = mutes.find(x=>x.username===username);
    if(!item) return false;
    if(item.expire === -1) return true;
    if(Date.now() < item.expire) return true;
    saveMutes(mutes.filter(x=>!(x.username===username && Date.now()>x.expire)));
    return false;
}
function loadBans(){ return JSON.parse(fs.readFileSync(BAN_FILE,'utf8')); }
function saveBans(arr){ fs.writeFileSync(BAN_FILE, JSON.stringify(arr)); }
function isBanned(username){
    const bans = loadBans();
    return bans.some(x=>x.username === username);
}
function loadFriends(){return JSON.parse(fs.readFileSync(FRIEND_FILE,"utf8"));}
function saveFriends(arr){fs.writeFileSync(FRIEND_FILE,JSON.stringify(arr));}
function loadGroups(){return JSON.parse(fs.readFileSync(GROUP_FILE,"utf8"));}
function saveGroups(arr){fs.writeFileSync(GROUP_FILE,JSON.stringify(arr));}
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
    if(isBanned(username)) return res.json({ok:false,msg:"该账号已被封禁，禁止注册"});
    if(users.find(x=>x.username===username)) return res.json({ok:false,msg:"用户名已存在"});
    const isAdmin = username.toLowerCase() === "admin";
    saveUser({username,password,isAdmin});
    res.json({ok:true,msg:"注册成功",isAdmin});
})

//登录
app.post('/api/login', (req,res)=>{
    const {username,password} = req.body;
    if(isBanned(username)) return res.json({ok:false,msg:"账号已被封禁，无法登录"});
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

//==== 管理员接口 ====
//禁言
app.post('/api/mute', (req,res)=>{
    const {adminName, targetUser, durationMs} = req.body;
    const users = loadUsers();
    const admin = users.find(u=>u.username===adminName && u.isAdmin);
    if(!admin) return res.json({ok:false,msg:"不是管理员"});
    if(targetUser.toLowerCase()==="admin") return res.json({ok:false,msg:"不能操作管理员"});
    let mutes = loadMutes();
    mutes = mutes.filter(x=>x.username!==targetUser);
    mutes.push({username:targetUser,expire:durationMs});
    saveMutes(mutes);
    io.emit("systemNotice",{msg:`管理员 ${adminName} 将用户【${targetUser}】设置禁言`});
    res.json({ok:true});
})
//解除禁言
app.post('/api/unmute', (req,res)=>{
    const {adminName, targetUser} = req.body;
    const users = loadUsers();
    const admin = users.find(u=>u.username===adminName && u.isAdmin);
    if(!admin) return res.json({ok:false});
    let mutes = loadMutes();
    mutes = mutes.filter(x=>x.username!==targetUser);
    saveMutes(mutes);
    io.emit("systemNotice",{msg:`管理员 ${adminName} 解除了【${targetUser}】的禁言`});
    res.json({ok:true});
})
//永久封禁账号
app.post('/api/ban', (req,res)=>{
    const {adminName, targetUser} = req.body;
    const users = loadUsers();
    const admin = users.find(u=>u.username===adminName && u.isAdmin);
    if(!admin) return res.json({ok:false});
    if(targetUser.toLowerCase()==="admin") return res.json({ok:false,msg:"不能封禁管理员"});
    let bans = loadBans();
    bans = bans.filter(x=>x.username!==targetUser);
    bans.push({username:targetUser,banTime:Date.now()});
    saveBans(bans);
    io.emit("systemNotice",{msg:`用户【${targetUser}】已被永久封禁`});
    res.json({ok:true});
})
//解除封禁
app.post('/api/unban', (req,res)=>{
    const {adminName, targetUser} = req.body;
    const users = loadUsers();
    const admin = users.find(u=>u.username===adminName && u.isAdmin);
    if(!admin) return res.json({ok:false});
    let bans = loadBans();
    bans = bans.filter(x=>x.username!==targetUser);
    saveBans(bans);
    io.emit("systemNotice",{msg:`管理员解除了【${targetUser}】账号封禁`});
    res.json({ok:true});
})
//后台全部数据 用户/禁言/封禁列表
app.post('/api/admin-data', (req,res)=>{
    const {adminName} = req.body;
    const users = loadUsers();
    const admin = users.find(u=>u.username===adminName && u.isAdmin);
    if(!admin) return res.json({ok:false});
    const userList = loadUsers().map(i=>({username:i.username,isAdmin:i.isAdmin}));
    const muteList = loadMutes();
    const banList = loadBans();
    res.json({ok:true,userList,muteList,banList});
})

// ===== 好友系统接口 =====
//发送好友申请
app.post("/api/friend/add",(req,res)=>{
    const {fromUser,toUser} = req.body;
    if(fromUser===toUser) return res.json({ok:false,msg:"不能添加自己"});
    const users = loadUsers();
    if(!users.find(x=>x.username===toUser)) return res.json({ok:false,msg:"该用户不存在"});
    let friends = loadFriends();
    //已为好友
    if(friends.some(x=>
        (x.a===fromUser&&x.b===toUser)||(x.a===toUser&&x.b===fromUser)
    )) return res.json({ok:false,msg:"已经是好友"});
    //已有待处理申请
    if(friends.some(x=>
        ((x.a===fromUser&&x.b===toUser)||(x.a===toUser&&x.b===fromUser)) && x.pending
    )) return res.json({ok:false,msg:"好友申请已发送"});
    friends.push({a:fromUser,b:toUser,pending:true});
    saveFriends(friends);
    io.emit("friendNotify",{from:fromUser,to:toUser});
    res.json({ok:true});
})
//同意好友
app.post("/api/friend/accept",(req,res)=>{
    const {userA,userB} = req.body;
    let friends = loadFriends();
    const idx = friends.findIndex(x=>
        ((x.a===userA&&x.b===userB)||(x.a===userB&&x.b===userA)) && x.pending
    );
    if(idx===-1) return res.json({ok:false});
    friends[idx].pending = false;
    saveFriends(friends);
    io.emit("friendNotify",{type:"accept",u1:userA,u2:userB});
    res.json({ok:true});
})
//删除好友
app.post("/api/friend/del",(req,res)=>{
    const {me,target} = req.body;
    let friends = loadFriends();
    friends = friends.filter(x=>!(
        (x.a===me&&x.b===target)||(x.a===target&&x.b===me)
    ));
    saveFriends(friends);
    res.json({ok:true});
})
//获取我的好友列表
app.post("/api/friend/list",(req,res)=>{
    const {username} = req.body;
    const friends = loadFriends();
    const list = [];
    const applyList = [];
    friends.forEach(item=>{
        if(item.pending){
            if(item.b===username) applyList.push(item.a);
        }else{
            if(item.a===username) list.push(item.b);
            if(item.b===username) list.push(item.a);
        }
    })
    res.json({ok:true,friends:list,applies:applyList});
})

// ===== 群聊接口 =====
//创建群聊，生成群码
app.post("/api/group/create",(req,res)=>{
    const {creatorName,groupName} = req.body;
    const groups = loadGroups();
    const groupCode = Math.random().toString(36).slice(2,10).toUpperCase();
    const groupId = "g_"+Date.now();
    groups.push({
        groupId,
        groupName,
        groupCode,
        creatorName,
        members:[creatorName]
    })
    saveGroups(groups);
    res.json({ok:true,groupId,groupCode,groupName});
})
//通过群码加入群
app.post("/api/group/joinByCode",(req,res)=>{
    const {code,username} = req.body;
    const groups = loadGroups();
    const g = groups.find(x=>x.groupCode === code);
    if(!g) return res.json({ok:false,msg:"群码无效"});
    if(!g.members.includes(username)) g.members.push(username);
    saveGroups(groups);
    res.json({ok:true,group:g});
})
//获取我的所有群
app.post("/api/group/mine",(req,res)=>{
    const {username} = req.body;
    const groups = loadGroups();
    const mine = groups.filter(x=>x.members.includes(username));
    res.json({ok:true,groups:mine});
})

app.use(express.static(__dirname));
app.use('/uploads',express.static(UPLOAD_DIR));
app.get('/', (req,res)=>res.sendFile(__dirname + '/index.html'));

// 在线用户映射 username -> socketId
const userSocketMap = new Map();

io.on('connection', (socket) => {
    socket.emit('history', loadMessages());

    socket.on("login_bind",(username)=>{
        userSocketMap.set(username,socket.id);
    })
    socket.on("disconnect",()=>{
        for(let [k,v] of userSocketMap){
            if(v===socket.id) userSocketMap.delete(k);
        }
    })

    //全局公聊
    socket.on('chat', (data)=>{
        if(isMuted(data.sender)){
            socket.emit("systemNotice",{msg:"你已被禁言，无法发送消息"});
            return;
        }
        saveMessage(data);
        io.emit('chat', data);
    })

    //私聊消息
    socket.on("private_msg",(payload)=>{
        const {toUser,fromUser,text} = payload;
        const targetSocketId = userSocketMap.get(toUser);
        if(targetSocketId){
            io.to(targetSocketId).emit("private_in",{fromUser,text});
        }
        socket.emit("private_in",{fromUser,text,self:true});
    })

    //群聊消息
    socket.on("group_msg",(payload)=>{
        const {groupId,fromUser,text} = payload;
        const groups = loadGroups();
        const g = groups.find(x=>x.groupId===groupId);
        if(!g) return;
        g.members.forEach(memberName=>{
            const sid = userSocketMap.get(memberName);
            if(sid){
                io.to(sid).emit("group_in",{groupId,fromUser,text});
            }
        })
    })
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>{
    console.log("服务启动 port:"+PORT);
})
