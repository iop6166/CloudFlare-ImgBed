// CloudFlare-ImgBed 入站 Telegram 转发（Pages Functions 版）
// 直接放进现有 ImgBed 仓库的 functions/telegram/index.js，随原项目一起部署即可。
// 作用：接收发给 Bot 的文件 → 调用本站点 /upload 写库 → 网页图库可见。
//
// 复用项目已有环境变量（无需新增）：
//   TG_BOT_TOKEN  机器人 Token（ImgBed 原就用来发文件到频道，这里接收入站消息）
//   AUTH_CODE     上传认证码（调用 /upload 写库用）
//   TG_CHAT_ID    可选，仅处理该 chat（如 -1004469584288）；留空=所有人可用
//
// 设 webhook（把域名换成你的）：
//   https://cl.616691887.xyz/telegram/setup   （浏览器访问即注册）
// 之后给机器人发文件即可，会收到“✅ 已入库 + 链接”回执。
//
// 注意：Telegram Bot API 单文件上限 20MB。

export async function onRequestGet({ request, env }) {
  // 一键注册 webhook
  const url = new URL(request.url);
  const webhook = `${url.origin}/telegram`;
  const r = await fetch(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhook)}`
  );
  return new Response(JSON.stringify(await r.json()), {
    headers: { "content-type": "application/json" },
  });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const origin = new URL(request.url).origin; // 站点自身域名，用于回调用 /upload
  const update = await request.json().catch(() => null);
  const msg = update?.message || update?.channel_post;
  if (msg) {
    const wl = env.TG_CHAT_ID?.replace(/[^0-9-]/g, ""); // 容忍格式
    if (!wl || String(msg.chat?.id) === wl) {
      const picked = pick(msg);
      if (picked) waitUntil(relay(picked, env, msg.chat.id, origin));
    }
  }
  return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
}

function pick(message) {
  for (const key of ["document", "video", "audio", "voice", "animation"]) {
    if (message[key]) {
      const f = message[key];
      return { file_id: f.file_id, name: f.file_name || key, ctype: f.mime_type || "application/octet-stream" };
    }
  }
  if (message.photo) {
    const p = message.photo[message.photo.length - 1];
    return { file_id: p.file_id, name: "photo.jpg", ctype: "image/jpeg" };
  }
  return null;
}

async function tg(api, token, body) {
  return fetch(`https://api.telegram.org/bot${token}/${api}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function relay({ file_id, name, ctype }, env, chatId, origin) {
  const token = env.TG_BOT_TOKEN;
  const base = origin.replace(/\/+$/, "");
  try {
    // 1) 取真实下载路径（Bot API 限制：单文件 20MB）
    const info = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(file_id)}`)).json();
    if (!info.ok) throw new Error(`getFile 失败：${info.description || "未知"}`);

    // 2) 下载文件
    const dl = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
    const buf = await dl.arrayBuffer();
    if (buf.byteLength === 0) throw new Error("下载为空");
    if (buf.byteLength >= 20 * 1024 * 1024) throw new Error("超过 20MB（TG Bot API 上限）");

    // 3) 转发到本站 /upload 写库
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: ctype }), name);
    const headers = { "authCode": env.AUTH_CODE || "" };
    const r = await fetch(base + "/upload", { method: "POST", headers, body: fd });
    const text = await r.text();
    if (!r.ok) throw new Error(`上传失败 HTTP ${r.status} ${text.slice(0, 200)}`);

    // 4) 解析返回链接并回复
    let link = "";
    try {
      const j = JSON.parse(text);
      const src = Array.isArray(j) ? j[0]?.src : (j.src || (j.data && j.data[0]?.src));
      if (typeof src === "string") link = src.startsWith("http") ? src : (base + (src.startsWith("/") ? src : "/" + src));
    } catch (_) {}

    await tg("sendMessage", token, {
      chat_id: chatId,
      text: `✅ 已入库（${(buf.byteLength / 1024).toFixed(1)} KB）\n${link || text.slice(0, 300)}`,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error("relay error:", e.message);
    await tg("sendMessage", token, { chat_id: chatId, text: `❌ ${e.message}` });
  }
}
