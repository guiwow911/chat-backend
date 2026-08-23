let token = localStorage.getItem("chat_token");
let me = null;
let socket = null;

let currentType = "public";
let currentUserId = null;
let currentRoomId = null;


/* =========================================================
   API
========================================================= */

async function api(url, options = {}) {

    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
    };

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
        ...options,
        headers
    });

    const data = await response.json()
        .catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            data.error || "请求失败"
        );
    }

    return data;
}


/* =========================================================
   登录
========================================================= */

async function login() {

    const username =
        document.getElementById("username").value.trim();

    const password =
        document.getElementById("password").value;

    try {

        const data = await api(
            "/api/login",
            {
                method: "POST",
                body: JSON.stringify({
                    username,
                    password
                })
            }
        );

        token = data.token;

        localStorage.setItem(
            "chat_token",
            token
        );

        await startApp();

    } catch (error) {

        document.getElementById(
            "authError"
        ).textContent = error.message;
    }
}


/* =========================================================
   注册
========================================================= */

async function register() {

    const username =
        document.getElementById("username").value.trim();

    const password =
        document.getElementById("password").value;

    try {

        const data = await api(
            "/api/register",
            {
                method: "POST",
                body: JSON.stringify({
                    username,
                    password
                })
            }
        );

        token = data.token;

        localStorage.setItem(
            "chat_token",
            token
        );

        await startApp();

    } catch (error) {

        document.getElementById(
            "authError"
        ).textContent = error.message;
    }
}


/* =========================================================
   启动
========================================================= */

async function startApp() {

    try {

        me = await api("/api/me");

        document
            .getElementById("authPage")
            .classList.add("hidden");

        document
            .getElementById("app")
            .classList.remove("hidden");

        document
            .getElementById("myUsername")
            .textContent = me.username;

        document
            .getElementById("myRole")
            .textContent =
            me.is_admin
                ? "管理员"
                : "普通用户";

        if (me.is_admin) {
            document
                .getElementById("adminButton")
                .classList.remove("hidden");
        }

        connectSocket();

        openPublic();

        loadFriendRequests();

    } catch {

        logout();
    }
}


/* =========================================================
   Socket
========================================================= */

function connectSocket() {

    socket = io();

    socket.on("connect", () => {

        socket.emit(
            "auth",
            token
        );
    });

    socket.on(
        "new_message",
        data => {

            if (
                data.type === "public" &&
                currentType === "public"
            ) {
                addMessage(
                    data.message
                );
            }

            if (
                data.type === "room" &&
                currentType === "room" &&
                currentRoomId === data.roomId
            ) {
                addMessage(
                    data.message
                );
            }

            if (
                data.type === "private_message" &&
                currentType === "private"
            ) {

                const message =
                    data.message;

                if (
                    message.user_id === me.id ||
                    message.user_id === currentUserId
                ) {
                    addMessage(message);
                }
            }
        }
    );

    socket.on(
        "notification",
        data => {

            if (
                data.type === "friend_request"
            ) {

                loadFriendRequests();

                alert(
                    "你收到了一条新的好友申请"
                );
            }

            if (
                data.type === "friend_accepted"
            ) {

                alert(
                    "对方已经同意你的好友申请"
                );
            }

            if (
                data.type === "account_status"
            ) {

                alert(data.message);

                me.is_muted = true;
            }

            if (
                data.type === "account_banned"
            ) {

                alert(
                    "你的账号已经被封禁"
                );

                logout();
            }
        }
    );

    socket.on(
        "error_message",
        data => {
            alert(data.error);
        }
    );
}


/* =========================================================
   公共频道
========================================================= */

async function openPublic() {

    currentType = "public";
    currentUserId = null;
    currentRoomId = null;

    document.getElementById(
        "chatTitle"
    ).textContent = "🌎 公共频道";

    document.getElementById(
        "chatStatus"
    ).textContent =
        "所有人都可以聊天";

    const messages =
        await api("/api/messages/public");

    renderMessages(messages);
}


/* =========================================================
   私聊
========================================================= */

async function openPrivate(user) {

    currentType = "private";

    currentUserId = user.id;
    currentRoomId = null;

    document.getElementById(
        "chatTitle"
    ).textContent =
        "💬 " + user.username;

    document.getElementById(
        "chatStatus"
    ).textContent =
        "私聊";

    const messages =
        await api(
            `/api/messages/private/${user.id}`
        );

    renderMessages(messages);
}


/* =========================================================
   群聊
========================================================= */

async function openRoom(room) {

    currentType = "room";

    currentRoomId = room.id;
    currentUserId = null;

    document.getElementById(
        "chatTitle"
    ).textContent =
        "💬 " + room.name;

    document.getElementById(
        "chatStatus"
    ).textContent =
        "群聊码：" + room.code;

    const messages =
        await api(
            `/api/messages/room/${room.id}`
        );

    renderMessages(messages);

    document.getElementById(
        "headerActions"
    ).innerHTML = `
        <button
            class="small-btn"
            onclick='showRoomCode(${JSON.stringify(room)})'
        >
            查看群聊码
        </button>
    `;
}


/* =========================================================
   渲染消息
========================================================= */

function renderMessages(messages) {

    const box =
        document.getElementById("messages");

    box.innerHTML = "";

    for (const message of messages) {
        addMessage(message);
    }

    box.scrollTop = box.scrollHeight;
}


function addMessage(message) {

    const box =
        document.getElementById("messages");

    const div =
        document.createElement("div");

    const mine =
        Number(message.user_id) === Number(me.id);

    div.className =
        "message" +
        (mine ? " me" : "");

    let content =
        escapeHtml(message.content);

    /*
     * @地铁跑酷
     */

    content = content.replace(
        /@地铁跑酷/g,
        `<a
            href="https://subwaysurfers3dbyzjp.netlify.app/"
            target="_blank"
            rel="noopener noreferrer"
            style="color:#4165e8;font-weight:bold"
        >@地铁跑酷</a>`
    );

    div.innerHTML = `
        <div class="message-info">
            ${escapeHtml(message.username)}
        </div>

        <div class="message-bubble">
            ${content}
        </div>
    `;

    box.appendChild(div);

    box.scrollTop =
        box.scrollHeight;
}


/* =========================================================
   发送消息
========================================================= */

function sendMessage() {

    const input =
        document.getElementById(
            "messageInput"
        );

    const content =
        input.value.trim();

    if (!content) return;

    if (!socket) return;

    socket.emit(
        "send_message",
        {
            content,

            roomId:
                currentType === "room"
                    ? currentRoomId
                    : null,

            receiverId:
                currentType === "private"
                    ? currentUserId
                    : null
        }
    );

    input.value = "";

    autoResize(input);
}


/* =========================================================
   输入框自动缩放
========================================================= */

const messageInput =
    document.getElementById(
        "messageInput"
    );

messageInput.addEventListener(
    "input",
    () => autoResize(messageInput)
);

messageInput.addEventListener(
    "keydown",
    event => {

        if (
            event.key === "Enter" &&
            !event.shiftKey
        ) {

            event.preventDefault();

            sendMessage();
        }
    }
);

function autoResize(element) {

    element.style.height = "40px";

    element.style.height =
        Math.min(
            element.scrollHeight,
            110
        ) + "px";
}


/* =========================================================
   好友
========================================================= */

async function showFriends() {

    const friends =
        await api("/api/friends");

    const panel =
        document.getElementById(
            "rightPanel"
        );

    panel.classList.remove("hidden");

    panel.innerHTML = `
        <div class="panel-title">
            👥 我的好友
        </div>

        <button
            class="small-btn"
            onclick="showAddFriend()"
        >
            + 添加好友
        </button>

        <div id="friendList"></div>
    `;

    const list =
        document.getElementById(
            "friendList"
        );

    for (const friend of friends) {

        const div =
            document.createElement("div");

        div.className =
            "list-item";

        div.innerHTML = `
            <span>
                👤 ${escapeHtml(friend.username)}
            </span>

            <button
                class="small-btn"
                onclick='openPrivate(${JSON.stringify(friend)})'
            >
                私聊
            </button>
        `;

        list.appendChild(div);
    }
}


/* =========================================================
   添加好友
========================================================= */

function showAddFriend() {

    showModal(`
        <h2>添加好友</h2>

        <input
            id="friendSearch"
            placeholder="输入用户名"
        >

        <button
            class="action"
            onclick="searchUsers()"
        >
            搜索
        </button>

        <div id="searchResults"></div>
    `);
}


async function searchUsers() {

    const q =
        document.getElementById(
            "friendSearch"
        ).value.trim();

    const users =
        await api(
            `/api/users/search?q=${encodeURIComponent(q)}`
        );

    const box =
        document.getElementById(
            "searchResults"
        );

    box.innerHTML = "";

    for (const user of users) {

        const div =
            document.createElement("div");

        div.className =
            "list-item";

        div.innerHTML = `
            <span>
                👤 ${escapeHtml(user.username)}
            </span>

            <button
                class="small-btn"
                onclick="sendFriendRequest(${user.id})"
            >
                添加
            </button>
        `;

        box.appendChild(div);
    }

    if (!users.length) {
        box.innerHTML =
            "<p>没有找到用户</p>";
    }
}


async function sendFriendRequest(userId) {

    try {

        const result =
            await api(
                "/api/friends/request",
                {
                    method: "POST",

                    body: JSON.stringify({
                        userId
                    })
                }
            );

        alert(result.message);

    } catch (error) {

        alert(error.message);
    }
}


/* =========================================================
   好友申请
========================================================= */

async function loadFriendRequests() {

    try {

        const requests =
            await api(
                "/api/friends/requests"
            );

        const badge =
            document.getElementById(
                "requestBadge"
            );

        badge.textContent =
            requests.length
                ? requests.length
                : "";

    } catch {}
}


async function showFriendRequests() {

    const requests =
        await api(
            "/api/friends/requests"
        );

    showModal(`
        <h2>好友申请</h2>

        <div id="requestList"></div>
    `);

    const list =
        document.getElementById(
            "requestList"
        );

    if (!requests.length) {

        list.innerHTML =
            "<p>暂时没有好友申请</p>";

        return;
    }

    for (const request of requests) {

        const div =
            document.createElement("div");

        div.className =
            "list-item";

        div.innerHTML = `
            <span>
                👤 ${escapeHtml(request.username)}
            </span>

            <div>
                <button
                    class="small-btn"
                    onclick="acceptFriend(${request.id})"
                >
                    同意
                </button>

                <button
                    class="small-btn"
                    onclick="rejectFriend(${request.id})"
                >
                    拒绝
                </button>
            </div>
        `;

        list.appendChild(div);
    }
}


async function acceptFriend(id) {

    await api(
        "/api/friends/accept",
        {
            method: "POST",

            body: JSON.stringify({
                id
            })
        }
    );

    closeModal();

    loadFriendRequests();

    alert("好友添加成功");
}


async function rejectFriend(id) {

    await api(
        "/api/friends/reject",
        {
            method: "POST",

            body: JSON.stringify({
                id
            })
        }
    );

    showFriendRequests();

    loadFriendRequests();
}


/* =========================================================
   群聊
========================================================= */

async function showRooms() {

    const rooms =
        await api("/api/rooms");

    const panel =
        document.getElementById(
            "rightPanel"
        );

    panel.classList.remove("hidden");

    panel.innerHTML = `
        <div class="panel-title">
            💬 我的群聊
        </div>

        <button
            class="small-btn"
            onclick="showCreateRoom()"
        >
            + 创建群聊
        </button>

        <button
            class="small-btn"
            onclick="showJoinRoom()"
        >
            加入群聊
        </button>

        <div id="roomList"></div>
    `;

    const list =
        document.getElementById(
            "roomList"
        );

    for (const room of rooms) {

        const div =
            document.createElement("div");

        div.className =
            "list-item";

        div.innerHTML = `
            <span>
                💬 ${escapeHtml(room.name)}
            </span>

            <button
                class="small-btn"
                onclick='openRoom(${JSON.stringify(room)})'
            >
                进入
            </button>
        `;

        list.appendChild(div);
    }
}


/* =========================================================
   创建群聊
========================================================= */

function showCreateRoom() {

    showModal(`
        <h2>创建群聊</h2>

        <input
            id="roomName"
            placeholder="群聊名称"
            maxlength="100"
        >

        <button
            class="action"
            onclick="createRoom()"
        >
            创建
        </button>
    `);
}


async function createRoom() {

    const name =
        document.getElementById(
            "roomName"
        ).value.trim();

    if (!name) {
        alert("请输入群聊名称");
        return;
    }

    try {

        const room =
            await api(
                "/api/rooms",
                {
                    method: "POST",

                    body: JSON.stringify({
                        name
                    })
                }
            );

        showRoomCode(room);

        showRooms();

    } catch (error) {

        alert(error.message);
    }
}


/* =========================================================
   查看群聊码
========================================================= */

function showRoomCode(room) {

    showModal(`
        <h2>
            ${escapeHtml(room.name)}
        </h2>

        <p>
            群聊码
        </p>

        <div class="room-code">
            ${escapeHtml(room.code)}
        </div>

        <button
            class="action"
            onclick="copyRoomCode('${room.code}')"
        >
            复制群聊码
        </button>
    `);
}


async function copyRoomCode(code) {

    await navigator.clipboard.writeText(code);

    alert("群聊码已复制");
}


/* =========================================================
   加入群聊
========================================================= */

function showJoinRoom() {

    showModal(`
        <h2>加入群聊</h2>

        <input
            id="joinCode"
            placeholder="输入群聊码"
        >

        <button
            class="action"
            onclick="joinRoom()"
        >
            加入
        </button>
    `);
}


async function joinRoom() {

    const code =
        document.getElementById(
            "joinCode"
        ).value.trim();

    try {

        const result =
            await api(
                "/api/rooms/join",
                {
                    method: "POST",

                    body: JSON.stringify({
                        code
                    })
                }
            );

        closeModal();

        showRooms();

        openRoom(result.room);

    } catch (error) {

        alert(error.message);
    }
}


/* =========================================================
   管理员
========================================================= */

async function showAdmin() {

    const users =
        await api("/api/admin/users");

    const panel =
        document.getElementById(
            "rightPanel"
        );

    panel.classList.remove("hidden");

    panel.innerHTML = `
        <div class="panel-title">
            🛡 管理员
        </div>

        <div id="adminUsers"></div>
    `;

    const list =
        document.getElementById(
            "adminUsers"
        );

    for (const user of users) {

        const div =
            document.createElement("div");

        div.className =
            "list-item";

        let actions = "";

        if (!user.is_admin) {

            actions += user.is_muted

                ? `
                <button
                    class="small-btn"
                    onclick="unmuteUser(${user.id})"
                >
                    解禁言
                </button>
                `

                : `
                <button
                    class="small-btn"
                    onclick="muteUser(${user.id})"
                >
                    禁言
                </button>
                `;

            actions += user.is_banned

                ? `
                <button
                    class="small-btn"
                    onclick="unbanUser(${user.id})"
                >
                    解封
                </button>
                `

                : `
                <button
                    class="small-btn"
                    onclick="banUser(${user.id})"
                >
                    封禁
                </button>
                `;
        }

        div.innerHTML = `
            <div>
                👤 ${escapeHtml(user.username)}

                ${
                    user.is_admin
                        ? "<small>管理员</small>"
                        : ""
                }

                ${
                    user.is_muted
                        ? "<small> 已禁言</small>"
                        : ""
                }

                ${
                    user.is_banned
                        ? "<small> 已封禁</small>"
                        : ""
                }
            </div>

            <div>
                ${actions}
            </div>
        `;

        list.appendChild(div);
    }
}


async function muteUser(id) {

    await api(
        `/api/admin/users/${id}/mute`,
        {
            method: "POST"
        }
    );

    showAdmin();
}


async function unmuteUser(id) {

    await api(
        `/api/admin/users/${id}/unmute`,
        {
            method: "POST"
        }
    );

    showAdmin();
}


async function banUser(id) {

    if (!confirm("确定封禁这个用户？")) {
        return;
    }

    await api(
        `/api/admin/users/${id}/ban`,
        {
            method: "POST"
        }
    );

    showAdmin();
}


async function unbanUser(id) {

    await api(
        `/api/admin/users/${id}/unban`,
        {
            method: "POST"
        }
    );

    showAdmin();
}


/* =========================================================
   Modal
========================================================= */

function showModal(html) {

    document
        .getElementById("modalContent")
        .innerHTML = html;

    document
        .getElementById("modal")
        .classList.remove("hidden");
}


function closeModal() {

    document
        .getElementById("modal")
        .classList.add("hidden");
}


/* =========================================================
   退出
========================================================= */

function logout() {

    localStorage.removeItem(
        "chat_token"
    );

    token = null;

    if (socket) {
        socket.disconnect();
    }

    location.reload();
}


/* =========================================================
   HTML 安全
========================================================= */

function escapeHtml(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


/* =========================================================
   自动登录
========================================================= */

if (token) {
    startApp();
}
