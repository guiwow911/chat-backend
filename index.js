const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const SALT_ROUNDS = 12;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

let users = [];
let onlineUsers = new Map();

app.use(express.json());
app.use(express.static("./"));

app.post("/api/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ ok: false, msg: "用户名密码不能为空" })
    }
    if (password.length < 6) {
        return res.json({ ok: false, msg: "密码至少6位字符" })
    }
    const exist = users.find(u => u.username === username);
    if (exist) {
        return res.json({ ok: false, msg: "用户名已被占用" })
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    users.push({
        username: username,
        passwordHash: hash,
        isAdmin: false
    })
    res.json({ ok: true, msg: "注册成功" })
})

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) {
        await bcrypt.compare(password, "$2b$12$xxxxxxxxxxxxxxxxxxxx");
        return res.json({ ok: false, msg: "用户名或密码错误" })
    }
    const passOk = await bcrypt.compare(password, user.passwordHash);
    if (!passOk) {
        return res.json({ ok: false, msg: "用户名或密码错误" })
    }
    res.json({
        ok: true,
        username: user.username,
        isAdmin: user.isAdmin
    })
})

io.on("connection", (socket) => {
    let myName = "";

    socket.on("login", (name) => {
        myName = name;
        onlineUsers.set(socket.id, myName);
        io.emit("userList", [...onlineUsers.values()]);
    })

    socket.on("chat", (msg) => {
        io.emit("chat", { name: myName, text: msg })
        // ✅只给发送这条消息的用户发送跳转，不是全部人
        if(msg.includes("@地铁跑酷")){
            socket.emit("jumpSubwaySurfers");
        }
    })

    socket.on("disconnect", () => {
        onlineUsers.delete(socket.id);
        io.emit("userList", [...onlineUsers.values()]);
    })
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("服务启动，端口：", PORT)
})
