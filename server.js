import express from "express";
import http from "http";
import { Server } from "socket.io";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("没有找到 DATABASE_URL");
    process.exit(1);
}

const JWT_SECRET =
    process.env.JWT_SECRET ||
    "change-this-secret-in-render";

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/* =========================================================
   数据库
========================================================= */

async function db(sql, params = []) {
    return pool.query(sql, params);
}

async function migrateDatabase() {
    console.log("正在检查数据库结构...");

    await db(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(32) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin BOOLEAN NOT NULL DEFAULT FALSE,
            is_muted BOOLEAN NOT NULL DEFAULT FALSE,
            is_banned BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    /*
     * 关键：
     * 使用 IF NOT EXISTS。
     *
     * 这样旧数据库即使没有 is_admin，
     * Render 重启时也会自动补上。
     */

    await db(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin
        BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await db(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_muted
        BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await db(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_banned
        BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await db(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            room_id INTEGER,
            receiver_id INTEGER,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db(`
        CREATE TABLE IF NOT EXISTS friendships (
            id SERIAL PRIMARY KEY,
            requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(requester_id, receiver_id)
        )
    `);

    await db(`
        CREATE TABLE IF NOT EXISTS rooms (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            code VARCHAR(20) UNIQUE NOT NULL,
            owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db(`
        CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(room_id, user_id)
        )
    `);

    console.log("数据库初始化完成");
}

/* =========================================================
   JWT
========================================================= */

function createToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username
        },
        JWT_SECRET,
        {
            expiresIn: "30d"
        }
    );
}

function auth(req, res, next) {
    try {
        const header = req.headers.authorization;

        if (!header) {
            return res.status(401).json({
                error: "未登录"
            });
        }

        const token = header.replace("Bearer ", "");

        const decoded = jwt.verify(token, JWT_SECRET);

        req.user = decoded;

        next();
    } catch {
        res.status(401).json({
            error: "登录已过期"
        });
    }
}

async function getUser(id) {
    const result = await db(
        `
        SELECT
            id,
            username,
            is_admin,
            is_muted,
            is_banned,
            created_at
        FROM users
        WHERE id=$1
        `,
        [id]
    );

    return result.rows[0];
}

async function adminAuth(req, res, next) {
    try {
        const user = await getUser(req.user.id);

        if (!user || !user.is_admin) {
            return res.status(403).json({
                error: "没有管理员权限"
            });
        }

        req.admin = user;

        next();
    } catch {
        res.status(500).json({
            error: "服务器错误"
        });
    }
}

/* =========================================================
   注册
========================================================= */

app.post("/api/register", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        if (username.length < 2 || username.length > 32) {
            return res.status(400).json({
                error: "用户名需要 2-32 个字符"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "密码至少 6 位"
            });
        }

        const exists = await db(
            "SELECT id FROM users WHERE username=$1",
            [username]
        );

        if (exists.rows.length) {
            return res.status(400).json({
                error: "用户名已经存在"
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await db(
            `
            INSERT INTO users
            (username, password_hash)
            VALUES ($1,$2)
            RETURNING id, username, is_admin
            `,
            [username, passwordHash]
        );

        const user = result.rows[0];

        res.json({
            token: createToken(user),
            user
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "注册失败"
        });
    }
});

/* =========================================================
   登录
========================================================= */

app.post("/api/login", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        const result = await db(
            `
            SELECT *
            FROM users
            WHERE username=$1
            `,
            [username]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: "用户名或密码错误"
            });
        }

        const user = result.rows[0];

        if (user.is_banned) {
            return res.status(403).json({
                error: "你的账号已经被封禁"
            });
        }

        const valid = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!valid) {
            return res.status(401).json({
                error: "用户名或密码错误"
            });
        }

        res.json({
            token: createToken(user),
            user: {
                id: user.id,
                username: user.username,
                is_admin: user.is_admin,
                is_muted: user.is_muted
            }
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "登录失败"
        });
    }
});

/* =========================================================
   当前用户
========================================================= */

app.get("/api/me", auth, async (req, res) => {
    const user = await getUser(req.user.id);

    if (!user) {
        return res.status(404).json({
            error: "用户不存在"
        });
    }

    if (user.is_banned) {
        return res.status(403).json({
            error: "账号已被封禁"
        });
    }

    res.json(user);
});

/* =========================================================
   用户搜索
========================================================= */

app.get("/api/users/search", auth, async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();

        if (!q) {
            return res.json([]);
        }

        const result = await db(
            `
            SELECT
                id,
                username,
                is_admin
            FROM users
            WHERE username ILIKE $1
            AND id <> $2
            AND is_banned=false
            ORDER BY username
            LIMIT 20
            `,
            [`%${q}%`, req.user.id]
        );

        res.json(result.rows);

    } catch {
        res.status(500).json({
            error: "搜索失败"
        });
    }
});

/* =========================================================
   好友申请
========================================================= */

app.post("/api/friends/request", auth, async (req, res) => {
    try {
        const targetId = Number(req.body.userId);

        if (!targetId || targetId === req.user.id) {
            return res.status(400).json({
                error: "无效用户"
            });
        }

        const target = await getUser(targetId);

        if (!target) {
            return res.status(404).json({
                error: "用户不存在"
            });
        }

        const existing = await db(
            `
            SELECT *
            FROM friendships
            WHERE
            (requester_id=$1 AND receiver_id=$2)
            OR
            (requester_id=$2 AND receiver_id=$1)
            `,
            [req.user.id, targetId]
        );

        if (existing.rows.length) {
            const friendship = existing.rows[0];

            if (friendship.status === "accepted") {
                return res.status(400).json({
                    error: "你们已经是好友"
                });
            }

            if (
                friendship.requester_id === targetId &&
                friendship.receiver_id === req.user.id
            ) {
                await db(
                    `
                    UPDATE friendships
                    SET status='accepted'
                    WHERE id=$1
                    `,
                    [friendship.id]
                );

                return res.json({
                    success: true,
                    message: "已自动同意对方的好友申请"
                });
            }

            return res.status(400).json({
                error: "好友申请已经发送"
            });
        }

        await db(
            `
            INSERT INTO friendships
            (requester_id, receiver_id, status)
            VALUES ($1,$2,'pending')
            `,
            [req.user.id, targetId]
        );

        notifyUser(targetId, {
            type: "friend_request"
        });

        res.json({
            success: true,
            message: "好友申请已发送"
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "发送好友申请失败"
        });
    }
});

/* =========================================================
   获取好友申请
========================================================= */

app.get("/api/friends/requests", auth, async (req, res) => {
    const result = await db(
        `
        SELECT
            f.id,
            f.created_at,
            u.id AS user_id,
            u.username
        FROM friendships f
        JOIN users u
        ON u.id=f.requester_id
        WHERE
            f.receiver_id=$1
            AND f.status='pending'
        ORDER BY f.created_at DESC
        `,
        [req.user.id]
    );

    res.json(result.rows);
});

/* =========================================================
   同意好友申请
========================================================= */

app.post("/api/friends/accept", auth, async (req, res) => {
    const id = Number(req.body.id);

    const result = await db(
        `
        UPDATE friendships
        SET status='accepted'
        WHERE
            id=$1
            AND receiver_id=$2
            AND status='pending'
        RETURNING *
        `,
        [id, req.user.id]
    );

    if (!result.rows.length) {
        return res.status(404).json({
            error: "申请不存在"
        });
    }

    const friendship = result.rows[0];

    notifyUser(friendship.requester_id, {
        type: "friend_accepted"
    });

    res.json({
        success: true
    });
});

/* =========================================================
   拒绝好友申请
========================================================= */

app.post("/api/friends/reject", auth, async (req, res) => {
    const id = Number(req.body.id);

    await db(
        `
        UPDATE friendships
        SET status='rejected'
        WHERE
            id=$1
            AND receiver_id=$2
        `,
        [id, req.user.id]
    );

    res.json({
        success: true
    });
});

/* =========================================================
   好友列表
========================================================= */

app.get("/api/friends", auth, async (req, res) => {
    const result = await db(
        `
        SELECT
            u.id,
            u.username,
            u.is_admin,
            u.is_muted,
            u.is_banned
        FROM friendships f
        JOIN users u
        ON
            u.id =
            CASE
                WHEN f.requester_id=$1
                THEN f.receiver_id
                ELSE f.requester_id
            END
        WHERE
            (
                f.requester_id=$1
                OR f.receiver_id=$1
            )
            AND f.status='accepted'
        ORDER BY u.username
        `,
        [req.user.id]
    );

    res.json(result.rows);
});

/* =========================================================
   创建群聊
========================================================= */

app.post("/api/rooms", auth, async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();

        if (!name) {
            return res.status(400).json({
                error: "请输入群聊名称"
            });
        }

        const code =
            crypto.randomBytes(4)
                .toString("hex")
                .toUpperCase();

        const result = await db(
            `
            INSERT INTO rooms
            (name, code, owner_id)
            VALUES ($1,$2,$3)
            RETURNING *
            `,
            [name, code, req.user.id]
        );

        const room = result.rows[0];

        await db(
            `
            INSERT INTO room_members
            (room_id,user_id)
            VALUES ($1,$2)
            `,
            [room.id, req.user.id]
        );

        res.json(room);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "创建群聊失败"
        });
    }
});

/* =========================================================
   群聊列表
========================================================= */

app.get("/api/rooms", auth, async (req, res) => {
    const result = await db(
        `
        SELECT
            r.id,
            r.name,
            r.code,
            r.owner_id,
            r.created_at
        FROM rooms r
        JOIN room_members rm
        ON rm.room_id=r.id
        WHERE rm.user_id=$1
        ORDER BY r.created_at DESC
        `,
        [req.user.id]
    );

    res.json(result.rows);
});

/* =========================================================
   通过群聊码加入
========================================================= */

app.post("/api/rooms/join", auth, async (req, res) => {
    try {
        const code = String(req.body.code || "")
            .trim()
            .toUpperCase();

        const result = await db(
            `
            SELECT *
            FROM rooms
            WHERE code=$1
            `,
            [code]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                error: "群聊不存在"
            });
        }

        const room = result.rows[0];

        await db(
            `
            INSERT INTO room_members
            (room_id,user_id)
            VALUES ($1,$2)
            ON CONFLICT DO NOTHING
            `,
            [room.id, req.user.id]
        );

        res.json({
            success: true,
            room
        });

    } catch {
        res.status(500).json({
            error: "加入群聊失败"
        });
    }
});

/* =========================================================
   群聊成员检查
========================================================= */

async function isRoomMember(roomId, userId) {
    const result = await db(
        `
        SELECT 1
        FROM room_members
        WHERE room_id=$1
        AND user_id=$2
        `,
        [roomId, userId]
    );

    return result.rows.length > 0;
}

/* =========================================================
   获取公共聊天
========================================================= */

app.get("/api/messages/public", auth, async (req, res) => {
    const result = await db(
        `
        SELECT
            m.id,
            m.content,
            m.created_at,
            u.id AS user_id,
            u.username
        FROM messages m
        JOIN users u
        ON u.id=m.user_id
        WHERE
            m.room_id IS NULL
            AND m.receiver_id IS NULL
        ORDER BY m.id DESC
        LIMIT 100
        `
    );

    res.json(result.rows.reverse());
});

/* =========================================================
   获取私聊
========================================================= */

app.get("/api/messages/private/:userId", auth, async (req, res) => {
    const targetId = Number(req.params.userId);

    const result = await db(
        `
        SELECT
            m.id,
            m.content,
            m.created_at,
            u.id AS user_id,
            u.username
        FROM messages m
        JOIN users u
        ON u.id=m.user_id
        WHERE
            m.room_id IS NULL
            AND (
                (m.user_id=$1 AND m.receiver_id=$2)
                OR
                (m.user_id=$2 AND m.receiver_id=$1)
            )
        ORDER BY m.id DESC
        LIMIT 100
        `,
        [req.user.id, targetId]
    );

    res.json(result.rows.reverse());
});

/* =========================================================
   获取群聊消息
========================================================= */

app.get("/api/messages/room/:roomId", auth, async (req, res) => {
    const roomId = Number(req.params.roomId);

    if (!(await isRoomMember(roomId, req.user.id))) {
        return res.status(403).json({
            error: "你不是群成员"
        });
    }

    const result = await db(
        `
        SELECT
            m.id,
            m.content,
            m.created_at,
            u.id AS user_id,
            u.username
        FROM messages m
        JOIN users u
        ON u.id=m.user_id
        WHERE m.room_id=$1
        ORDER BY m.id DESC
        LIMIT 100
        `,
        [roomId]
    );

    res.json(result.rows.reverse());
});

/* =========================================================
   Socket
========================================================= */

const onlineUsers = new Map();

function notifyUser(userId, data) {
    const socketId = onlineUsers.get(Number(userId));

    if (socketId) {
        io.to(socketId).emit("notification", data);
    }
}

io.on("connection", socket => {

    socket.on("auth", async token => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            socket.userId = decoded.id;
            socket.username = decoded.username;

            onlineUsers.set(
                Number(decoded.id),
                socket.id
            );

            socket.emit("ready");

        } catch {
            socket.disconnect();
        }
    });

    socket.on("send_message", async data => {
        try {
            if (!socket.userId) return;

            const user = await getUser(socket.userId);

            if (!user) return;

            if (user.is_banned) {
                socket.emit("error_message", {
                    error: "你的账号已经被封禁"
                });
                return;
            }

            if (user.is_muted) {
                socket.emit("error_message", {
                    error: "你目前被禁言"
                });
                return;
            }

            const content = String(data.content || "").trim();

            if (!content || content.length > 2000) {
                return;
            }

            const roomId = data.roomId
                ? Number(data.roomId)
                : null;

            const receiverId = data.receiverId
                ? Number(data.receiverId)
                : null;

            if (roomId) {
                if (!(await isRoomMember(
                    roomId,
                    socket.userId
                ))) {
                    return;
                }
            }

            const result = await db(
                `
                INSERT INTO messages
                (user_id, room_id, receiver_id, content)
                VALUES ($1,$2,$3,$4)
                RETURNING
                    id,
                    content,
                    created_at
                `,
                [
                    socket.userId,
                    roomId,
                    receiverId,
                    content
                ]
            );

            const message = {
                id: result.rows[0].id,
                content: result.rows[0].content,
                created_at: result.rows[0].created_at,
                user_id: socket.userId,
                username: socket.username
            };

            /*
             * 公共频道
             */
            if (!roomId && !receiverId) {
                io.emit("new_message", {
                    type: "public",
                    message
                });
            }

            /*
             * 群聊
             */
            else if (roomId) {
                io.emit("new_message", {
                    type: "room",
                    roomId,
                    message
                });
            }

            /*
             * 私聊
             */
            else if (receiverId) {
                notifyUser(receiverId, {
                    type: "private_message",
                    message
                });

                notifyUser(socket.userId, {
                    type: "private_message",
                    message
                });
            }

        } catch (error) {
            console.error(error);
        }
    });

    socket.on("disconnect", () => {
        if (socket.userId) {
            onlineUsers.delete(Number(socket.userId));
        }
    });
});

/* =========================================================
   管理员
========================================================= */

/*
 * 管理员初始化：
 *
 * Render 环境变量：
 *
 * ADMIN_USERNAME=admin
 * ADMIN_PASSWORD=123456
 *
 * 第一次启动自动创建管理员。
 */

async function ensureAdmin() {
    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;

    if (!username || !password) {
        console.log(
            "未设置 ADMIN_USERNAME / ADMIN_PASSWORD，跳过管理员初始化"
        );
        return;
    }

    const result = await db(
        "SELECT id FROM users WHERE username=$1",
        [username]
    );

    if (result.rows.length) {
        await db(
            `
            UPDATE users
            SET is_admin=true
            WHERE username=$1
            `,
            [username]
        );

        console.log(
            `管理员 ${username} 权限已确认`
        );

        return;
    }

    const passwordHash = await bcrypt.hash(
        password,
        12
    );

    await db(
        `
        INSERT INTO users
        (
            username,
            password_hash,
            is_admin
        )
        VALUES ($1,$2,true)
        `,
        [username, passwordHash]
    );

    console.log(
        `管理员 ${username} 创建完成`
    );
}

/* =========================================================
   管理员用户列表
========================================================= */

app.get(
    "/api/admin/users",
    auth,
    adminAuth,
    async (req, res) => {

        const result = await db(
            `
            SELECT
                id,
                username,
                is_admin,
                is_muted,
                is_banned,
                created_at
            FROM users
            ORDER BY id DESC
            `
        );

        res.json(result.rows);
    }
);

/* =========================================================
   禁言
========================================================= */

app.post(
    "/api/admin/users/:id/mute",
    auth,
    adminAuth,
    async (req, res) => {

        const id = Number(req.params.id);

        await db(
            `
            UPDATE users
            SET is_muted=true
            WHERE id=$1
            `,
            [id]
        );

        notifyUser(id, {
            type: "account_status",
            message: "你已被管理员禁言"
        });

        res.json({
            success: true
        });
    }
);

/* =========================================================
   解禁
========================================================= */

app.post(
    "/api/admin/users/:id/unmute",
    auth,
    adminAuth,
    async (req, res) => {

        const id = Number(req.params.id);

        await db(
            `
            UPDATE users
            SET is_muted=false
            WHERE id=$1
            `,
            [id]
        );

        notifyUser(id, {
            type: "account_status",
            message: "你已被解除禁言"
        });

        res.json({
            success: true
        });
    }
);

/* =========================================================
   封禁
========================================================= */

app.post(
    "/api/admin/users/:id/ban",
    auth,
    adminAuth,
    async (req, res) => {

        const id = Number(req.params.id);

        if (id === req.user.id) {
            return res.status(400).json({
                error: "不能封禁自己"
            });
        }

        await db(
            `
            UPDATE users
            SET is_banned=true
            WHERE id=$1
            `,
            [id]
        );

        notifyUser(id, {
            type: "account_banned",
            message: "你的账号已被管理员封禁"
        });

        res.json({
            success: true
        });
    }
);

/* =========================================================
   解封
========================================================= */

app.post(
    "/api/admin/users/:id/unban",
    auth,
    adminAuth,
    async (req, res) => {

        const id = Number(req.params.id);

        await db(
            `
            UPDATE users
            SET is_banned=false
            WHERE id=$1
            `,
            [id]
        );

        res.json({
            success: true
        });
    }
);

/* =========================================================
   SPA
========================================================= */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

/*
 * Express 5 + path-to-regexp：
 *
 * 不要写：
 *
 * app.get("*", ...)
 *
 * 否则会出现：
 *
 * Missing parameter name at index 1: *
 *
 * 所以这里不使用 * 路由。
 */

async function start() {
    try {
        await migrateDatabase();
        await ensureAdmin();

        server.listen(PORT, "0.0.0.0", () => {
            console.log(
                `服务器启动成功: ${PORT}`
            );
        });

    } catch (error) {
        console.error(
            "服务器启动失败:",
            error
        );

        process.exit(1);
    }
}

start();
