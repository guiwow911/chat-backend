const express = require('express');
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
    
