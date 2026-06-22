// Claude AI 助手 — 微信版 (记忆 + 搜索 + 图片 + 行程提醒)
import Anthropic from "@anthropic-ai/sdk";
import { WechatBot } from "wx-clawbot";
import qr from "qrcode-terminal";
import fs from "fs";
import path from "path";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("请设置 ANTHROPIC_API_KEY"); process.exit(1); }

// ─── 记忆/提醒存储 ───
const MEMORY_DIR = process.env.MEMORY_DIR || "/data/memories";
const SCHEDULE_DIR = path.join(MEMORY_DIR, "schedule");
fs.mkdirSync(SCHEDULE_DIR, { recursive: true });

function handleMemoryTool(input) {
  const { command, path: memPath, file_text, old_str, new_str, insert_line, insert_text } = input;
  const fullPath = path.resolve(MEMORY_DIR, (memPath || "").replace(/^\/+/, ""));
  if (!fullPath.startsWith(path.resolve(MEMORY_DIR))) return "Error: access denied";
  switch (command) {
    case "view": {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          return fs.readdirSync(fullPath).map(f => {
            const s = fs.statSync(path.join(fullPath, f));
            return `${s.isDirectory()?"/":""}${f} (${s.size}b)`;
          }).join("\n") || "(empty)";
        }
        return fs.readFileSync(fullPath, "utf-8");
      } catch { return "(empty)"; }
    }
    case "create": fs.mkdirSync(path.dirname(fullPath),{recursive:true}); fs.writeFileSync(fullPath,file_text||"","utf-8"); return "created";
    case "str_replace": {
      const c = fs.readFileSync(fullPath,"utf-8");
      const n = c.split(old_str).length-1;
      if (n===0) return "Error: text not found";
      if (n>1) return "Error: matches multiple times";
      fs.writeFileSync(fullPath,c.replace(old_str,new_str),"utf-8"); return "replaced";
    }
    case "insert": {
      const lines=fs.readFileSync(fullPath,"utf-8").split("\n");
      lines.splice(insert_line,0,insert_text);
      fs.writeFileSync(fullPath,lines.join("\n"),"utf-8"); return "inserted";
    }
    case "delete": fs.unlinkSync(fullPath); return "deleted";
    case "rename": {
      const np = path.resolve(MEMORY_DIR,(input.new_path||"").replace(/^\/+/,""));
      if (!np.startsWith(path.resolve(MEMORY_DIR))) return "Error: access denied";
      fs.mkdirSync(path.dirname(np),{recursive:true}); fs.renameSync(fullPath,np); return "renamed";
    }
    default: return `Unknown: ${command}`;
  }
}

// ─── 行程提醒引擎 ───
function loadReminders(userId) {
  const f = path.join(SCHEDULE_DIR, `${userId}.json`);
  try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch { return []; }
}
function saveReminders(userId, reminders) {
  fs.writeFileSync(path.join(SCHEDULE_DIR, `${userId}.json`), JSON.stringify(reminders, null, 2), "utf-8");
}

// Claude 存储提醒的格式指导
const REMINDER_GUIDE = [
  "## 行程提醒（重要！）",
  "当用户提到任何有时间的事情（会议、约会、截止日期、需要做的事），你必须：",
  "1. 先回复确认你记下了",
  "2. 然后用 memory 工具把提醒存入 /schedule/{userId}.json",
  "3. 文件格式是一个 JSON 数组：",
  '[{"time":"2026-06-23T14:00:00+10:00","text":"会议","remindBefore":15,"sent":false}]',
  "- time: ISO8601 格式，带时区（澳洲用 +10:00 或 +11:00 夏令时）",
  "- remindBefore: 提前多少分钟提醒（默认15）",
  "- sent: 必须设为 false",
  "- 多个提醒用数组，记得保留已有的提醒，追加新的",
  "",
  "例如用户说「明天下午3点开会」，你就存成 /schedule/{userId}.json。",
  "如果用户说「取消明天的会议」，你就更新 /schedule/{userId}.json 删除那条。",
].join("\n");

// ─── Claude 调用 ───
const claude = new Anthropic({ apiKey });
const conversations = new Map();

const SYSTEM_PROMPT = [
  "你是一个专业的 AI 助手，通过微信为用户服务。",
  "",
  "## 视觉能力",
  "- 用户可以发照片/截图，你能识别图中文字、物体、场景",
  "- 可以提取图片中的信息帮用户整理分析",
  "",
  "## 搜索能力",
  "- 需要实时信息时用 web_search 搜索，搜到链接用 web_fetch 获取完整内容",
  "- 房产、政策、价格、商家信息等都必须搜索后回答",
  "",
  "## 记忆能力",
  "- 用 memory 工具记住用户的重要信息：名字、偏好、在做的事、关键决策",
  "",
  REMINDER_GUIDE,
  "",
  "## 回复要求",
  "- 中文回复，有深度有实质",
  "- 信息不足时主动提问",
].join("\n");

async function askClaude(userId, text, images=[]) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const messages = conversations.get(userId);

  const content = [];
  for (const img of images) {
    content.push({type:"image",source:{type:"base64",media_type:img.type||"image/jpeg",data:img.data}});
  }
  if (text) content.push({type:"text",text});
  messages.push({role:"user",content:content.length===1&&content[0].type==="text"?text:content});

  // 工具循环
  let resp;
  while (true) {
    resp = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 4096,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 5 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
        { type: "memory_20250818", name: "memory" },
      ],
      messages,
    });
    const toolBlocks = resp.content.filter(b => b.type === "tool_use");
    if (toolBlocks.length === 0) break;
    messages.push({ role: "assistant", content: resp.content });
    const results = [];
    for (const tb of toolBlocks) {
      if (tb.name === "memory") {
        const r = handleMemoryTool(tb.input);
        console.log(`🧠 memory:${tb.input.command} ${tb.input.path} → ${r.slice(0,50)}`);
        results.push({type:"tool_result",tool_use_id:tb.id,content:r});
      }
    }
    if (results.length > 0) { messages.push({role:"user",content:results}); }
    else break;
  }
  const reply = resp.content.find(b => b.type === "text")?.text ?? "(无法回复)";
  messages.push({role:"assistant",content:reply});
  if (messages.length > 60) messages.splice(0, messages.length - 60);
  return reply;
}

// ─── 后台提醒检查 ───
let botInstance = null;

async function checkReminders() {
  if (!botInstance) return;
  const now = new Date();
  try {
    const files = fs.readdirSync(SCHEDULE_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const userId = f.replace(".json","");
      const reminders = loadReminders(userId);
      let changed = false;
      for (const rem of reminders) {
        if (rem.sent) continue;
        const triggerTime = new Date(new Date(rem.time).getTime() - (rem.remindBefore||15)*60000);
        if (now >= triggerTime) {
          console.log(`⏰ 发送提醒: ${rem.text} → ${userId}`);
          try {
            const resp = await claude.messages.create({
              model: "claude-haiku-4-5", max_tokens: 200,
              thinking: { type: "disabled" },
              system: "你是行程提醒助手。用友好、简洁的中文提醒用户。",
              messages: [{role:"user",content:`请用一句话提醒用户：${rem.text}（时间：${rem.time}）`}],
            });
            const msg = resp.content.find(b=>b.type==="text")?.text || `⏰ 提醒：${rem.text}`;
            // 通过 bot 内部 client 发送
            const client = botInstance.client;
            await client.sendMessage({
              msg: {
                to_user_id: userId,
                message_type: 2,   // BOT
                message_state: 2,  // FINISH
                item_list: [{ type: 1, text_item: { text: msg } }],
              },
            });
            console.log(`✅ 提醒已发送: ${msg.slice(0,60)}`);
          } catch (e) {
            console.error(`❌ 发送提醒失败: ${e.message}`);
          }
          rem.sent = true;
          changed = true;
        }
      }
      if (changed) saveReminders(userId, reminders);
    }
  } catch (e) { console.error("checkReminders error:", e.message); }
}

// ─── 微信 Bot ───
const bot = new WechatBot();
bot.ensureLogin();

bot.on("scan", ({ url }) => {
  console.log(`\n📱 扫码: ${url}\n`);
  try { qr.generate(url, { small: true }, q => console.log(q)); } catch {}
});

bot.on("message", async (msg) => {
  const types = msg.item?.item_list?.map(i=>i.type) || [];
  console.log(`📨 type:${JSON.stringify(types)} text:"${(msg.text||"").slice(0,40)}"`);

  const text = msg.text || "";
  let images = [];
  try {
    const buf = await msg.downloadMedia();
    if (buf && buf.length > 0) {
      images.push({data:buf.toString("base64"),type:"image/jpeg"});
      console.log(`📷 下载成功 (${(buf.length/1024).toFixed(0)}KB)`);
    }
  } catch (e) { console.log(`📷 下载失败: ${e.message}`); }

  if (!text && images.length === 0) return;
  console.log(`📩 ${(text||"[图片]").slice(0,100)}`);
  try {
    const reply = await askClaude(msg.from, text, images);
    await msg.sendText(reply);
    console.log(`✅ ${reply.slice(0,80)}...`);
  } catch (e) {
    console.error("❌", e.message);
    try { await msg.sendText("抱歉，处理请求时出错了。"); } catch {}
  }
});

bot.on("login", ({ status }) => {
  if (status === "success") {
    console.log("✅ AI 助手已上线 (记忆+搜索+图片+提醒)");
    // 保存 bot 实例用于后台发送提醒
    botInstance = bot;
  }
});
bot.on("logout", () => console.log("⚠️ 会话过期"));
bot.on("error", (e) => console.error("出错:", e.message));

// 启动提醒检查（每60秒）
setInterval(checkReminders, 60000);

console.log("🤖 Claude AI 助手启动中...");
