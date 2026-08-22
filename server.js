import express from "express";
import http from "http";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Server } from "socket.io";

const { Pool } = pg;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = Number(process.env.PORT || 10000);

const JWT_SECRET =
  process.env.JWT_SECRET ||
  "PLEASE_CHANGE_THIS_SECRET";

if (!process.env.DATABASE_URL) {
  console.error("=================================");
  console.error("DATABASE_URL 没有设置");
  console.error("请在 Render Environment 中添加");
  console.error("DATABASE_URL");
  console.error("=================================");

  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", error => {
  console.error("PostgreSQL Pool Error:", error);
});

app.use(express.json({
  limit: "1mb"
}));

app.use(express.static("public"));

/* =========================================================
   数据库工具
========================================================= */

async function db(sql, params = []) {
  const result = await pool.query(
    sql,
    params
  );

  return result.rows;
}

/* =========================================================
   数据库初始化 + 自动迁移旧数据库
========================================================= */

async function initDatabase() {

  console.log("正在初始化数据库...");

  /*
   * users
   */

  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,

      username VARCHAR(32)
        UNIQUE NOT NULL,

      password_hash TEXT
        NOT NULL,

      is_admin BOOLEAN
        NOT NULL DEFAULT FALSE,

      is_muted BOOLEAN
        NOT NULL DEFAULT FALSE,

      is_banned BOOLEAN
        NOT NULL DEFAULT FALSE,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);


  /*
   * 重要：
   * 如果 Render 连接的是以前的数据库，
   * 上面的 CREATE TABLE IF NOT EXISTS
   * 不会自动增加字段。
   *
   * 所以这里进行数据库迁移。
   */

  await db(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_admin
    BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await db(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_muted
    BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await db(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_banned
    BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await db(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS created_at
    TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);


  /*
   * friendships
   */

  await db(`
    CREATE TABLE IF NOT EXISTS friendships (

      user_id INT
        REFERENCES users(id)
        ON DELETE CASCADE,

      friend_id INT
        REFERENCES users(id)
        ON DELETE CASCADE,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        user_id,
        friend_id
      )
    );
  `);


  /*
   * groups
   */

  await db(`
    CREATE TABLE IF NOT EXISTS groups_chat (

      id SERIAL PRIMARY KEY,

      name VARCHAR(80)
        NOT NULL,

      invite_code VARCHAR(32)
        UNIQUE NOT NULL,

      owner_id INT
        REFERENCES users(id)
        ON DELETE CASCADE,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);


  /*
   * group members
   */

  await db(`
    CREATE TABLE IF NOT EXISTS group_members (

      group_id INT
        REFERENCES groups_chat(id)
        ON DELETE CASCADE,

      user_id INT
        REFERENCES users(id)
        ON DELETE CASCADE,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        group_id,
        user_id
      )
    );
  `);


  /*
   * messages
   */

  await db(`
    CREATE TABLE IF NOT EXISTS messages (

      id BIGSERIAL PRIMARY KEY,

      channel_type VARCHAR(20)
        NOT NULL,

      channel_id VARCHAR(120)
        NOT NULL,

      user_id INT
        REFERENCES users(id)
        ON DELETE CASCADE,

      text TEXT
        NOT NULL,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);


  /*
   * 如果旧数据库存在 messages，
   * 也确保字段存在。
   */

  await db(`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS channel_type
    VARCHAR(20);
  `);

  await db(`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS channel_id
    VARCHAR(120);
  `);

  await db(`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS user_id
    INT;
  `);

  await db(`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS text
    TEXT;
  `);

  await db(`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS created_at
    TIMESTAMPTZ
    NOT NULL DEFAULT NOW();
  `);


  /*
   * 索引
   */

  await db(`
    CREATE INDEX IF NOT EXISTS
    messages_channel_idx

    ON messages (
      channel_type,
      channel_id,
      id
    );
  `);


  console.log("数据库初始化完成");
}

/* =========================================================
   自动创建管理员
========================================================= */

async function ensureAdmin() {

  const username =
    String(
      process.env.ADMIN_USERNAME || ""
    ).trim();

  const password =
    String(
      process.env.ADMIN_PASSWORD || ""
    );

  if (!username || !password) {

    console.log(
      "ADMIN_USERNAME / ADMIN_PASSWORD 未设置"
    );

    console.log(
      "不会自动创建管理员"
    );

    return;
  }


  const users =
    await db(
      `
      SELECT
        id,
        username,
        is_admin

      FROM users

      WHERE username = $1
      `,
      [
        username
      ]
    );


  if (users.length > 0) {

    await db(
      `
      UPDATE users

      SET is_admin = TRUE

      WHERE id = $1
      `,
      [
        users[0].id
      ]
    );

    console.log(
      "管理员权限已确认:",
      username
    );

    return;
  }


  const hash =
    await bcrypt.hash(
      password,
      12
    );


  await db(
    `
    INSERT INTO users (
      username,
      password_hash,
      is_admin
    )

    VALUES (
      $1,
      $2,
      TRUE
    )
    `,
    [
      username,
      hash
    ]
  );


  console.log(
    "管理员账号创建成功:",
    username
  );
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
      expiresIn: "7d"
    }
  );
}


/* =========================================================
   获取用户
========================================================= */

async function getUser(id) {

  const users =
    await db(
      `
      SELECT
        id,
        username,
        is_admin,
        is_muted,
        is_banned,
        created_at

      FROM users

      WHERE id = $1
      `,
      [
        id
      ]
    );

  return users[0] || null;
}


/* =========================================================
   登录验证
========================================================= */

function auth(req, res, next) {

  try {

    const header =
      String(
        req.headers.authorization || ""
      );

    const token =
      header.replace(
        /^Bearer\s+/i,
        ""
      );


    if (!token) {

      return res.status(401).json({
        error: "未登录"
      });

    }


    req.user =
      jwt.verify(
        token,
        JWT_SECRET
      );


    next();

  } catch {

    return res.status(401).json({
      error: "登录已过期，请重新登录"
    });

  }
}


/* =========================================================
   管理员验证
========================================================= */

async function requireAdmin(
  req,
  res,
  next
) {

  try {

    const user =
      await getUser(
        req.user.id
      );


    if (!user) {

      return res.status(401).json({
        error: "用户不存在"
      });

    }


    if (!user.is_admin) {

      return res.status(403).json({
        error: "需要管理员权限"
      });

    }


    req.admin = user;

    next();

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "权限检查失败"
    });

  }
}


/* =========================================================
   注册
========================================================= */

app.post(
  "/api/register",
  async (req, res) => {

    try {

      const username =
        String(
          req.body.username || ""
        ).trim();

      const password =
        String(
          req.body.password || ""
        );


      if (
        !/^[A-Za-z0-9_\u4e00-\u9fa5]{2,32}$/
          .test(username)
      ) {

        return res.status(400).json({
          error:
            "用户名需要2-32个字符，只能使用中文、英文、数字和下划线"
        });

      }


      if (password.length < 6) {

        return res.status(400).json({
          error: "密码至少需要6位"
        });

      }


      const existing =
        await db(
          `
          SELECT id

          FROM users

          WHERE username = $1
          `,
          [
            username
          ]
        );


      if (existing.length) {

        return res.status(409).json({
          error: "用户名已经存在"
        });

      }


      const hash =
        await bcrypt.hash(
          password,
          12
        );


      const users =
        await db(
          `
          INSERT INTO users (
            username,
            password_hash
          )

          VALUES (
            $1,
            $2
          )

          RETURNING
            id,
            username,
            is_admin,
            is_muted,
            is_banned
          `,
          [
            username,
            hash
          ]
        );


      const user =
        users[0];


      res.json({

        token:
          createToken(user),

        user

      });

    } catch (error) {

      console.error(
        "注册错误:",
        error
      );

      res.status(500).json({
        error: "注册失败"
      });

    }

  }
);


/* =========================================================
   登录
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {

    try {

      const username =
        String(
          req.body.username || ""
        ).trim();

      const password =
        String(
          req.body.password || ""
        );


      const users =
        await db(
          `
          SELECT
            id,
            username,
            password_hash,
            is_admin,
            is_muted,
            is_banned

          FROM users

          WHERE username = $1
          `,
          [
            username
          ]
        );


      const user =
        users[0];


      if (
        !user ||
        !(await bcrypt.compare(
          password,
          user.password_hash
        ))
      ) {

        return res.status(401).json({
          error:
            "用户名或密码错误"
        });

      }


      if (user.is_banned) {

        return res.status(403).json({
          error:
            "你的账号已被封禁"
        });

      }


      res.json({

        token:
          createToken(user),

        user: {

          id: user.id,

          username:
            user.username,

          is_admin:
            user.is_admin,

          is_muted:
            user.is_muted,

          is_banned:
            user.is_banned

        }

      });

    } catch (error) {

      console.error(
        "登录错误:",
        error
      );

      res.status(500).json({
        error: "登录失败"
      });

    }

  }
);


/* =========================================================
   当前用户
========================================================= */

app.get(
  "/api/me",
  auth,
  async (req, res) => {

    const user =
      await getUser(
        req.user.id
      );


    if (!user) {

      return res.status(404).json({
        error: "用户不存在"
      });

    }


    if (user.is_banned) {

      return res.status(403).json({
        error: "账号已封禁"
      });

    }


    res.json({
      user
    });

  }
);


/* =========================================================
   好友
========================================================= */

app.get(
  "/api/friends",
  auth,
  async (req, res) => {

    try {

      const friends =
        await db(
          `
          SELECT
            u.id,
            u.username,
            u.is_muted,
            u.is_banned

          FROM friendships f

          JOIN users u
            ON u.id = f.friend_id

          WHERE f.user_id = $1

          ORDER BY u.username
          `,
          [
            req.user.id
          ]
        );


      res.json(friends);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "获取好友失败"
      });

    }

  }
);


/* =========================================================
   添加好友
========================================================= */

app.post(
  "/api/friends",
  auth,
  async (req, res) => {

    try {

      const username =
        String(
          req.body.username || ""
        ).trim();


      const users =
        await db(
          `
          SELECT
            id,
            username,
            is_banned

          FROM users

          WHERE username = $1
          `,
          [
            username
          ]
        );


      const target =
        users[0];


      if (!target) {

        return res.status(404).json({
          error: "用户不存在"
        });

      }


      if (
        target.id === req.user.id
      ) {

        return res.status(400).json({
          error: "不能添加自己"
        });

      }


      if (target.is_banned) {

        return res.status(400).json({
          error: "该用户已被封禁"
        });

      }


      await db(
        `
        INSERT INTO friendships (
          user_id,
          friend_id
        )

        VALUES (
          $1,
          $2
        )

        ON CONFLICT DO NOTHING
        `,
        [
          req.user.id,
          target.id
        ]
      );


      await db(
        `
        INSERT INTO friendships (
          user_id,
          friend_id
        )

        VALUES (
          $1,
          $2
        )

        ON CONFLICT DO NOTHING
        `,
        [
          target.id,
          req.user.id
        ]
      );


      res.json({
        success: true,
        user: target
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "添加好友失败"
      });

    }

  }
);


/* =========================================================
   群聊列表
========================================================= */

app.get(
  "/api/groups",
  auth,
  async (req, res) => {

    const groups =
      await db(
        `
        SELECT
          g.id,
          g.name,
          g.invite_code

        FROM groups_chat g

        JOIN group_members gm
          ON gm.group_id = g.id

        WHERE gm.user_id = $1

        ORDER BY g.created_at DESC
        `,
        [
          req.user.id
        ]
      );


    res.json(groups);

  }
);


/* =========================================================
   创建群聊
========================================================= */

app.post(
  "/api/groups",
  auth,
  async (req, res) => {

    try {

      const name =
        String(
          req.body.name || ""
        ).trim();


      if (!name) {

        return res.status(400).json({
          error: "请输入群名称"
        });

      }


      if (name.length > 80) {

        return res.status(400).json({
          error: "群名称最多80个字符"
        });

      }


      const inviteCode =
        crypto
          .randomBytes(6)
          .toString("hex")
          .toUpperCase();


      const groups =
        await db(
          `
          INSERT INTO groups_chat (
            name,
            invite_code,
            owner_id
          )

          VALUES (
            $1,
            $2,
            $3
          )

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


      const group =
        groups[0];


      await db(
        `
        INSERT INTO group_members (
          group_id,
          user_id
        )

        VALUES (
          $1,
          $2
        )
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

  }
);


/* =========================================================
   加入群聊
========================================================= */

app.post(
  "/api/groups/join",
  auth,
  async (req, res) => {

    try {

      const inviteCode =
        String(
          req.body.inviteCode || ""
        )
          .trim()
          .toUpperCase();


      const groups =
        await db(
          `
          SELECT
            id,
            name,
            invite_code

          FROM groups_chat

          WHERE invite_code = $1
          `,
          [
            inviteCode
          ]
        );


      const group =
        groups[0];


      if (!group) {

        return res.status(404).json({
          error: "邀请码无效"
        });

      }


      await db(
        `
        INSERT INTO group_members (
          group_id,
          user_id
        )

        VALUES (
          $1,
          $2
        )

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

  }
);


/* =========================================================
   检查聊天权限
========================================================= */

async function canAccess(
  userId,
  type,
  id
) {

  if (type === "public") {

    return id === "public";

  }


  if (type === "private") {

    if (
      !/^\d+$/.test(id)
    ) {

      return false;

    }


    const result =
      await db(
        `
        SELECT 1

        FROM friendships

        WHERE
          user_id = $1
          AND friend_id = $2
        `,
        [
          userId,
          Number(id)
        ]
      );


    return result.length > 0;

  }


  if (type === "group") {

    if (
      !/^\d+$/.test(id)
    ) {

      return false;

    }


    const result =
      await db(
        `
        SELECT 1

        FROM group_members

        WHERE
          group_id = $1
          AND user_id = $2
        `,
        [
          Number(id),
          userId
        ]
      );


    return result.length > 0;

  }


  return false;
}


/* =========================================================
   获取消息
========================================================= */

app.get(
  "/api/messages",
  auth,
  async (req, res) => {

    try {

      const type =
        String(
          req.query.type ||
          "public"
        );


      const id =
        String(
          req.query.id ||
          "public"
        );


      const allowed =
        await canAccess(
          req.user.id,
          type,
          id
        );


      if (!allowed) {

        return res.status(403).json({
          error: "没有聊天权限"
        });

      }


      const messages =
        await db(
          `
          SELECT

            m.id,

            m.text,

            m.created_at,

            m.channel_type,

            m.channel_id,

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
        messages.reverse()
      );

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "获取消息失败"
      });

    }

  }
);


/* =========================================================
   发送消息
========================================================= */

app.post(
  "/api/messages",
  auth,
  async (req, res) => {

    try {

      const user =
        await getUser(
          req.user.id
        );


      if (!user) {

        return res.status(401).json({
          error: "用户不存在"
        });

      }


      if (user.is_banned) {

        return res.status(403).json({
          error: "你的账号已被封禁"
        });

      }


      if (user.is_muted) {

        return res.status(403).json({
          error: "你已被管理员禁言"
        });

      }


      const type =
        String(
          req.body.type ||
          "public"
        );


      const id =
        String(
          req.body.id ||
          "public"
        );


      const text =
        String(
          req.body.text ||
          ""
        ).trim();


      if (!text) {

        return res.status(400).json({
          error: "消息不能为空"
        });

      }


      if (text.length > 2000) {

        return res.status(400).json({
          error: "消息最多2000字"
        });

      }


      const allowed =
        await canAccess(
          req.user.id,
          type,
          id
        );


      if (!allowed) {

        return res.status(403).json({
          error: "没有聊天权限"
        });

      }


      const messages =
        await db(
          `
          INSERT INTO messages (
            channel_type,
            channel_id,
            user_id,
            text
          )

          VALUES (
            $1,
            $2,
            $3,
            $4
          )

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

        ...messages[0],

        channel_type:
          type,

        channel_id:
          id,

        user_id:
          req.user.id,

        username:
          user.username

      };


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

  }
);


/* =========================================================
   管理员：用户列表
========================================================= */

app.get(
  "/api/admin/users",
  auth,
  requireAdmin,
  async (req, res) => {

    try {

      const users =
        await db(
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


      res.json(users);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "获取用户列表失败"
      });

    }

  }
);


/* =========================================================
   管理员操作
========================================================= */

async function moderation(
  req,
  res,
  field,
  value
) {

  try {

    const id =
      Number(
        req.params.id
      );


    if (!Number.isInteger(id)) {

      return res.status(400).json({
        error: "用户ID无效"
      });

    }


    if (
      id === req.user.id
    ) {

      return res.status(400).json({
        error: "不能操作自己"
      });

    }


    const target =
      await getUser(id);


    if (!target) {

      return res.status(404).json({
        error: "用户不存在"
      });

    }


    if (target.is_admin) {

      return res.status(403).json({
        error: "不能操作管理员"
      });

    }


    await db(
      `
      UPDATE users

      SET ${field} = $1

      WHERE id = $2
      `,
      [
        value,
        id
      ]
    );


    io.emit(
      "user_moderated",
      {
        userId: id,
        field,
        value
      }
    );


    res.json({
      success: true
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "操作失败"
    });

  }
}


/* 禁言 */

app.post(
  "/api/admin/users/:id/mute",
  auth,
  requireAdmin,
  (req, res) =>
    moderation(
      req,
      res,
      "is_muted",
      true
    )
);


/* 解禁言 */

app.post(
  "/api/admin/users/:id/unmute",
  auth,
  requireAdmin,
  (req, res) =>
    moderation(
      req,
      res,
      "is_muted",
      false
    )
);


/* 封禁 */

app.post(
  "/api/admin/users/:id/ban",
  auth,
  requireAdmin,
  (req, res) =>
    moderation(
      req,
      res,
      "is_banned",
      true
    )
);


/* 解封 */

app.post(
  "/api/admin/users/:id/unban",
  auth,
  requireAdmin,
  (req, res) =>
    moderation(
      req,
      res,
      "is_banned",
      false
    )
);


/* =========================================================
   Socket.IO 身份验证
========================================================= */

io.use(
  (socket, next) => {

    try {

      const token =
        socket.handshake
          ?.auth
          ?.token;


      if (!token) {

        return next(
          new Error(
            "没有登录凭证"
          )
        );

      }


      socket.user =
        jwt.verify(
          token,
          JWT_SECRET
        );


      next();

    } catch {

      next(
        new Error(
          "Socket 身份验证失败"
        )
      );

    }

  }
);


/* =========================================================
   Socket.IO
========================================================= */

io.on(
  "connection",
  socket => {

    console.log(
      "Socket connected:",
      socket.user.username
    );


    socket.on(
      "join",
      async ({
        type = "public",
        id = "public"
      } = {}) => {

        try {

          const allowed =
            await canAccess(
              socket.user.id,
              type,
              String(id)
            );


          if (!allowed) {

            return;

          }


          socket.join(
            `${type}:${id}`
          );

        } catch (error) {

          console.error(
            "Socket join error:",
            error
          );

        }

      }
    );


    socket.on(
      "disconnect",
      () => {

        console.log(
          "Socket disconnected:",
          socket.user.username
        );

      }
    );

  }
);


/* =========================================================
   SPA 回退
========================================================= */

/*
 * 注意：
 *
 * 不要写：
 *
 * app.get("*", ...)
 *
 * Express 5 会出现：
 *
 * PathError:
 * Missing parameter name at index 1: *
 *
 * 所以这里使用普通 middleware。
 */

app.use(
  (req, res) => {

    res.sendFile(
      process.cwd() +
      "/public/index.html"
    );

  }
);


/* =========================================================
   启动
========================================================= */

async function start() {

  try {

    await initDatabase();

    await ensureAdmin();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "================================="
        );

        console.log(
          `简聊服务器运行于端口 ${PORT}`
        );

        console.log(
          "================================="
        );

      }
    );

  } catch (error) {

    console.error(
      "服务器启动失败:",
      error
    );

    process.exit(1);

  }

}


start();
