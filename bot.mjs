// Claude AI 助手 — 微信版 (长期记忆 + 搜索 + 分析)
import Anthropic from "@anthropic-ai/sdk";
import { WechatBot } from "wx-clawbot";
import qr from "qrcode-terminal";
import fs from "fs";
import path from "path";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("请设置 ANTHROPIC_API_KEY");
  process.exit(1);
}

// ─── 记忆存储 (持久化到磁盘) ───
const MEMORY_DIR = process.env.MEMORY_DIR || "/data/memories";
fs.mkdirSync(MEMORY_DIR, { recursive: true });

function handleMemoryTool(input) {
  const { command, path: memPath, file_text, old_str, new_str, insert_line, insert_text } = input;
  const fullPath = path.resolve(MEMORY_DIR, (memPath || "").replace(/^\/+/, ""));
  // 安全检查：禁止越界
  if (!fullPath.startsWith(path.resolve(MEMORY_DIR))) return "Error: access denied";

  switch (command) {
    case "view": {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          return fs.readdirSync(fullPath).map(f => {
            const s = fs.statSync(path.join(fullPath, f));
            return `${s.isDirectory() ? "/" : ""}${f} (${s.size}b)`;
          }).join("\n") || "(empty)";
        }
        return fs.readFileSync(fullPath, "utf-8");
      } catch { return "(not found)"; }
    }
    case "create": {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file_text || "", "utf-8");
      return "created";
    }
    case "str_replace": {
      const content = fs.readFileSync(fullPath, "utf-8");
      const count = content.split(old_str).length - 1;
      if (count === 0) return "Error: old_str not found";
      if (count > 1) return "Error: old_str appears multiple times";
      fs.writeFileSync(fullPath, content.replace(old_str, new_str), "utf-8");
      return "replaced";
    }
    case "insert": {
      const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
      lines.splice(insert_line, 0, insert_text);
      fs.writeFileSync(fullPath, lines.join("\n"), "utf-8");
      return "inserted";
    }
    case "delete": {
      fs.unlinkSync(fullPath);
      return "deleted";
    }
    case "rename": {
      const newPath = path.resolve(MEMORY_DIR, (input.new_path || "").replace(/^\/+/, ""));
      if (!newPath.startsWith(path.resolve(MEMORY_DIR))) return "Error: access denied";
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(fullPath, newPath);
      return "renamed";
    }
    default: return `Unknown command: ${command}`;
  }
}

// ─── Claude 调用 (支持工具循环) ───
const claude = new Anthropic({ apiKey });
const conversations = new Map();

const SYSTEM_PROMPT = [
  "你是一个专业的 AI 助手，通过微信为用户服务。",
  "",
  "## 视觉能力",
  "- 用户可以给你发照片/截图，你能识别图中的文字、物体、场景",
  "- 可以提取图片中的信息（账单、合同、表格等）并帮用户整理分析",
  "- 收到图片时主动说明你看到了什么",
  "",
  "## 搜索能力",
  "- 需要实时信息时用 web_search 搜索，搜到链接用 web_fetch 获取完整内容",
  "- 房产、政策、价格、商家信息、新闻等都必须搜索后再回答",
  "",
  "## 记忆能力",
  "- 用 memory 记住用户的重要信息：名字、偏好、在做的事、关键决策",
  "- 每次对话前后检查记忆，新对话开始时先查看历史记忆",
  "",
  "## 回复要求",
  "- 中文回复，有深度有实质",
  "- 可以用纯文本列出要点的帮助用户整理信息",
  "- 信息不足时主动提问",
].join("\n");

async function askClaude(userId, text, images = []) {
  // 加载历史
  if (!conversations.has(userId)) conversations.set(userId, []);
  const messages = conversations.get(userId);

  // 构建用户消息（文本 + 图片）
  const content = [];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.type || "image/jpeg", data: img.data },
    });
  }
  if (text) content.push({ type: "text", text });
  messages.push({ role: "user", content: content.length === 1 && content[0].type === "text" ? text : content });

  // 工具循环
  let resp;
  while (true) {
    resp = await claude.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 5 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
        { type: "memory_20250818", name: "memory" },
      ],
      messages,
    });

    // 检查是否需要调用工具
    const toolBlocks = resp.content.filter(b => b.type === "tool_use");
    if (toolBlocks.length === 0) break;

    // 执行工具
    messages.push({ role: "assistant", content: resp.content });
    const toolResults = [];
    for (const tb of toolBlocks) {
      if (tb.name === "memory") {
        const result = handleMemoryTool(tb.input);
        console.log(`🧠 memory:${tb.input.command} ${tb.input.path} → ${result.slice(0, 50)}`);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }
      // web_search 是服务端工具，不需要 client 处理，但需要保留 tool_use block
    }
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    } else {
      break; // 只有服务端工具，等待下一轮
    }
  }

  const reply = resp.content.find(b => b.type === "text")?.text ?? "(无法回复)";
  messages.push({ role: "assistant", content: reply });

  // 控制历史长度
  if (messages.length > 60) messages.splice(0, messages.length - 60);
  return reply;
}

// ─── 微信 Bot ───
const bot = new WechatBot();
bot.ensureLogin();

bot.on("scan", ({ url }) => {
  console.log(`\n📱 扫码链接: ${url}\n`);
  try { qr.generate(url, { small: true }, q => console.log(q)); } catch {}
});

bot.on("message", async (msg) => {
  const text = msg.text || "";
  let images = [];

  // 检测并下载图片
  try {
    const buf = await msg.downloadMedia();
    if (buf && buf.length > 0) {
      images.push({ data: buf.toString("base64"), type: "image/jpeg" });
      console.log(`📷 收到图片 (${(buf.length / 1024).toFixed(0)}KB)`);
    }
  } catch {} // 无图片或下载失败

  if (!text && images.length === 0) return;
  console.log(`📩 ${(text || "[图片]").slice(0, 100)}`);
  try {
    const reply = await askClaude(msg.from, text, images);
    await msg.sendText(reply);
    console.log(`✅ ${reply.slice(0, 80)}...`);
  } catch (e) {
    console.error("❌", e.message);
    try { await msg.sendText("抱歉，处理你的请求时出错了，请稍后再试。"); } catch {}
  }
});

bot.on("login", ({ status }) => console.log(status === "success" ? "✅ AI 助手已上线" : "❌ 登录失败"));
bot.on("logout", () => console.log("⚠️ 会话过期"));
bot.on("error", (e) => console.error("出错:", e.message));

console.log("🤖 Claude AI 助手启动中 (长期记忆 + 搜索)...");
