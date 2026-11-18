import { marked } from "marked";
import DOMPurify from "dompurify";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const endpoint = "https://token-link.shop/cage-support/ask";
const form = $<HTMLFormElement>("ask"),
  input = $<HTMLTextAreaElement>("question"),
  file = $<HTMLInputElement>("file");
const thread = $("thread"),
  dialog = $<HTMLDialogElement>("document");
const guides: { path: string; title: string; sections: [string, string][] }[] =
  JSON.parse($("doc-map").textContent!);
type Photo = { name: string; url: string };
type Source = { title: string; url: string };
type Draft = { title: string; body: string; ticket: string };
type Turn = {
  question: string;
  photo?: Photo;
  web: boolean;
  answer?: string;
  observation?: string;
  nodes: HTMLElement[];
};
type Chat = {
  title: string;
  turns: Turn[];
  draft: string;
  web: boolean;
  photo?: Photo;
  loadingPhoto: number;
  busy: boolean;
  notice: string;
};
const chats: Chat[] = [];
let active: Chat;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
) {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}
function btn(label: string, fn: () => void, cls = "") {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = fn;
  return b;
}
function template(id: string) {
  return $<HTMLTemplateElement>(id).content.cloneNode(true);
}
function notice(text: string, chat = active) {
  chat.notice = text;
  if (chat === active) $("status").textContent = text;
}
function sync() {
  $("welcome").hidden = active.turns.length > 0;
  $("shortcuts").hidden = $("welcome").hidden;
  document
    .querySelector(".chat")!
    .classList.toggle("has-turns", active.turns.length > 0);
  $("chat-title").textContent = active.title;
  $("status").textContent = active.notice;
  $("attachment").hidden = !active.photo;
  if (active.photo) {
    $<HTMLImageElement>("photo-preview").src = active.photo.url;
    $("photo-name").textContent = active.photo.name;
  } else {
    $<HTMLImageElement>("photo-preview").removeAttribute("src");
  }
  $("web").setAttribute("aria-pressed", String(active.web));
  $<HTMLButtonElement>("send").disabled =
    active.busy ||
    !!active.loadingPhoto ||
    !(input.value.trim() || active.photo);
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
}
function historyNav() {
  $("history").replaceChildren(
    ...chats.map((chat) => {
      const button = btn("", () => select(chat), "history-item");
      button.setAttribute("aria-current", String(chat === active));
      button.append(template("history-icon"), el("span", "", chat.title));
      return button;
    }),
  );
}
function rail(open: boolean) {
  $("workspace").classList.toggle("rail-open", open);
  $("backdrop").hidden = !open;
  $("menu").setAttribute("aria-expanded", String(open));
  if (open) $("new-chat").focus();
}
function select(chat: Chat) {
  if (active) active.draft = input.value;
  active = chat;
  input.value = chat.draft;
  thread.replaceChildren(...chat.turns.flatMap((t) => t.nodes));
  rail(false);
  sync();
  historyNav();
  thread.scrollTop = thread.scrollHeight;
}
function newChat() {
  if (active && !active.turns.length && !active.photo && !input.value.trim()) {
    rail(false);
    input.focus();
    return;
  }
  const chat: Chat = {
    title: "新对话",
    turns: [],
    draft: "",
    web: false,
    busy: false,
    loadingPhoto: 0,
    notice: "",
  };
  chats.unshift(chat);
  select(chat);
}
$("new-chat").onclick = () => {
  newChat();
  input.focus();
};
$("menu").onclick = () => rail(!$("workspace").classList.contains("rail-open"));
$("backdrop").onclick = () => {
  rail(false);
  $("menu").focus();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("workspace").classList.contains("rail-open")) {
    rail(false);
    $("menu").focus();
  }
});
input.oninput = () => {
  active.draft = input.value;
  sync();
};
input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!$<HTMLButtonElement>("send").disabled) form.requestSubmit();
  }
};
$("web").onclick = () => {
  active.web = !active.web;
  sync();
};
$("attach").onclick = $("diagnose").onclick = () => file.click();
$("remove-photo").onclick = () => {
  active.loadingPhoto = 0;
  active.photo = undefined;
  sync();
  input.focus();
};
let photoJob = 0;
async function attach(f: File) {
  const chat = active,
    job = ++photoJob;
  chat.loadingPhoto = job;
  notice("正在准备图片…");
  sync();
  const url = URL.createObjectURL(f);
  try {
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
      f.size > 12 * 1024 * 1024
    )
      throw Error("请选择 12 MB 以内的 PNG、JPEG 或 WebP 图片。");
    const im = new Image();
    im.src = url;
    await im.decode();
    if (im.naturalWidth * im.naturalHeight > 40000000)
      throw Error("图片像素过大，请裁剪后添加。");
    const scale = Math.min(
      1,
      1600 / Math.max(im.naturalWidth, im.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(im.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(im.naturalHeight * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    let data = canvas.toDataURL("image/jpeg", 0.88);
    if (data.length > 1950000) data = canvas.toDataURL("image/jpeg", 0.68);
    if (data.length > 1950000)
      throw Error("图片细节过多，请裁剪到需要查看的区域。");
    if (chat.loadingPhoto === job) {
      chat.photo = { name: f.name || "粘贴的截图", url: data };
      notice("", chat);
    }
  } catch (e) {
    if (chat.loadingPhoto === job)
      notice(
        e instanceof Error && e.name === "Error"
          ? e.message
          : "图片无法打开，请换一张再试。",
        chat,
      );
  } finally {
    URL.revokeObjectURL(url);
    if (chat.loadingPhoto === job) chat.loadingPhoto = 0;
    if (chat === active) {
      sync();
      input.focus();
    }
  }
}
file.onchange = () => {
  const f = file.files?.[0];
  if (f) void attach(f);
  file.value = "";
};
form.addEventListener("paste", (e) => {
  const f = Array.from(e.clipboardData?.files ?? [])[0];
  if (f) {
    e.preventDefault();
    void attach(f);
  }
});
for (const name of ["dragover", "drop"])
  form.addEventListener(name, (e) => {
    const d = (e as DragEvent).dataTransfer;
    if (!d?.types.includes("Files")) return;
    e.preventDefault();
    form.classList.toggle("dragging", name === "dragover");
    if (name === "drop" && d.files[0]) void attach(d.files[0]);
  });
form.ondragleave = () => form.classList.remove("dragging");
$("find-doc").onclick = () => {
  input.value = "本机的项目文件夹要怎么添加？带我找到手册里的对应章节。";
  sync();
  form.requestSubmit();
};
$("report").onclick = () => {
  input.value = "帮我整理一个 GitHub Issue。";
  sync();
  form.requestSubmit();
};

let previewId = 0;
$("close-doc").onclick = () => dialog.close();
dialog.onclick = (e) => {
  if (e.target === dialog && e.clientX < dialog.getBoundingClientRect().left)
    dialog.close();
};
async function openDoc(url: URL, title: string, chapter?: string) {
  const id = ++previewId;
  const body = $("doc-text");
  body.replaceChildren(
    el("h2", "", chapter || title),
    el("p", "", "正在读取文档…"),
  );
  $<HTMLAnchorElement>("doc-link").href = url.href;
  if (!dialog.open) dialog.showModal();
  try {
    const res = await fetch(url.pathname);
    if (!res.ok) throw Error();
    const page = new DOMParser().parseFromString(await res.text(), "text/html");
    const content = page.querySelector(".guide-prose");
    if (!content) throw Error();
    const heading = url.hash
      ? page.getElementById(decodeURIComponent(url.hash.slice(1)))
      : null;
    let section = heading?.nextElementSibling ?? content.firstElementChild;
    let excerpts: string[] = [];
    while (section && excerpts.length < 5) {
      if (section.matches("h2") && excerpts.length) break;
      if (!section.matches("figure,img,script") && section.textContent?.trim())
        excerpts.push(section.textContent.trim().slice(0, 650));
      section = section.nextElementSibling;
    }
    if (!excerpts.length) throw Error();
    if (id === previewId)
      body.replaceChildren(
        el("h2", "", chapter || title),
        ...excerpts.map((t) => el("p", "", t)),
      );
  } catch {
    if (id === previewId)
      body.replaceChildren(
        el("h2", "", chapter || title),
        el("p", "", "预览暂时无法加载，可直接打开完整文档。"),
      );
  }
}
function citation(src: Source, id: number, inline: boolean): HTMLElement {
  const prefix = "[" + id + "]",
    cls = inline ? "cite" : "source";
  if (!src.url)
    return el("span", cls, inline ? prefix : prefix + " " + src.title);
  let url: URL;
  try {
    url = new URL(src.url);
  } catch {
    return el("span", cls, prefix);
  }
  if (url.protocol !== "https:") return el("span", cls, prefix);
  const guide =
    url.hostname === "claude-cage.com" &&
    guides.find((g) => g.path === url.pathname);
  if (guide) {
    const section = guide.sections.find((h) => h[0] === src.title);
    if (section) url.hash = section[1];
    const label = section ? guide.title + " · " + section[0] : guide.title;
    const b = btn(
      inline ? prefix : prefix + " " + label,
      () => void openDoc(url, guide.title, section?.[0]),
      cls,
    );
    b.setAttribute("aria-label", "预览文档：" + label);
    return b;
  }
  const link = el("a", cls, inline ? prefix : prefix + " " + src.title);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
function richAnswer(text: string, refs: Source[]) {
  const block = el("div", "answer");
  block.append(
    DOMPurify.sanitize(marked.parse(text, { async: false }), {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "code",
        "pre",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "blockquote",
        "table",
        "thead",
        "tbody",
        "th",
        "tr",
        "td",
      ],
      ALLOWED_ATTR: [],
      RETURN_DOM_FRAGMENT: true,
    }),
  );
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  const used = new Set<number>();
  for (const node of texts) {
    if (node.parentElement?.closest("pre,code")) continue;
    const value = node.data,
      frag = document.createDocumentFragment();
    let pos = 0;
    for (const m of value.matchAll(/\[(\d+)\]/g)) {
      const id = Number(m[1]);
      if (!refs[id - 1]) continue;
      frag.append(value.slice(pos, m.index), citation(refs[id - 1], id, true));
      pos = m.index! + m[0].length;
      used.add(id);
    }
    if (pos) {
      frag.append(value.slice(pos));
      node.replaceWith(frag);
    }
  }
  const sources = el("div", "sources");
  for (const id of used) sources.append(citation(refs[id - 1], id, false));
  return [block, sources];
}
function draftCard(draft: Draft) {
  const card = el("section", "issue");
  card.append(el("h3", "", "GitHub Issue 草稿"));
  const title = el("input");
  title.value = draft.title;
  title.maxLength = 160;
  const body = el("textarea");
  body.value = draft.body;
  body.maxLength = 6500;
  for (const [name, field] of [
    ["标题", title],
    ["正文", body],
  ] as const) {
    const label = el("label", "", name);
    label.append(field);
    card.append(label);
  }
  const msg = el(
    "p",
    "",
    "确认后，项目机器人会将以上文字公开发布到 Lee-xeo/Claude-Cage。截图不会随草稿上传。",
  );
  const publish = btn("确认并公开提交", async () => {
    if (!title.value.trim() || !body.value.trim()) {
      msg.textContent = "请填写标题和正文。";
      return;
    }
    publish.disabled = true;
    title.readOnly = body.readOnly = true;
    msg.textContent = "正在提交到 GitHub…";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "publish_issue",
          ticket: draft.ticket,
          title: title.value,
          body: body.value,
        }),
        signal: AbortSignal.timeout(40000),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || "提交失败，请重试。");
      if (
        !/^https:\/\/github\.com\/Lee-xeo\/Claude-Cage\/issues\/\d+$/.test(
          data.url,
        )
      )
        throw Error("未取得 Issue 链接，请重试。");
      const link = el("a", "", "查看 Issue #" + data.number + " ↗");
      link.href = data.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.replaceChildren(
        el("h3", "", "Issue 已提交"),
        el("p", "", title.value),
        link,
      );
    } catch (e) {
      publish.disabled = false;
      title.readOnly = body.readOnly = false;
      msg.textContent = e instanceof Error ? e.message : "提交失败，请重试。";
    }
  });
  card.append(msg, publish);
  return card;
}
function speaker() {
  const s = el("div", "speaker");
  s.append(template("bot-avatar"), el("span", "", "Cage 助手"));
  return s;
}
function sendMessage(question: string) {
  if (active.busy || active.loadingPhoto) return;
  const chat = active,
    photo = chat.photo;
  question = question.trim();
  if (!question && !photo) return;
  const u = el("div", "user-turn");
  if (photo) {
    const im = el("img", "user-photo");
    im.alt = "你发送的图片";
    im.src = photo.url;
    u.append(im);
  }
  if (question) u.append(el("div", "bubble", question));
  if (!question) question = "请帮我看看这张图片。";
  const a = el("div", "bot-turn"),
    turn: Turn = { question, photo, web: chat.web, nodes: [u, a] };
  chat.turns.push(turn);
  if (chat.turns.length === 1) chat.title = question.slice(0, 26);
  chat.photo = undefined;
  chat.draft = input.value = "";
  thread.append(u, a);
  historyNav();
  void run(chat, turn);
}
async function run(chat: Chat, turn: Turn) {
  chat.busy = true;
  const a = turn.nodes[1];
  a.replaceChildren(
    speaker(),
    el("p", "progress", turn.photo ? "正在看图并查阅资料…" : "正在查阅资料…"),
  );
  notice("", chat);
  if (active === chat) {
    sync();
    thread.scrollTop = thread.scrollHeight;
  }
  const history = chat.turns
    .slice(0, chat.turns.indexOf(turn))
    .filter((t) => t.answer)
    .slice(-6)
    .flatMap((t) => [
      {
        role: "user",
        content: Array.from(
          t.question + (t.observation ? "\n该轮截图：" + t.observation : ""),
        )
          .slice(0, 1800)
          .join(""),
      },
      {
        role: "assistant",
        content: Array.from(t.answer!).slice(0, 1800).join(""),
      },
    ]);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: turn.question,
        history,
        collect: true,
        web: turn.web,
        photo: turn.photo?.url,
      }),
      signal: AbortSignal.timeout(85000),
    });
    const data = await res.json();
    if (!res.ok || typeof data.answer !== "string")
      throw Error(data.error || "暂时没有收到回答。");
    turn.answer = data.answer;
    turn.observation = data.observation;
    a.replaceChildren(
      speaker(),
      ...richAnswer(data.answer, data.sources || []),
    );
    if (data.issue?.title && data.issue?.body && data.issue?.ticket)
      a.append(draftCard(data.issue));
    if (turn.web && !data.webCount)
      a.append(el("p", "progress-note", "本次联网查询未取得资料。"));
    const actions = el("div", "turn-tools");
    const copy = btn("复制回答", async () => {
      try {
        await navigator.clipboard.writeText(data.answer);
        copy.textContent = "已复制";
      } catch {
        notice("请选中回答文字后复制。", chat);
      }
    });
    actions.append(copy);
    if (!data.issue)
      actions.append(
        btn("整理为 Issue", () => {
          if (!chat.busy)
            sendMessage(
              "请把刚才关于“" +
                turn.question.slice(0, 150) +
                "”的问题和已经确认的信息整理成 GitHub Issue 草稿。",
            );
        }),
      );
    a.append(actions);
  } catch (e) {
    const retry = btn(
      "重试",
      () => {
        if (!chat.busy) void run(chat, turn);
      },
      "retry",
    );
    a.replaceChildren(
      speaker(),
      el(
        "p",
        "",
        e instanceof Error && !/fetch|timeout|JSON|load failed/i.test(e.message)
          ? e.message
          : "连接暂时失败，消息仍在这里。",
      ),
      retry,
    );
  } finally {
    chat.busy = false;
    if (active === chat) {
      sync();
      if (a.offsetHeight < thread.clientHeight * 0.7)
        thread.scrollTop = thread.scrollHeight;
    }
  }
}
form.onsubmit = (e) => {
  e.preventDefault();
  sendMessage(input.value);
};
newChat();
