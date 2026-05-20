// -------------------------------------------------------
// Streams HTML token by token
// -------------------------------------------------------
function typeHTML(element, html, speed = 10) {
  const tokens = html.match(/(<[^>]+>|[^<]+)/g);
  let i = 0;
  let currentParent = element;

  function typeToken() {
    if (i >= tokens.length) return;
    const token = tokens[i];

    if (token.startsWith("<")) {
      if (token === "<br>" || token === "<br/>") {
        currentParent.appendChild(document.createElement("br"));
      } else if (token.startsWith("</")) {
        currentParent = element;
      } else {
        const tagMatch = token.match(/^<(\w+)/);
        if (tagMatch) {
          const newTag = document.createElement(tagMatch[1]);
          currentParent.appendChild(newTag);
          currentParent = newTag;
        } else {
          currentParent.innerHTML += token;
        }
      }
      i++;
      typeToken();
    } else {
      let j = 0;
      const span = document.createElement("span");
      currentParent.appendChild(span);
      function typeChar() {
        if (j < token.length) {
          span.textContent += token.charAt(j);
          j++;
          setTimeout(typeChar, speed);
        } else {
          i++;
          typeToken();
        }
      }
      typeChar();
    }
  }
  typeToken();
}

// -------------------------------------------------------
// Build the sources section HTML from the RAG payload
// -------------------------------------------------------
function buildSourcesHTML(ragResults) {
  let html =
    `<br><br><br><br><span class="sources-header">Reliable LibGuide resources from the UC Davis Library:</span>` +
    ` <i>(Some resource links may require you to be signed into Kerberos or on ` +
    `the UC Davis Library VPN)</i><br><br>`;

  const grouped = new Map();

  ragResults.forEach((result, index) => {
    result.sources.forEach(src => {
      // Version 5 - Group by LibGuide, then list all resources under each guide
      if (!grouped.has(src.libguide_title)) {
        grouped.set(src.libguide_title, {
          section_url: src.section_url,
          resources: new Map(),
        });
      }
      grouped.get(src.libguide_title).resources.set(src.section_title, {
        external_url: src.external_url,
        section_url: src.section_url,
      });
    });
  });

  grouped.forEach((guide, title) => {
    html += `• <a href="${guide.section_url}" target="_blank" class="sources-guide-link">${title}</a><br>`;
    guide.resources.forEach((urls, section_title) => {
      html += `&nbsp;&nbsp;&nbsp;&nbsp;↳ <a href="${urls.external_url}" target="_blank">${section_title}</a><br>`;
    });
    html += `<br>`;
  });

  return html;
}

// -------------------------------------------------------
// Auto-link guide titles and section names in the summary.
//
// Guide titles: matched inside <strong>, <em>, or as plain
// text. The link wraps whatever tag is present (or just the
// text) so bold/italic styling is preserved.
//
// Section names: matched inside <code> (LLM backtick style)
// OR as plain text. Plain-text matches are wrapped in <code>
// so they visually match the existing section-name style.
//
// Both use a DOM-walk approach to avoid regex false-positives
// inside existing <a> tags or HTML attributes.
// Runs once after both LLM text and sources are fully rendered.
// -------------------------------------------------------
function linkSummaryToSources(llmSpan, ragResults) {
  const guideMap = new Map();   // libguide_title -> section_url
  const sectionMap = new Map(); // section_title  -> external_url

  ragResults.forEach(result => {
    result.sources.forEach(src => {
      if (src.libguide_title && src.section_url)
        guideMap.set(src.libguide_title, src.section_url);
      if (src.section_title && src.external_url)
        sectionMap.set(src.section_title, src.external_url);
    });
  });

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Helper: is this node inside an <a> tag already?
  function insideAnchor(node) {
    let p = node.parentNode;
    while (p && p !== llmSpan) {
      if (p.nodeName === 'A') return true;
      p = p.parentNode;
    }
    return false;
  }

  // Walk all text nodes in llmSpan, skipping nodes already inside <a>.
  // For each matching title, split the text node and insert an <a> (and
  // optionally a wrapping <code>) in its place.
  function linkTextNodes(titleMap, wrapCode) {
    // Collect text nodes first (walking mutates the tree)
    const walker = document.createTreeWalker(llmSpan, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    textNodes.forEach(textNode => {
      if (insideAnchor(textNode)) return;

      // Build one big alternation regex from all titles (longest first to
      // avoid partial matches swallowing a longer title)
      const sorted = [...titleMap.keys()].sort((a, b) => b.length - a.length);
      if (!sorted.length) return;
      const pattern = sorted.map(esc).join('|');
      const re = new RegExp(`(${pattern})`, 'gi');

      const text = textNode.textContent;
      if (!re.test(text)) return;
      re.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let match;

      while ((match = re.exec(text)) !== null) {
        const matched = match[0];
        // Find the canonical-case key
        const canonicalKey = sorted.find(
          k => k.toLowerCase() === matched.toLowerCase()
        );
        if (!canonicalKey) continue;
        const url = titleMap.get(canonicalKey);

        // Text before the match
        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        // Build the link (and optional code wrapper)
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        if (!wrapCode) a.style.textDecoration = 'none';
        a.textContent = matched;

        if (wrapCode) {
          const code = document.createElement('code');
          code.appendChild(a);
          frag.appendChild(code);
        } else {
          frag.appendChild(a);
        }

        lastIndex = match.index + matched.length;
      }

      if (lastIndex === 0) return; // no matches — leave node alone
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  // ── Guide titles ──────────────────────────────────────────
  // Pass 1: tag-based matches (<strong> / <em>) — wrap the whole element in <a>
  let html = llmSpan.innerHTML;
  guideMap.forEach((url, title) => {
    ['strong', 'em'].forEach(tag => {
      const re = new RegExp(
        `(?<!<a[^>]*>)(<${tag}>)(${esc(title)})(<\\/${tag}>)(?!<\\/a>)`, 'gi'
      );
      html = html.replace(re,
        `<a href="${url}" target="_blank" style="text-decoration:none">$1$2$3</a>`
      );
    });
  });
  llmSpan.innerHTML = DOMPurify.sanitize(html);

  // Pass 2: plain-text matches (DOM walk, skips existing <a> nodes)
  linkTextNodes(guideMap, false);

  // ── Section names ─────────────────────────────────────────
  // Pass 1: <code>SectionName</code> tag-based matches
  html = llmSpan.innerHTML;
  sectionMap.forEach((url, title) => {
    const re = new RegExp(`<code>(${esc(title)})<\\/code>`, 'gi');
    html = html.replace(re,
      `<code><a href="${url}" target="_blank">${title}</a></code>`
    );
  });
  llmSpan.innerHTML = DOMPurify.sanitize(html);

  // Pass 2: plain-text section matches (wrapped in <code> for visual consistency)
  linkTextNodes(sectionMap, true);
}

// -------------------------------------------------------
// Welcome screen → chat swap on first message
// -------------------------------------------------------
let chatStarted = false;

function activateChat() {
  if (chatStarted) return;
  chatStarted = true;
  document.getElementById("welcome-screen").classList.add("hidden");
  document.getElementById("chat-main").classList.remove("hidden");
  document.getElementById("new-chat-btn").classList.remove("hidden");
}

function newChat() {
  chatStarted = false;
  document.getElementById("chat-box").innerHTML = "";
  document.getElementById("chat-main").classList.add("hidden");
  document.getElementById("welcome-screen").classList.remove("hidden");
  document.getElementById("new-chat-btn").classList.add("hidden");
  document.getElementById("welcome-user-input").focus();
}

// -------------------------------------------------------
// Send message — handles streaming response
// -------------------------------------------------------
async function sendMessage() {
  const welcomeInput = document.getElementById("welcome-user-input");
  const chatInput = document.getElementById("user-input");

  const activeInput = chatStarted ? chatInput : welcomeInput;
  const userMessage = activeInput.value.trim();
  if (!userMessage) return;
  activeInput.value = "";
  activeInput.style.height = "auto";
  activeInput.style.overflowY = "hidden";

  activateChat();

  const chatBox = document.getElementById("chat-box");

  const userDiv = document.createElement("div");
  userDiv.className = "message user";
  const userBubble = document.createElement("span");
  userBubble.className = "user-bubble";
  userBubble.textContent = userMessage;
  userDiv.appendChild(userBubble);
  chatBox.appendChild(userDiv);

  const botDiv = document.createElement("div");
  botDiv.className = "message bot";
  chatBox.appendChild(botDiv);

  const statusDiv = document.createElement("div");
  statusDiv.className = "loading-status";
  statusDiv.innerHTML = `<div class="loading-spinner"></div><span class="status-text"></span>`;
  chatBox.appendChild(statusDiv);

  const normalPhrases = [
    "Thinking...",
    "Pondering...",
    "Scanning sources...",
    "Reading through the docs...",
    "Connecting the dots...",
    "Searching the library...",
    "Sifting through pages...",
    "Finding relevant info...",
    "Formulating a response...",
    "Almost there...",
    "Cross-referencing sources...",
    "Reviewing the material...",
    "Warming up the neurons...",
    "Consulting the oracle...",
    "Doing the math...",
    "Summoning knowledge...",
    "Thinking really hard...",
    "Reading between the lines...",
    "Interrogating the data...",
    "Teaching myself things...",
    "Negotiating with my training data...",
    "Having a quick existential moment...",
    "Converting electricity to wisdom...",
    "Asking my inner monologue...",
    "Pretending I knew this already...",
    "Definitely not making this up...",
    "Checking my notes...",
    "One moment of genius incoming...",
    "Staring into the void productively...",
    "Running it by the committee...",
  ];
  const davisPhrases = [
    "Tipping cows...",
    "Waiting in line at Lawntopia...",
    "Touching the Egghead...",
    "Sleeping through my 8am...",
    "Finding parking on campus...",
    "Waiting for the Unitrans bus...",
    "Petting the horses at the barn...",
    "Counting bikes on the path...",
    "Feeding the ducks at Putah Creek...",
    "Dodging cyclists on the quad...",
    "Checking the Silo menu...",
    "Getting lost in the Death Star...",
    "Trying to escape the Wellman Hall basement...",
    "Waiting in line for lat pulldowns in the ARC...",
    "Watching the cows chew...",
    "Untangling the bike lock...",
    "Chasing the geese off the quad...",
  ];
  const pickPhrase = () => Math.random() < 0.33
    ? davisPhrases[Math.floor(Math.random() * davisPhrases.length)]
    : normalPhrases[Math.floor(Math.random() * normalPhrases.length)];

  // set a phrase immediately, then rotate every 2s
  statusDiv.querySelector(".status-text").textContent = pickPhrase();
  const phraseInterval = setInterval(() => {
    const textSpan = statusDiv.querySelector(".status-text");
    if (textSpan) textSpan.textContent = pickPhrase();
  }, 3500);

  const llmSpan = document.createElement("span");
  botDiv.appendChild(llmSpan);

  const sourcesDiv = document.createElement("div");
  botDiv.appendChild(sourcesDiv);

  chatBox.scrollTop = chatBox.scrollHeight;

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage, top_k: 3 }),
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sourcesRendered = false;
    let fullLLMResponse = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (!sourcesRendered && buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const firstLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (firstLine.startsWith("SOURCES:")) {
          try {
            sourcesDiv._ragResults = JSON.parse(firstLine.slice("SOURCES:".length));
            sourcesRendered = true;
          } catch (e) { console.error("Source parse error", e); }
        }
      }

      if (sourcesRendered && buffer.length > 0) {
        if (statusDiv && statusDiv.parentNode) {
          clearInterval(phraseInterval);
          statusDiv.remove();
          llmSpan.classList.add("fade-in-text");
        }

        fullLLMResponse += buffer;
        buffer = "";

        const rawHtml = marked.parse(fullLLMResponse);
        llmSpan.innerHTML = DOMPurify.sanitize(rawHtml);

        chatBox.scrollTop = chatBox.scrollHeight;
      }
    }

    try {
      if (sourcesDiv._ragResults) {
        console.log("RAG results:", JSON.stringify(sourcesDiv._ragResults, null, 2));
        sourcesDiv.innerHTML = buildSourcesHTML(sourcesDiv._ragResults);
        linkSummaryToSources(llmSpan, sourcesDiv._ragResults);
      }
    } catch (e) {
      console.error("Failed to render sources:", e);
      sourcesDiv.textContent = "(Could not render sources)";
    }

  } catch (error) {
    clearInterval(phraseInterval);
    const statusText = statusDiv.querySelector(".status-text");
    if (statusText) statusText.textContent = "Failed to reach the server. Please try again.";
    console.error("Fetch error:", error);
  }

  chatBox.scrollTop = chatBox.scrollHeight;
}

// -------------------------------------------------------
// Evil mode easter egg — type console.log(67) in DevTools
// -------------------------------------------------------
let evilMode = false;
const logo = document.getElementById("logo");
const welcomeLogo = document.getElementById("welcome-logo");

function toggleEvilMode() {
  evilMode = !evilMode;
  document.body.classList.toggle("evil", evilMode);

  if (evilMode) {
    welcomeLogo.src = "assets/logo-dark.svg";
  } else {
    const isDark = document.body.classList.contains("dark");
    welcomeLogo.src = isDark ? "assets/logo-dark.svg" : "assets/logo-light-transparent.svg";
  }
}

const _origConsoleLog = console.log;
console.log = function (...args) {
  if (args.length === 1 && (args[0] === 67 || args[0] === "67")) {
    toggleEvilMode();
    _origConsoleLog.call(console, `[evil mode ${evilMode ? "ON" : "OFF"}]`);
    return;
  }
  _origConsoleLog.apply(console, args);
};

// -------------------------------------------------------
// Dark mode toggle + persistence
// -------------------------------------------------------
const modeToggle = document.getElementById("mode-toggle");
const iconMoon = document.getElementById("icon-moon");
const iconSun = document.getElementById("icon-sun");

function applyTheme(isDark) {
  document.body.classList.toggle("dark", isDark);
  iconMoon.style.display = isDark ? "none" : "block";
  iconSun.style.display = isDark ? "block" : "none";
  logo.src = isDark ? "assets/datalab-logo-gold.svg" : "assets/datalab-logo-black.svg";
  if (!evilMode) {
    welcomeLogo.src = isDark ? "assets/logo-dark.svg" : "assets/logo-light-transparent.svg";
  }
}

// Restore saved preference on load
applyTheme(localStorage.getItem("theme") === "dark");

modeToggle.addEventListener("click", () => {
  const isDark = !document.body.classList.contains("dark");
  applyTheme(isDark);
  localStorage.setItem("theme", isDark ? "dark" : "light");
});

// -------------------------------------------------------
// Enter key to send
// -------------------------------------------------------
function autoResizeTextarea(el) {
  el.style.height = "auto";
  const capped = Math.min(el.scrollHeight, 140);
  el.style.height = capped + "px";
  el.style.overflowY = el.scrollHeight > 140 ? "auto" : "hidden";
}

document.addEventListener("DOMContentLoaded", function () {
  ["user-input", "welcome-user-input"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    el.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    el.addEventListener("input", function () {
      autoResizeTextarea(el);
    });
  });
});