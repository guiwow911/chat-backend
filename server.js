import express from "express";
import http from "http";
import { Server } from "socket.io";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const {Pool}=pg, app=express(), server=http.createServer(app);
const io=new Server(server,{cors:{origin:"*"}});
const PORT=process.env.PORT||10000;
const JWT_SECRET=process.env.JWT_SECRET||"change-me";
if(!process.env.DATABASE_URL){console.error("Missing DATABASE_URL");process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
app.use(express.json()); app.use(express.static("public"));
const db=(q,p=[])=>pool.query(q,p).then(x=>x.rows);

async function init(){
 await db(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username VARCHAR(32) UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS friendships(user_id INT REFERENCES users(id) ON DELETE CASCADE,friend_id INT REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(user_id,friend_id));
 CREATE TABLE IF NOT EXISTS groups_chat(id SERIAL PRIMARY KEY,name VARCHAR(80) NOT NULL,invite_code VARCHAR(16) UNIQUE NOT NULL,owner_id INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS group_members(group_id INT REFERENCES groups_chat(id) ON DELETE CASCADE,user_id INT REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(group_id,user_id));
 CREATE TABLE IF NOT EXISTS messages(id BIGSERIAL PRIMARY KEY,channel_type VARCHAR(20) NOT NULL,channel_id VARCHAR(100) NOT NULL,user_id INT REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW())`);
}
const sign=u=>jwt.sign({id:u.id,username:u.username},JWT_SECRET,{expiresIn:"7d"});
function auth(req,res,next){try{req.user=jwt.verify((req.headers.authorization||"").replace("Bearer ",""),JWT_SECRET);next()}catch{res.status(401).json({error:"未登录或登录已过期"})}}
const user=r=>({id:r.id,username:r.username});

app.post("/api/register",async(req,res)=>{try{
 const username=String(req.body.username||"").trim(),password=String(req.body.password||"");
 if(!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,32}$/.test(username))return res.status(400).json({error:"用户名为2-32位中文、字母、数字或下划线"});
 if(password.length<6)return res.status(400).json({error:"密码至少6位"});
 const h=await bcrypt.hash(password,10),r=await db("INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username",[username,h]);
 res.json({token:sign(r[0]),user:user(r[0])});
}catch(e){res.status(e.code==="23505"?409:500).json({error:e.code==="23505"?"用户名已存在":"注册失败"})}});

app.post("/api/login",async(req,res)=>{const r=await db("SELECT id,username,password_hash FROM users WHERE username=$1",[String(req.body.username||"").trim()]);if(!r[0]||!(await bcrypt.compare(String(req.body.password||""),r[0].password_hash)))return res.status(401).json({error:"用户名或密码错误"});res.json({token:sign(r[0]),user:user(r[0])})});
app.get("/api/me",auth,(req,res)=>res.json({user:{id:req.user.id,username:req.user.username}}));

app.get("/api/friends",auth,async(req,res)=>res.json((await db("SELECT u.id,u.username FROM friendships f JOIN users u ON u.id=f.friend_id WHERE f.user_id=$1",[req.user.id])).map(user)));
app.post("/api/friends",auth,async(req,res)=>{const r=await db("SELECT id,username FROM users WHERE username=$1",[String(req.body.username||"").trim()]);if(!r[0])return res.status(404).json({error:"用户不存在"});if(r[0].id===req.user.id)return res.status(400).json({error:"不能添加自己"});await db("INSERT INTO friendships VALUES($1,$2) ON CONFLICT DO NOTHING",[req.user.id,r[0].id]);await db("INSERT INTO friendships VALUES($1,$2) ON CONFLICT DO NOTHING",[r[0].id,req.user.id]);res.json(user(r[0]))});

app.get("/api/groups",auth,async(req,res)=>res.json(await db("SELECT g.id,g.name,g.invite_code FROM groups_chat g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=$1",[req.user.id])));
app.post("/api/groups",auth,async(req,res)=>{const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"请输入群名称"});const code=crypto.randomBytes(5).toString("hex").toUpperCase();const g=(await db("INSERT INTO groups_chat(name,invite_code,owner_id) VALUES($1,$2,$3) RETURNING id,name,invite_code",[name,code,req.user.id]))[0];await db("INSERT INTO group_members VALUES($1,$2)",[g.id,req.user.id]);res.json(g)});
app.post("/api/groups/join",auth,async(req,res)=>{const g=(await db("SELECT id,name,invite_code FROM groups_chat WHERE invite_code=$1",[String(req.body.inviteCode||"").trim().toUpperCase()]))[0];if(!g)return res.status(404).json({error:"邀请码无效"});await db("INSERT INTO group_members VALUES($1,$2) ON CONFLICT DO NOTHING",[g.id,req.user.id]);res.json(g)});

app.get("/api/messages",auth,async(req,res)=>{const rows=await db("SELECT m.id,m.text,m.created_at,u.id user_id,u.username FROM messages m JOIN users u ON u.id=m.user_id WHERE m.channel_type=$1 AND m.channel_id=$2 ORDER BY m.id DESC LIMIT 100",[String(req.query.type||"public"),String(req.query.id||"public")]);res.json(rows.reverse())});
app.post("/api/messages",auth,async(req,res)=>{const type=String(req.body.type||"public"),id=String(req.body.id||"public"),text=String(req.body.text||"").trim();if(!text)return res.status(400).json({error:"消息不能为空"});const m=(await db("INSERT INTO messages(channel_type,channel_id,user_id,text) VALUES($1,$2,$3,$4) RETURNING id,text,created_at",[type,id,req.user.id,text]))[0];const out={...m,user_id:req.user.id,username:req.user.username,channel_type:type,channel_id:id};io.to(type+":"+id).emit("message",out);res.json(out)});

io.use((s,n)=>{try{s.user=jwt.verify(s.handshake.auth?.token||"",JWT_SECRET);n()}catch{n(new Error("unauthorized"))}});
io.on("connection",s=>{s.on("join",c=>s.join((c.type||"public")+":"+(c.id||"public")))});
app.get("*",(req,res)=>res.sendFile(process.cwd()+"/public/index.html"));
init().then(()=>server.listen(PORT,()=>console.log("running on "+PORT))).catch(e=>{console.error(e);process.exit(1)});
