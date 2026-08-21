const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 消息存储文件
const MSG_FILE = './messages.json';

// 初始化消息文件
if (!fs.existsSync(MSG_FILE)) {
    fs.writeFileSync(MSG_FILE, JSON.stringify([]));
}

// 读取历史消息
function loadMessages() {
    const raw = fs.readFileSync(MSG_FILE, 'utf8');
    return JSON.parse(raw);
}
// 保存消息
function saveMessage(msg) {
    let list = loadMessages();
    list.push(msg);
    // 最多保存50条，防止文件无限变大
    if(list.length>50) list = list.slice(-50);
    fs.writeFileSync(MSG_FILE, JSON.stringify(list));
}

app.use(express.static(__dirname));
// 新增这一行，解决 Cannot GET /
app.get('/', (req,res)=>res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    console.log("用户已连接");
    // 新用户进来，下发全部历史消息
    socket.emit('history', loadMessages());

    socket.on('chat', (data)=>{
        saveMessage(data);
        io.emit('chat', data);
    })

    socket.on('disconnect', ()=>{
        console.log("用户离开");
    })
})

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>{
    console.log(`服务启动，端口 ${PORT}`);
})
