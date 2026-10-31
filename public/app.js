const promptInput = document.querySelector("#prompt");
const negativeInput = document.querySelector("#negativePrompt");
const styleInput = document.querySelector("#style");
const backgroundInput = document.querySelector("#background");
const countInput = document.querySelector("#count");
const countValue = document.querySelector("#countValue");
const genCountEl = document.querySelector("#genCount");
const costEstimateEl = document.querySelector("#costEstimate");
const exportPanel = document.querySelector("#exportPanel");
const nameInput = document.querySelector("#name");
const presetInput = document.querySelector("#preset");
const paddingInput = document.querySelector("#padding");
const paddingValue = document.querySelector("#paddingValue");
const roundedInput = document.querySelector("#rounded");

const enhanceButton = document.querySelector("#enhanceButton");
const conceptsButton = document.querySelector("#conceptsButton");
const cancelButton = document.querySelector("#cancelButton");
const finalizeButton = document.querySelector("#finalizeButton");
const selectAllButton = document.querySelector("#selectAll");
const selectNoneButton = document.querySelector("#selectNone");

const statusEl = document.querySelector("#status");
const progress = document.querySelector("#progress");
const progressBar = document.querySelector("#progressBar");

const conceptGrid = document.querySelector("#conceptGrid");
const conceptsHint = document.querySelector("#conceptsHint");
const conceptsTitle = document.querySelector("#conceptsTitle");
const finalsTitle = document.querySelector("#finalsTitle");
const finalGrid = document.querySelector("#finalGrid");

const POLL_MS = 250; // live progress cadence the user asked for
let currentRunId = null;
let renderedConceptIds = new Set();
let renderedFinalIds = new Set();

fetch("/config")
  .then((r) => r.json())
  .then((c) => {
    const hint = document.querySelector("#saveHint");
    if (hint && c.outputDir) hint.textContent = c.outputDir;
    if (c.maxConcepts) countInput.max = String(c.maxConcepts);
  })
  .catch(() => {});

// Keep the count readout, the Generate button label, and the cost estimate
// (~$0.026/image) in sync as the slider moves.
function updateCount() {
  const n = Number(countInput.value);
  countValue.textContent = n;
  if (genCountEl) genCountEl.textContent = n;
  if (costEstimateEl) {
    const cost = (n * 0.026).toFixed(2);
    costEstimateEl.innerHTML = `<b>~$${cost}</b> · ${n} image${n === 1 ? "" : "s"}`;
  }
}
countInput.addEventListener("input", updateCount);
updateCount();
paddingInput.addEventListener("input", () => {
  paddingValue.textContent = `${paddingInput.value}%`;
});

enhanceButton.addEventListener("click", async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) return setStatus("Type a prompt to enhance first.");
  busy(true);
  startBar("Expanding your prompt with DeepSeek…");
  try {
    const data = await postJson("/enhance", { prompt });
    promptInput.value = data.enhanced;
    finishBar("Prompt enhanced.");
  } catch (err) {
    failBar(err);
  } finally {
    busy(false);
  }
});

conceptsButton.addEventListener("click", async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) return setStatus("Type a prompt first.");
  busy(true);
  conceptGrid.innerHTML = "";
  finalGrid.innerHTML = "";
  finalsTitle.hidden = true;
  conceptsHint.hidden = true;
  renderedConceptIds = new Set();
  hideConceptActions();
  try {
    const { jobId, total } = await postJson("/concepts/start", {
      prompt,
      negativePrompt: negativeInput.value.trim(),
      style: styleInput.value,
      background: backgroundInput.value,
      count: Number(countInput.value),
    });
    currentRunId = jobId;
    showCancel(true);
    conceptsTitle.textContent = `Concepts (0/${total})`;
    await pollJob(jobId, (p) => {
      for (const it of p.items) addConceptCard(it);
      conceptsTitle.textContent = `Concepts (${p.completed}/${p.total})`;
    });
    showConceptActions();
  } catch (err) {
    failBar(err);
  } finally {
    showCancel(false);
    busy(false);
  }
});

cancelButton.addEventListener("click", async () => {
  if (!currentRunId) return;
  cancelButton.disabled = true;
  setStatus("Cancelling…");
  try {
    await fetch(`/cancel/${currentRunId}`, { method: "POST" });
  } catch {
    // poll loop will still settle the job; ignore network blips here
  }
});

finalizeButton.addEventListener("click", async () => {
  if (!currentRunId) return;
  const conceptIds = [...conceptGrid.querySelectorAll("input:checked")].map((c) => Number(c.value));
  busy(true);
  finalsTitle.hidden = false;
  finalGrid.innerHTML = "";
  renderedFinalIds = new Set();
  try {
    const { jobId } = await postJson("/finalize/start", {
      runId: currentRunId,
      conceptIds,
      name: nameInput.value.trim(),
      padding: Number(paddingInput.value),
      background: backgroundInput.value,
      rounded: roundedInput.checked,
      preset: presetInput.value,
    });
    await pollJob(jobId, (p) => {
      for (const it of p.items) addFinalCard(it);
    });
    busy(false);
  } catch (err) {
    failBar(err);
    busy(false);
  }
});

selectAllButton.addEventListener("click", () => {
  conceptGrid.querySelectorAll("input[type=checkbox]").forEach((c) => {
    c.checked = true;
    c.closest(".concept").classList.add("selected");
  });
  updateSelectionCount();
});
selectNoneButton.addEventListener("click", () => {
  conceptGrid.querySelectorAll("input[type=checkbox]").forEach((c) => {
    c.checked = false;
    c.closest(".concept").classList.remove("selected");
  });
  updateSelectionCount();
});

// ── Polling ──────────────────────────────────────────────────────────────────
// Polls /progress/:id every 250ms, calls onTick(state) each time, resolves when
// the job reports done. Keeps a determinate bar + live status updating.
function pollJob(jobId, onTick) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const p = await (await fetch(`/progress/${jobId}`)).json();
        if (p.error && !p.total) throw new Error(p.error);
        onTick(p);
        const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
        setBar(pct);
        const secs = (p.elapsedMs / 1000).toFixed(1);
        setStatus(`${p.statusLine}  ·  ${pct}%  ·  ${secs}s`);
        if (p.done) {
          clearInterval(timer);
          if (p.error) {
            failBar(new Error(p.error));
            reject(new Error(p.error));
          } else {
            finishBar(p.statusLine);
            resolve(p);
          }
        }
      } catch (err) {
        clearInterval(timer);
        failBar(err);
        reject(err);
      }
    }, POLL_MS);
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────
function addConceptCard(item) {
  if (renderedConceptIds.has(item.id)) return;
  renderedConceptIds.add(item.id);
  const card = document.createElement("label");
  card.className = "concept enter";
  if (item.error) {
    card.classList.add("error");
    card.innerHTML = `<div class="thumb err">!</div><span class="tag">#${item.id} failed</span>`;
  } else {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = item.id;
    checkbox.addEventListener("change", () => {
      card.classList.toggle("selected", checkbox.checked);
      updateSelectionCount();
    });
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = item.url;
    thumb.appendChild(img);
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${item.id}`;
    card.append(checkbox, thumb, tag);
  }
  conceptGrid.appendChild(card);
}

function addFinalCard(item) {
  if (renderedFinalIds.has(item.id)) return;
  renderedFinalIds.add(item.id);
  const card = document.createElement("div");
  card.className = "final enter";
  const src = conceptGrid.querySelector(`input[value="${item.id}"]`);
  const previewImg = src ? src.parentElement.querySelector(".thumb img") : null;
  const previewHtml = previewImg ? `<img src="${previewImg.src}">` : "";
  if (item.error) {
    card.innerHTML = `<div class="thumb err">!</div><span class="tag">#${item.id} failed</span>`;
  } else {
    card.innerHTML =
      `<div class="thumb">${previewHtml}</div>` +
      `<span class="tag">#${item.id}</span>` +
      `<a class="download" href="${item.zip}" download>Download pack</a>`;
  }
  finalGrid.appendChild(card);
}

function showConceptActions() {
  const has = conceptGrid.querySelector(".concept:not(.error)");
  selectAllButton.hidden = !has;
  selectNoneButton.hidden = !has;
  finalizeButton.hidden = !has;
  if (exportPanel) exportPanel.hidden = !has;
  updateSelectionCount();
}
function hideConceptActions() {
  selectAllButton.hidden = true;
  selectNoneButton.hidden = true;
  finalizeButton.hidden = true;
  if (exportPanel) exportPanel.hidden = true;
}
function updateSelectionCount() {
  const n = conceptGrid.querySelectorAll("input:checked").length;
  finalizeButton.textContent =
    n === 0 ? "Download all concepts" : `Download ${n} selected`;
}

// ── Net + bar helpers ────────────────────────────────────────────────────────
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Request failed." }));
    throw new Error(err.error || `Request failed (${response.status})`);
  }
  return response.json();
}

function busy(on) {
  enhanceButton.disabled = on;
  conceptsButton.disabled = on;
  finalizeButton.disabled = on;
}
function showCancel(on) {
  cancelButton.hidden = !on;
  cancelButton.disabled = false;
}
function setStatus(msg) {
  statusEl.textContent = msg;
}
function startBar(msg) {
  progress.classList.add("active");
  progress.classList.remove("indeterminate");
  progressBar.style.width = "8%";
  setStatus(msg);
}
function setBar(pct) {
  progress.classList.add("active");
  progressBar.style.width = `${Math.max(4, pct)}%`;
}
function finishBar(msg) {
  progressBar.style.width = "100%";
  setStatus(msg);
  setTimeout(() => {
    progress.classList.remove("active");
    progressBar.style.width = "0%";
  }, 700);
}
function failBar(err) {
  progress.classList.remove("active");
  progressBar.style.width = "0%";
  setStatus(err.message || "Something went wrong.");
}
