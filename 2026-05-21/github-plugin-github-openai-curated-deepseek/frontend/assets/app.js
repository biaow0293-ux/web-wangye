const $ = (id) => document.getElementById(id);

const state = {
  models: {},
  activeStep: 1,
  lastChanged: "等待输入",
  history: JSON.parse(localStorage.getItem("ds_history") || "[]"),
  usage: JSON.parse(localStorage.getItem("ds_usage") || '{"tokens":0,"cost":0}'),
  lessons: [
    "你刚才用的是对话模型，它擅长聊天、写作和总结，但不能直接识别图片。",
    "temperature 控制随机性。事实问答适合低一点，创意写作可以高一点。",
    "max_tokens 是输出上限，不是实际一定会花掉的 tokens。",
    "流式输出的价值是降低等待焦虑，用户能更快看到模型开始工作。",
    "后端代理能避免把平台级 API Key 暴露在浏览器代码里。"
  ]
};

const fields = [
  "apiKey", "modelSelect", "systemPrompt", "userPrompt",
  "temperature", "maxTokens", "budgetLimit"
];

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3600);
}

function payload() {
  return {
    api_key: $("apiKey").value.trim() || null,
    model: $("modelSelect").value || "deepseek-chat",
    system_prompt: $("systemPrompt").value.trim(),
    user_prompt: $("userPrompt").value.trim(),
    temperature: Number($("temperature").value),
    max_tokens: Number($("maxTokens").value),
    stream: true
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function updatePreview(changed = state.lastChanged) {
  state.lastChanged = changed;
  $("tempValue").textContent = $("temperature").value;
  $("maxTokensValue").textContent = $("maxTokens").value;
  $("changedField").textContent = changed;
  const json = JSON.stringify({
    model: $("modelSelect").value || "deepseek-chat",
    messages: [
      { role: "system", content: $("systemPrompt").value },
      { role: "user", content: $("userPrompt").value || "你的问题会出现在这里" }
    ],
    temperature: Number($("temperature").value),
    max_tokens: Number($("maxTokens").value),
    stream: true
  }, null, 2);
  const highlighted = escapeHtml(json).replace(
    new RegExp(`(&quot;${changed}&quot;:|${escapeRegExp(changed)})`, "g"),
    '<span class="json-change">$1</span>'
  );
  $("jsonPreview").innerHTML = `<code>${highlighted}</code>`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function deriveKey() {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${location.origin}|${navigator.userAgent}`),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("deepseek-workbench"), iterations: 100000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function saveKeyLocal(value) {
  if (!value || !crypto.subtle) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey();
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  localStorage.setItem("ds_key", JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(cipher)),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  }));
}

async function loadKeyLocal() {
  const saved = localStorage.getItem("ds_key");
  if (!saved || !crypto.subtle) return;
  try {
    const item = JSON.parse(saved);
    if (Date.now() > item.expiresAt) {
      $("keyStatus").className = "status warn";
      $("keyStatus").textContent = "本地保存的密钥已超过 7 天，建议重新粘贴确认。";
      return;
    }
    const key = await deriveKey();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(item.iv) },
      key,
      new Uint8Array(item.data)
    );
    $("apiKey").value = new TextDecoder().decode(plain);
  } catch {
    localStorage.removeItem("ds_key");
  }
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: { message: "请求失败" } }));
    throw new Error(error.detail?.message || error.detail || "请求失败");
  }
  return response.json();
}

async function loadModels() {
  const res = await fetch("/api/models");
  const data = await res.json();
  state.models = data.models;
  $("modelSelect").innerHTML = Object.entries(state.models).map(([id, model]) =>
    `<option value="${id}" title="${model.description} ${model.price}">${id}</option>`
  ).join("");
  updateModelInfo();
}

function updateModelInfo() {
  const model = state.models[$("modelSelect").value];
  if (!model) return;
  $("modelInfo").innerHTML = `<strong>${model.name}</strong><br>${model.description}<br>${model.price}`;
}

function setStep(step) {
  state.activeStep = step;
  document.querySelectorAll(".step-card").forEach((card) => {
    card.classList.toggle("active", Number(card.dataset.step) === step);
  });
}

async function testKey() {
  $("keyStatus").className = "status muted";
  $("keyStatus").textContent = "正在测试连接...";
  try {
    const data = await api("/api/test", { api_key: $("apiKey").value.trim() || null, model: $("modelSelect").value });
    $("keyStatus").className = "status ok";
    $("keyStatus").textContent = `✓ ${data.message}，耗时 ${data.latency_ms}ms`;
    await saveKeyLocal($("apiKey").value.trim());
    setStep(3);
  } catch (error) {
    $("keyStatus").className = "status bad";
    $("keyStatus").textContent = `✕ ${error.message}`;
  }
}

async function helpPrompt() {
  const idea = $("roughIdea").value.trim();
  if (!idea) return toast("先写一句模糊想法，我再帮你改成提示词。");
  $("helpPrompt").disabled = true;
  $("helpPrompt").textContent = "生成中...";
  try {
    const data = await api("/api/prompt-helper", {
      api_key: $("apiKey").value.trim() || null,
      model: $("modelSelect").value,
      idea
    });
    $("userPrompt").value = data.prompt;
    updatePreview("user_prompt");
    toast("已把模糊想法改写成可执行提示词。");
  } catch (error) {
    toast(error.message);
  } finally {
    $("helpPrompt").disabled = false;
    $("helpPrompt").textContent = "AI 帮我写提示词";
  }
}

async function sendRequest() {
  if (!$("userPrompt").value.trim()) return toast("先输入你的问题。");
  $("sendRequest").disabled = true;
  $("resultBox").textContent = "";
  $("firstToken").textContent = "--";
  $("totalTime").textContent = "--";
  $("tokenCost").textContent = "--";

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload())
  });

  if (!response.ok || !response.body) {
    $("sendRequest").disabled = false;
    return toast("请求没有成功发出，请检查后端服务。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) handleSseFrame(frame, (text) => {
        answer += text;
        $("resultBox").textContent += text;
        $("resultBox").scrollTop = $("resultBox").scrollHeight;
      });
    }
    if (answer) addHistory(payload().user_prompt, answer);
  } finally {
    $("sendRequest").disabled = false;
  }
}

function handleSseFrame(frame, onToken) {
  const event = frame.match(/^event: (.+)$/m)?.[1];
  const dataLine = frame.match(/^data: (.+)$/m)?.[1];
  if (!event || !dataLine) return;
  const data = JSON.parse(dataLine);
  if (event === "token") onToken(data.text);
  if (event === "timing") $("firstToken").textContent = `${data.first_token_ms}ms`;
  if (event === "done") {
    $("totalTime").textContent = `${data.total_ms}ms`;
    $("tokenCost").textContent = `¥${Number(data.estimated_cost_cny).toFixed(6)}`;
    state.usage.tokens += data.input_tokens + data.output_tokens;
    state.usage.cost += data.estimated_cost_cny;
    localStorage.setItem("ds_usage", JSON.stringify(state.usage));
    $("lessonText").textContent = state.lessons[Math.floor(Math.random() * state.lessons.length)];
    renderUsage();
  }
  if (event === "error") {
    $("resultBox").textContent += `\n\n调用失败：${data.message}`;
    toast(data.message);
  }
}

function renderUsage() {
  $("totalTokens").textContent = state.usage.tokens.toLocaleString("zh-CN");
  $("totalCost").textContent = `¥${state.usage.cost.toFixed(6)}`;
  const budget = Math.max(0.01, Number($("budgetLimit").value || 5));
  const percent = Math.min(100, (state.usage.cost / budget) * 100);
  $("budgetFill").style.width = `${percent}%`;
  if (percent >= 90) {
    $("budgetHint").className = "status bad";
    $("budgetHint").textContent = "预算快用完了，建议降低回复长度或暂停调用。";
  } else if (percent >= 70) {
    $("budgetHint").className = "status warn";
    $("budgetHint").textContent = "已经接近预算上限，注意控制调用次数。";
  } else {
    $("budgetHint").className = "status muted";
    $("budgetHint").textContent = "预算健康。";
  }
}

function addHistory(question, answer) {
  state.history.unshift({ question, answer, at: new Date().toLocaleString("zh-CN") });
  state.history = state.history.slice(0, 12);
  localStorage.setItem("ds_history", JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  $("historyList").innerHTML = state.history.length ? state.history.map((item) => `
    <button class="history-item" type="button" data-question="${escapeHtml(item.question)}">
      <strong>${escapeHtml(item.at)}</strong>
      <span>${escapeHtml(item.question.slice(0, 80))}</span>
    </button>
  `).join("") : `<div class="muted">还没有历史记录。</div>`;
}

function resetDemo() {
  localStorage.removeItem("ds_history");
  localStorage.removeItem("ds_usage");
  state.history = [];
  state.usage = { tokens: 0, cost: 0 };
  $("resultBox").textContent = "输出会像打字机一样出现在这里。";
  renderHistory();
  renderUsage();
  toast("演示数据已重置。");
}

function wireEvents() {
  fields.forEach((id) => $(id)?.addEventListener("input", () => updatePreview(id)));
  $("modelSelect").addEventListener("change", () => { updateModelInfo(); updatePreview("model"); });
  $("testKey").addEventListener("click", testKey);
  $("helpPrompt").addEventListener("click", helpPrompt);
  $("sendRequest").addEventListener("click", sendRequest);
  $("clearResult").addEventListener("click", () => $("resultBox").textContent = "");
  $("clearHistory").addEventListener("click", () => { state.history = []; localStorage.removeItem("ds_history"); renderHistory(); });
  $("resetDemo").addEventListener("click", resetDemo);
  $("budgetLimit").addEventListener("input", renderUsage);
  $("expertMode").addEventListener("change", (event) => $("expertFields").classList.toggle("hidden", !event.target.checked));
  $("toggleKey").addEventListener("click", () => {
    $("apiKey").type = $("apiKey").type === "password" ? "text" : "password";
  });
  $("replayTutorial").addEventListener("click", () => {
    setStep(1);
    toast("教程已回到第一步：先创建或复制 API Key。");
  });
  document.addEventListener("click", (event) => {
    const item = event.target.closest(".history-item");
    if (item) {
      $("userPrompt").value = item.dataset.question;
      updatePreview("user_prompt");
      window.scrollTo({ top: document.querySelector(".builder").offsetTop - 12, behavior: "smooth" });
    }
  });
}

function stuckDetector() {
  setInterval(() => {
    const hint = $("stuckHint");
    if (state.activeStep === 1) hint.textContent = "卡住了吗？点击第一步里的链接，创建 Key 后回到这里粘贴。";
    if (state.activeStep === 2) hint.textContent = "如果测试失败，优先检查 Key 是否复制完整、账户余额是否充足、网络是否可访问 DeepSeek。";
    if (state.activeStep === 3) hint.textContent = "模型已选好后，可以在下方输入问题并发送。建议先用 deepseek-chat。";
  }, 20000);
}

async function init() {
  await loadModels();
  await loadKeyLocal();
  wireEvents();
  updatePreview();
  renderHistory();
  renderUsage();
  stuckDetector();
}

init();
