const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server,{cors:{origin:"*"}});

app.get('/',(req,res)=>{
    res.sendFile(__dirname+'/index.html');
})

io.on('connection',socket=>{
    socket.on('chat_msg',data=>io.emit('chat_msg',data))
})

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log("运行成功"));
