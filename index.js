const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static('./'));

let userDB = [];
let onlineUsers = [];
let banList = [];
let muteList = [];
//好友关系存储
let friendRelations = [];
//私聊消息
let privateMsgPool = [];

//注册
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ ok: false, msg: "用户名密码不能为空" });
    if (password.length < 6) return res.json({ ok: false, msg: "密码至少6位" });
    if (userDB.find(u => u.username === username)) return res.json({ ok: false, msg: "用户名已存在" });
    const hashPwd = await bcrypt.hash(password, 10);
    const isAdmin = username === "admin";
    userDB.push({ username, password: hashPwd, isAdmin });
    res.json({ ok: true, msg: "注册成功" });
})

//登录
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const banItem = banList.find(b => b.username === username);
    if (banItem) return res.json({ ok: false, msg: "账号已被封禁" });
    const user = userDB.find(u => u.username === username);
    if (!user) return res.json({ ok: false, msg: "账号不存在" });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.json({ ok: false, msg: "密码错误" });
    //读取该用户好友列表
    const myFriends = friendRelations.filter(r=>r.a===username||r.b===username).map(r=>r.a===username?r.b:r.a);
    res.json({ ok: true, username: user.username, isAdmin: user.isAdmin, friends:myFriends });
})

io.on('connection', (socket) => {
    let myName = "";

    socket.on("login", (name) => {
        myName = name;
        if (!onlineUsers.includes(name)) onlineUsers.push(name);
        io.emit("userList", onlineUsers);
        //下发自己好友列表
        const myFriends = friendRelations.filter(r=>r.a===myName||r.b===myName).map(r=>r.a===myName?r.b:r.a);
        socket.emit("friendList",myFriends);
    })

    //群聊
    socket.on("chat", (msg) => {
        if(muteList.includes(myName)) return;
        io.emit("chat", { name: myName, text: msg });
        if(msg.includes("@地铁跑酷")){
            socket.emit("jumpSubwaySurfers");
        }
    })

    //发送私聊
    socket.on("privateMsg",({targetName,text})=>{
        privateMsgPool.push({from:myName,to:targetName,text,time:Date.now()});
        //发给接收方
        io.sockets.sockets.forEach(s=>{
            if(s.myName === targetName){
                s.emit("privateReceive",{from:myName,text})
            }
        })
        //回发给发送者
        socket.emit("privateReceive",{from:myName,to:targetName,text})
    })

    //添加好友
    socket.on("addFriend",target=>{
        if(!userDB.find(u=>u.username===target)){
            socket.emit("systemTip",{msg:"该用户不存在"});
            return;
        }
        let exist = friendRelations.find(x=>(x.a===myName&&x.b===target)||(x.a===target&&x.b===myName));
        if(exist){
            socket.emit("systemTip",{msg:"已经是好友"});
            return;
        }
        friendRelations.push({a:myName,b:target});
        //双方刷新好友列表
        io.sockets.sockets.forEach(s=>{
            if(s.myName === myName || s.myName === target){
                const mf = friendRelations.filter(r=>r.a===s.myName||r.b===s.myName).map(r=>r.a===s.myName?r.b:r.a);
                s.emit("friendList",mf);
            }
        })
        socket.emit("systemTip",{msg:`成功添加好友：${target}`});
    })

    //封禁
    socket.on("banUser", (target) => {
        banList.push({ username: target, time: new Date() });
        io.emit("banNotice", target);
    })
    socket.on("unbanUser", (target) => {
        banList = banList.filter(b => b.username !== target);
    })

    socket.on("disconnect", () => {
        onlineUsers = onlineUsers.filter(x => x !== myName);
        io.emit("userList", onlineUsers);
    })
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("服务启动，端口：" + PORT);
})
