import express from "express";
import http from "http";
import { Server } from "socket.io";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const { Pool } = pg;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

if (!process.env.DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json());
app.use(express.static("public"));


// =========================
// 数据库
// =========================

async function db(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function initDatabase() {
  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS friendships (
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      friend_id INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS groups_chat (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      invite_code VARCHAR(16) UNIQUE NOT NULL,
      owner_id INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INT REFERENCES groups_chat(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      channel_type VARCHAR(20) NOT NULL,
      channel_id VARCHAR(100) NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("✅ Database initialized");
}


// =========================
// JWT
// =========================

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}


function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    const token = header.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        error: "未登录"
      });
    }

    req.user = jwt.verify(token, JWT_SECRET);

    next();

  } catch (error) {
    return res.status(401).json({
      error: "登录已过期，请重新登录"
    });
  }
}


function publicUser(row) {
  return {
    id: row.id,
    username: row.username
  };
}


// =========================
// 注册
// =========================

app.post("/api/register", async (req, res) => {

  try {

    const username = String(
      req.body.username || ""
    ).trim();

    const password = String(
      req.body.password || ""
    );

    if (
      !/^[\u4e00-\u9fa5A-Za-z0-9_]{2,32}$/.test(username)
    ) {
      return res.status(400).json({
        error: "用户名需要2-32位中文、字母、数字或下划线"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "密码至少需要6位"
      });
    }

    const passwordHash = await bcrypt.hash(
      password,
      10
    );

    const rows = await db(
      `
      INSERT INTO users
      (username, password_hash)
      VALUES ($1, $2)
      RETURNING id, username
      `,
      [
        username,
        passwordHash
      ]
    );

    const user = rows[0];

    const token = createToken(user);

    res.json({
      token,
      user: publicUser(user)
    });

  } catch (error) {

    console.error(error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "用户名已经存在"
      });
    }

    res.status(500).json({
      error: "注册失败"
    });
  }

});


// =========================
// 登录
// =========================

app.post("/api/login", async (req, res) => {

  try {

    const username = String(
      req.body.username || ""
    ).trim();

    const password = String(
      req.body.password || ""
    );

    const rows = await db(
      `
      SELECT
        id,
        username,
        password_hash
      FROM users
      WHERE username = $1
      `,
      [username]
    );

    if (!rows[0]) {
      return res.status(401).json({
        error: "用户名或密码错误"
      });
    }

    const user = rows[0];

    const passwordCorrect =
      await bcrypt.compare(
        password,
        user.password_hash
      );

    if (!passwordCorrect) {
      return res.status(401).json({
        error: "用户名或密码错误"
      });
    }

    const token = createToken(user);

    res.json({
      token,
      user: publicUser(user)
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "登录失败"
    });

  }

});


// =========================
// 当前用户
// =========================

app.get("/api/me", auth, async (req, res) => {

  res.json({
    user: {
      id: req.user.id,
      username: req.user.username
    }
  });

});


// =========================
// 好友列表
// =========================

app.get("/api/friends", auth, async (req, res) => {

  try {

    const rows = await db(
      `
      SELECT
        u.id,
        u.username
      FROM friendships f
      JOIN users u
        ON u.id = f.friend_id
      WHERE f.user_id = $1
      ORDER BY u.username
      `,
      [req.user.id]
    );

    res.json(
      rows.map(publicUser)
    );

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "获取好友失败"
    });

  }

});


// =========================
// 添加好友
// =========================

app.post("/api/friends", auth, async (req, res) => {

  try {

    const username = String(
      req.body.username || ""
    ).trim();

    const rows = await db(
      `
      SELECT
        id,
        username
      FROM users
      WHERE username = $1
      `,
      [username]
    );

    if (!rows[0]) {
      return res.status(404).json({
        error: "用户不存在"
      });
    }

    const friend = rows[0];

    if (friend.id === req.user.id) {
      return res.status(400).json({
        error: "不能添加自己"
      });
    }

    await db(
      `
      INSERT INTO friendships
      (user_id, friend_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [
        req.user.id,
        friend.id
      ]
    );

    await db(
      `
      INSERT INTO friendships
      (user_id, friend_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [
        friend.id,
        req.user.id
      ]
    );

    res.json(
      publicUser(friend)
    );

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "添加好友失败"
    });

  }

});


// =========================
// 获取群聊
// =========================

app.get("/api/groups", auth, async (req, res) => {

  try {

    const rows = await db(
      `
      SELECT
        g.id,
        g.name,
        g.invite_code
      FROM groups_chat g
      JOIN group_members m
        ON m.group_id = g.id
      WHERE m.user_id = $1
      ORDER BY g.created_at DESC
      `,
      [req.user.id]
    );

    res.json(rows);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "获取群聊失败"
    });

  }

});


// =========================
// 创建群聊
// =========================

app.post("/api/groups", auth, async (req, res) => {

  try {

    const name = String(
      req.body.name || ""
    ).trim();

    if (!name) {
      return res.status(400).json({
        error: "请输入群名称"
      });
    }

    if (name.length > 80) {
      return res.status(400).json({
        error: "群名称不能超过80个字符"
      });
    }

    const inviteCode =
      crypto
        .randomBytes(5)
        .toString("hex")
        .toUpperCase();

    const rows = await db(
      `
      INSERT INTO groups_chat
      (name, invite_code, owner_id)
      VALUES ($1, $2, $3)
      RETURNING
        id,
        name,
        invite_code
      `,
      [
        name,
        inviteCode,
        req.user.id
      ]
    );

    const group = rows[0];

    await db(
      `
      INSERT INTO group_members
      (group_id, user_id)
      VALUES ($1, $2)
      `,
      [
        group.id,
        req.user.id
      ]
    );

    res.json(group);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "创建群聊失败"
    });

  }

});


// =========================
// 加入群聊
// =========================

app.post("/api/groups/join", auth, async (req, res) => {

  try {

    const inviteCode = String(
      req.body.inviteCode || ""
    )
      .trim()
      .toUpperCase();

    const rows = await db(
      `
      SELECT
        id,
        name,
        invite_code
      FROM groups_chat
      WHERE invite_code = $1
      `,
      [inviteCode]
    );

    if (!rows[0]) {
      return res.status(404).json({
        error: "邀请码无效"
      });
    }

    const group = rows[0];

    await db(
      `
      INSERT INTO group_members
      (group_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [
        group.id,
        req.user.id
      ]
    );

    res.json(group);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "加入群聊失败"
    });

  }

});


// =========================
// 获取消息
// =========================

app.get("/api/messages", auth, async (req, res) => {

  try {

    const type = String(
      req.query.type || "public"
    );

    const id = String(
      req.query.id || "public"
    );

    const rows = await db(
      `
      SELECT
        m.id,
        m.text,
        m.created_at,
        u.id AS user_id,
        u.username
      FROM messages m
      JOIN users u
        ON u.id = m.user_id
      WHERE
        m.channel_type = $1
        AND m.channel_id = $2
      ORDER BY m.id DESC
      LIMIT 100
      `,
      [
        type,
        id
      ]
    );

    res.json(
      rows.reverse()
    );

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "获取消息失败"
    });

  }

});


// =========================
// 发送消息
// =========================

app.post("/api/messages", auth, async (req, res) => {

  try {

    const type = String(
      req.body.type || "public"
    );

    const id = String(
      req.body.id || "public"
    );

    const text = String(
      req.body.text || ""
    ).trim();

    if (!text) {
      return res.status(400).json({
        error: "消息不能为空"
      });
    }

    if (text.length > 2000) {
      return res.status(400).json({
        error: "消息不能超过2000字"
      });
    }

    const rows = await db(
      `
      INSERT INTO messages
      (
        channel_type,
        channel_id,
        user_id,
        text
      )
      VALUES
      ($1, $2, $3, $4)
      RETURNING
        id,
        text,
        created_at
      `,
      [
        type,
        id,
        req.user.id,
        text
      ]
    );

    const message = {
      ...rows[0],
      user_id: req.user.id,
      username: req.user.username,
      channel_type: type,
      channel_id: id
    };

    // 实时发送给当前频道所有用户
    io
      .to(`${type}:${id}`)
      .emit(
        "message",
        message
      );

    res.json(message);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "发送消息失败"
    });

  }

});


// =========================
// Socket.IO 身份验证
// =========================

io.use((socket, next) => {

  try {

    const token =
      socket.handshake.auth?.token;

    if (!token) {
      return next(
        new Error("未登录")
      );
    }

    socket.user =
      jwt.verify(
        token,
        JWT_SECRET
      );

    next();

  } catch (error) {

    next(
      new Error("身份验证失败")
    );

  }

});


// =========================
// Socket.IO
// =========================

io.on("connection", (socket) => {

  console.log(
    `用户 ${socket.user.username} 已连接`
  );

  socket.on(
    "join",
    ({
      type = "public",
      id = "public"
    }) => {

      const room =
        `${type}:${id}`;

      socket.join(room);

      console.log(
        `${socket.user.username} 加入 ${room}`
      );

    }
  );

  socket.on(
    "disconnect",
    () => {

      console.log(
        `用户 ${socket.user.username} 已断开`
      );

    }
  );

});


// =========================
// 前端页面
// =========================

// ⚠️ 这里是修复 Express 5 的关键
// 不再使用 app.get("*")
app.use((req, res) => {

  res.sendFile(
    process.cwd() +
    "/public/index.html"
  );

});


// =========================
// 启动
// =========================

async function start() {

  try {

    await initDatabase();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `🚀 Chat server running on port ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "❌ Server startup failed:"
    );

    console.error(error);

    process.exit(1);

  }

}

start();
