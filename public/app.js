const $ = (id) => document.getElementById(id);

const state = { current: null, selected: null, analysis: null };

// ---------- helpers ----------
const fmtSize = (b) => {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const fmtDur = (s) => {
  if (!s) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}h ` : "") + `${m}m ${sec}s`;
};
const fmtEta = (s) => {
  if (s == null) return "";
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), sec = s % 60;
  return `ETA ${m}:${String(sec).padStart(2, "0")}`;
};

// ---------- file browser ----------
async function listDir(dir) {
  $("fileList").innerHTML = `<li class="muted">Loading…</li>`;
  try {
    const r = await fetch(`/api/list?dir=${encodeURIComponent(dir || "~")}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    state.current = data.dir;
    state.parent = data.parent; // null at a drive root / filesystem root
    $("crumbPath").textContent = data.dir;
    $("upBtn").disabled = !data.parent && !navigator.platform.startsWith("Win");
    renderList(data);
  } catch (e) {
    $("fileList").innerHTML = `<li class="muted">⚠ ${e.message}</li>`;
  }
}

function renderList(data) {
  const ul = $("fileList");
  ul.innerHTML = "";
  if (data.parent) {
    ul.appendChild(row("📁", "..", () => listDir(data.parent)));
  }
  if (!data.entries.length) {
    ul.appendChild(Object.assign(document.createElement("li"),
      { className: "muted", textContent: "No videos or folders here." }));
  }
  for (const e of data.entries) {
    if (e.type === "dir") {
      ul.appendChild(row("📁", e.name, () => listDir(e.path)));
    } else {
      const li = row("🎬", e.name, () => selectFile(e));
      const sz = document.createElement("span");
      sz.className = "sz"; sz.textContent = fmtSize(e.size);
      li.appendChild(sz);
      ul.appendChild(li);
    }
  }
}

function row(icon, label, onClick) {
  const li = document.createElement("li");
  const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = icon;
  const tx = document.createElement("span"); tx.textContent = label;
  li.append(ic, tx);
  li.onclick = onClick;
  return li;
}

// ---------- selection + analysis ----------
async function selectFile(entry) {
  state.selected = entry;
  $("selectedPanel").classList.remove("hidden");
  $("optionsPanel").classList.remove("hidden");
  $("progressPanel").classList.add("hidden");
  $("selName").textContent = entry.name;
  $("selInfo").textContent = fmtSize(entry.size);
  $("planBadge").textContent = "analyzing…";
  $("planBadge").className = "badge";
  await analyze();
}

async function analyze() {
  if (!state.selected) return;
  const fmt = $("format").value;
  try {
    const r = await fetch(
      `/api/analyze?path=${encodeURIComponent(state.selected.path)}&format=${fmt}`
    );
    const a = await r.json();
    if (a.error) throw new Error(a.error);
    state.analysis = a;
    const v = a.video
      ? `${a.video.codec?.toUpperCase()} ${a.video.width}×${a.video.height}`
      : "no video";
    const audio = a.audioCodecs?.length ? ` · ${a.audioCodecs.join("/")}` : "";
    $("selInfo").textContent =
      `${v}${audio} · ${fmtDur(a.duration)} · ${fmtSize(a.size)}`;
    const badge = $("planBadge");
    badge.textContent = (a.instant ? "⚡ " : "") + a.planLabel;
    badge.className = "badge" + (a.instant ? "" : " warn");
  } catch (e) {
    $("planBadge").textContent = "⚠ " + e.message;
    $("planBadge").className = "badge warn";
  }
}

// re-analyze when target container changes (affects remux feasibility)
$("format").addEventListener("change", analyze);

// ---------- conversion over WebSocket ----------
function convert() {
  if (!state.selected) return;
  $("progressPanel").classList.remove("hidden");
  $("result").classList.add("hidden");
  $("convertBtn").disabled = true;
  setProgress(0, "", "");
  $("progTitle").textContent = "Converting…";
  $("logline").textContent = "";

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => ws.send(JSON.stringify({
    action: "convert",
    path: state.selected.path,
    format: $("format").value,
    codec: $("codec").value,
    quality: $("quality").value,
    mode: $("mode").value,
  }));

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "start") {
      $("progTitle").textContent = m.instant ? "Remuxing (instant)…" : "Converting…";
      $("logline").textContent = m.plan;
    } else if (m.type === "progress") {
      const speed = m.speed ? `${m.speed.toFixed(1)}×` : "";
      setProgress(m.percent, speed, fmtEta(m.eta));
    } else if (m.type === "notice") {
      $("logline").textContent = m.message;
    } else if (m.type === "done") {
      setProgress(100, "", "");
      $("progTitle").textContent = "Done ✓";
      showResult(false,
        `Saved to <code>${m.output}</code><br>` +
        `Size: ${fmtSize(m.outputSize)}${m.software ? " · (software encoder)" : ""}. ` +
        `Open it in any player — no VLC needed.`);
      $("convertBtn").disabled = false;
      ws.close();
    } else if (m.type === "error") {
      $("progTitle").textContent = "Failed";
      showResult(true, m.message);
      $("convertBtn").disabled = false;
      ws.close();
    } else if (m.type === "closed") {
      $("convertBtn").disabled = false;
    }
  };

  ws.onerror = () => {
    showResult(true, "Connection error");
    $("convertBtn").disabled = false;
  };
}

function setProgress(p, speed, eta) {
  $("fill").style.width = `${p}%`;
  $("pct").textContent = `${Math.round(p)}%`;
  $("speed").textContent = speed;
  $("eta").textContent = eta;
}

function showResult(isError, html) {
  const r = $("result");
  r.classList.remove("hidden");
  r.className = "result" + (isError ? " error" : "");
  r.innerHTML = html;
}

$("convertBtn").addEventListener("click", convert);
$("drivesBtn").addEventListener("click", () =>
  listDir(navigator.platform.startsWith("Win") ? "/" : "~"));
$("upBtn").addEventListener("click", () => {
  // Go up one level; at a drive root (parent === null) on Windows, show the drive list.
  if (state.parent) listDir(state.parent);
  else if (navigator.platform.startsWith("Win")) listDir("/");
});

// initial load
listDir("~");
