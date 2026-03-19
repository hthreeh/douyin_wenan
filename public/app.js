const inputText = document.getElementById("inputText");
const submitBtn = document.getElementById("submitBtn");
const refreshHealthBtn = document.getElementById("refreshHealthBtn");
const errorSection = document.getElementById("errorSection");
const healthPill = document.getElementById("healthPill");
const progressSection = document.getElementById("progressSection");
const resultSection = document.getElementById("resultSection");
const statusText = document.getElementById("statusText");
const statusMessage = document.getElementById("statusMessage");
const jobMetaText = document.getElementById("jobMetaText");
const statusList = document.getElementById("statusList");
const coverImage = document.getElementById("coverImage");
const coverFallback = document.getElementById("coverFallback");
const titleText = document.getElementById("titleText");
const transcriptOutput = document.getElementById("transcriptOutput");
const srtOutput = document.getElementById("srtOutput");
const transcriptStat = document.getElementById("transcriptStat");
const copyBtn = document.getElementById("copyBtn");
const txtDownloadLink = document.getElementById("txtDownloadLink");
const srtDownloadLink = document.getElementById("srtDownloadLink");

const STATUS_ORDER = ["queued", "parsing", "downloading", "transcribing", "completed"];
const STATUS_LABELS = {
  queued: "任务已创建",
  parsing: "正在解析",
  downloading: "正在下载",
  transcribing: "正在提取文案",
  completed: "提取完成",
  failed: "提取失败",
};

let currentJobId = "";
let pollTimer = null;
let activeJob = false;
let runtimeReady = false;
let lastKnownStatus = "queued";

function syncSubmitState() {
  submitBtn.disabled = activeJob || !runtimeReady;
  submitBtn.classList.toggle("is-loading", activeJob);
}

function clearError() {
  errorSection.hidden = true;
  errorSection.textContent = "";
}

function showError(message) {
  errorSection.hidden = false;
  errorSection.textContent = message;
}

function resetStatusList(activeStatus = "queued") {
  const activeIndex = STATUS_ORDER.indexOf(activeStatus);
  [...statusList.querySelectorAll(".status-item")].forEach((item, index) => {
    item.classList.remove("is-done", "is-active");
    if (activeStatus === "failed") {
      return;
    }
    if (index < activeIndex) {
      item.classList.add("is-done");
    } else if (index === activeIndex) {
      item.classList.add("is-active");
    }
  });
}

function setHealthPill(text, mode) {
  healthPill.textContent = text;
  healthPill.className = `health-pill ${mode}`.trim();
}

async function refreshHealth() {
  setHealthPill("正在检查", "is-loading");
  refreshHealthBtn.disabled = true;

  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    const pythonReady = Boolean(payload?.python?.available);
    const asrReady = Boolean(payload?.asr?.reachable);

    runtimeReady = pythonReady && asrReady;
    if (runtimeReady) {
      setHealthPill("环境已就绪", "is-ready");
      clearError();
    } else {
      const reason = payload?.python?.error || payload?.asr?.error || "请先启动本地 ASR 服务";
      setHealthPill("环境未就绪", "is-error");
      if (!activeJob) {
        showError(reason);
      }
    }
  } catch (error) {
    runtimeReady = false;
    setHealthPill("检查失败", "is-error");
    if (!activeJob) {
      showError(error.message || "无法连接网页服务");
    }
  } finally {
    refreshHealthBtn.disabled = false;
    syncSubmitState();
  }
}

function resetResult() {
  resultSection.hidden = true;
  titleText.textContent = "未生成";
  transcriptOutput.value = "";
  srtOutput.value = "";
  transcriptStat.textContent = "0 字";
  txtDownloadLink.href = "#";
  srtDownloadLink.href = "#";
  coverImage.hidden = true;
  coverImage.removeAttribute("src");
  coverFallback.hidden = false;
}

function renderVideoMeta(video) {
  if (!video) {
    return;
  }
  titleText.textContent = video.title || "抖音视频";
  if (video.cover) {
    coverImage.src = video.cover;
    coverImage.hidden = false;
    coverFallback.hidden = true;
    coverImage.onerror = () => {
      coverImage.hidden = true;
      coverFallback.hidden = false;
    };
  } else {
    coverImage.hidden = true;
    coverFallback.hidden = false;
  }
}

function renderResult(result) {
  resultSection.hidden = false;
  titleText.textContent = result.title || "抖音视频";
  transcriptOutput.value = result.transcriptText || "";
  srtOutput.value = result.srtText || "";
  transcriptStat.textContent = `${(result.transcriptText || "").length} 字`;
  txtDownloadLink.href = result.downloads?.txt || "#";
  srtDownloadLink.href = result.downloads?.srt || "#";
  if (result.cover) {
    coverImage.src = result.cover;
    coverImage.hidden = false;
    coverFallback.hidden = true;
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderJob(payload) {
  const status = payload.status || "queued";
  if (status !== "failed") {
    lastKnownStatus = status;
  }

  progressSection.hidden = false;
  progressSection.classList.toggle("is-failed", status === "failed");
  statusText.textContent = STATUS_LABELS[status] || "处理中";
  statusMessage.textContent = payload.message || "服务端处理中";
  jobMetaText.textContent = `任务 ID：${payload.jobId}`;
  resetStatusList(status === "failed" ? lastKnownStatus : status);

  if (payload.video) {
    renderVideoMeta(payload.video);
  }

  if (status === "completed" && payload.result) {
    renderResult(payload.result);
    activeJob = false;
    syncSubmitState();
    stopPolling();
    clearError();
    refreshHealth();
    return;
  }

  if (status === "failed") {
    activeJob = false;
    syncSubmitState();
    stopPolling();
    showError(payload.error || payload.message || "任务执行失败");
  }
}

async function pollJob() {
  if (!currentJobId) {
    return;
  }

  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "无法读取任务状态");
    }
    renderJob(payload);
  } catch (error) {
    activeJob = false;
    syncSubmitState();
    stopPolling();
    showError(error.message || "轮询任务状态失败");
  }
}

async function submitJob() {
  const text = inputText.value.trim();
  if (!text) {
    showError("请先粘贴抖音分享文本或链接");
    inputText.focus();
    return;
  }

  if (!runtimeReady) {
    showError("环境还没有准备好，请先完成健康检查");
    return;
  }

  clearError();
  resetResult();
  progressSection.hidden = false;
  progressSection.classList.remove("is-failed");
  statusText.textContent = "任务已创建";
  statusMessage.textContent = "正在向服务端提交任务...";
  jobMetaText.textContent = "任务初始化中";
  resetStatusList("queued");

  activeJob = true;
  lastKnownStatus = "queued";
  syncSubmitState();
  stopPolling();

  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "创建任务失败");
    }

    currentJobId = payload.jobId;
    await pollJob();
    if (activeJob) {
      pollTimer = setInterval(pollJob, 1000);
    }
  } catch (error) {
    activeJob = false;
    syncSubmitState();
    showError(error.message || "创建任务失败");
  }
}

async function copyTranscript() {
  const text = transcriptOutput.value.trim();
  if (!text) {
    showError("当前还没有可复制的文案");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    clearError();
  } catch {
    transcriptOutput.focus();
    transcriptOutput.select();
    document.execCommand("copy");
  }
}

submitBtn.addEventListener("click", submitJob);
refreshHealthBtn.addEventListener("click", refreshHealth);
copyBtn.addEventListener("click", copyTranscript);
inputText.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    submitJob();
  }
});

resetResult();
resetStatusList("queued");
refreshHealth();
