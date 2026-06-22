// Claude 微信机器人 — 最简实现
// 使用方法: node bot.mjs
// 首次运行扫码登录，之后自动记住登录状态

import Anthropic from "@anthropic-ai/sdk";
import { WechatBot } from "wx-clawbot";
import qr from "qrcode-terminal";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("请设置 ANTHROPIC_API_KEY: set ANTHROPIC_API_KEY=sk-ant-api03-...");
  process.exit(1);
}

const claude = new Anthropic({ apiKey });
const conversations = new Map(); // userId -> messages[]

async function askClaude(userId, text) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: "user", content: text });
  if (history.length > 40) history.splice(0, history.length - 40);

  const resp = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    thinking: { type: "disabled" },
    system: [
      "你是一个专业的 AI 助手，通过微信为用户提供高质量的服务。",
      "",
      "核心原则：",
      "- 认真理解用户的需求，给出有深度、有实质内容的回答",
      "- 需要实时信息时，主动使用 web_search 搜索后回答",
      "- 用中文回复，简洁但有料，不废话也不敷衍",
      "- 如果信息不足，主动提问澄清，而不是随便猜测",
      "- 可以做分析、计算、翻译、总结等各种任务",
      "",
      "格式注意：微信不支持 Markdown，用纯文本表达。",
    ].join("\n"),
    tools: [{ type: "web_search_20260209", name: "web_search" }],
    messages: history,
  });
  // 安全获取文本：跳过 thinking block，找第一个 text block
  const reply = resp.content.find(b => b.type === "text")?.text ?? "(无法回复)";
  history.push({ role: "assistant", content: reply });
  return reply;
}

const bot = new WechatBot();
bot.ensureLogin();

bot.on("scan", ({ url }) => {
  console.log("\n📱 请用微信扫描以下二维码：\n");
  qr.generate(url, { small: true }, (qrcode) => console.log(qrcode));
  console.log(`\n或打开链接: ${url}\n`);
});

bot.on("message", async (msg) => {
  if (!msg.text) return;
  console.log(`📩 ${msg.text.slice(0, 80)}`);
  try {
    const reply = await askClaude(msg.from, msg.text);
    await msg.sendText(reply);
    console.log(`✅ ${reply.slice(0, 60)}...`);
  } catch (e) {
    console.error("❌", e.message);
  }
});

bot.on("login", ({ status }) => console.log(status === "success" ? "✅ 登录成功!" : "❌ 登录失败"));
bot.on("logout", () => console.log("⚠️ 会话过期，需要重新扫码"));
bot.on("error", (e) => console.error("出错:", e.message));

console.log("🤖 Claude 微信机器人启动中...");
