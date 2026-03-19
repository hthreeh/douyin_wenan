const express = require("express");
const axios = require("axios");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const RUNS_DIR = path.join(__dirname, "runs");
const PUBLIC_DIR = path.join(__dirname, "public");
const BRIDGE_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 20 * 60 * 1000);
const QWEN_GRADIO_URL = (process.env.QWEN_GRADIO_URL || "http://127.0.0.1:8000").trim();
const PYTHON_BRIDGE = process.env.PYTHON_BRIDGE
  ? path.resolve(process.env.PYTHON_BRIDGE)
  : path.join(__dirname, "python", "bridge.py");

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const ALLOWED_DOMAINS = new Set([
  "aweme.snssdk.com",
  "v26-web.douyinvod.com",
  "v3-web.douyinvod.com",
  "v5-web.douyinvod.com",
  "v9-web.douyinvod.com",
  "v11-web.douyinvod.com",
  "v16-web.douyinvod.com",
  "v19-web.douyinvod.com",
  "v26-cold.douyinvod.com",
  "v3-cold.douyinvod.com",
]);
const JOB_STATUSES = new Set([
  "queued",
  "parsing",
  "downloading",
  "transcribing",
  "completed",
  "failed",
]);

const rateLimit = new Map();
const jobs = new Map();
let pythonHealthCache = { expiresAt: 0, value: null };

app.use(express.json({ limit: "10kb" }));
app.use(express.static(PUBLIC_DIR));

fs.mkdirSync(RUNS_DIR, { recursive: true });

const PYTHON_BIN = resolvePythonBin();

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimit.entries()) {
    if (now - record.start > 60 * 1000) {
      rateLimit.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function resolvePythonBin() {
  const candidates = [
    process.env.PYTHON_BIN,
    "F:\\qwen_asr\\qwen_asr_env\\Scripts\\python.exe",
    path.join(__dirname, ".venv", "Scripts", "python.exe"),
    "python",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "python") {
      return candidate;
    }
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Keep searching.
    }
  }

  return "python";
}

function normalizeError(error) {
  if (!error) {
    return "未知错误";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.response?.data?.error) {
    return String(error.response.data.error);
  }
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.message) {
    return String(error.message).trim();
  }
  return "未知错误";
}

function sanitizeFilename(name) {
  const raw = String(name || "transcript").trim();
  const cleaned = raw.replace(/[\\/:*?"<>|#]/g, "").replace(/\s+/g, "_");
  return cleaned.slice(0, 80) || "transcript";
}

function normalizeMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  return trimmed;
}

function removeWatermark(url) {
  return normalizeMediaUrl(url).replace(/playwm/g, "play");
}

function isAllowedUrl(rawUrl) {
  try {
    const parsed = new URL(normalizeMediaUrl(rawUrl));
    return (
      parsed.hostname.endsWith(".douyinvod.com") ||
      parsed.hostname.endsWith(".snssdk.com") ||
      parsed.hostname.endsWith(".douyinpic.com") ||
      parsed.hostname.endsWith(".douyincdn.com") ||
      ALLOWED_DOMAINS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const existing = rateLimit.get(ip);
  if (!existing || now - existing.start > 60 * 1000) {
    rateLimit.set(ip, { start: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 15;
}

function extractDouyinUrl(text) {
  const patterns = [
    /https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+\/?/i,
    /https?:\/\/www\.douyin\.com\/video\/\d+/i,
    /https?:\/\/www\.iesdouyin\.com\/share\/video\/\d+/i,
    /https?:\/\/www\.douyin\.com\/note\/\d+/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function extractVideoId(url) {
  const patterns = [/video\/(\d+)/, /modal_id=(\d+)/, /item_ids=(\d+)/, /group_id=(\d+)/];
  for (const pattern of patterns) {
    const match = String(url || "").match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function pickFirstString(candidates, fallback = "") {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return fallback;
}

function extractAddressUrl(address) {
  if (!address || typeof address !== "object") {
    return "";
  }
  const urlList = address.url_list || address.urlList || [];
  return normalizeMediaUrl(urlList[0] || address.uri || "");
}

function extractBestQualityUrl(videoObj) {
  const bitRateList = videoObj.bit_rate || videoObj.bitRate || videoObj.bit_rate_list;
  if (Array.isArray(bitRateList) && bitRateList.length > 0) {
    const sorted = [...bitRateList].sort((left, right) => {
      return Number(right.bit_rate || right.bitRate || 0) - Number(left.bit_rate || left.bitRate || 0);
    });
    for (const item of sorted) {
      const candidate = extractAddressUrl(item.play_addr || item.playAddr);
      if (candidate) {
        return removeWatermark(candidate);
      }
    }
  }

  const h264 = extractAddressUrl(videoObj.play_addr_h264 || videoObj.playAddrH264);
  if (h264) {
    return removeWatermark(h264);
  }

  const playAddr = extractAddressUrl(videoObj.play_addr || videoObj.playAddr);
  if (playAddr) {
    return removeWatermark(playAddr);
  }

  return "";
}

function extractCover(obj) {
  return normalizeMediaUrl(
    pickFirstString(
      [
        obj?.cover?.url_list?.[0],
        obj?.cover?.urlList?.[0],
        obj?.origin_cover?.url_list?.[0],
        obj?.originCover?.url_list?.[0],
        obj?.dynamic_cover?.url_list?.[0],
      ],
      "",
    ),
  );
}

function extractTitle(obj, fallback = "抖音视频") {
  return pickFirstString(
    [
      obj?.desc,
      obj?.title,
      obj?.share_info?.share_title,
      obj?.seo_info?.seo_title,
      obj?.aweme_detail?.desc,
      obj?.item?.desc,
    ],
    fallback,
  );
}

function buildVideoInfo(videoObj, context = null) {
  const videoUrl = extractBestQualityUrl(videoObj);
  if (!videoUrl) {
    return null;
  }

  return {
    title: extractTitle(context || videoObj, "抖音视频"),
    cover: extractCover(videoObj) || extractCover(context || {}),
    videoUrl,
    width: Number(videoObj.width || 0),
    height: Number(videoObj.height || 0),
  };
}

function findVideoData(obj, depth = 0, context = null) {
  if (depth > 15 || !obj || typeof obj !== "object") {
    return null;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findVideoData(item, depth + 1, context);
      if (result) {
        return result;
      }
    }
    return null;
  }

  if (obj.play_addr || obj.playAddr || obj.bit_rate || obj.bitRate) {
    const result = buildVideoInfo(obj, context || obj);
    if (result) {
      return result;
    }
  }

  if (obj.video && typeof obj.video === "object") {
    const result = findVideoData(obj.video, depth + 1, obj);
    if (result) {
      result.title = extractTitle(obj, result.title);
      result.cover = result.cover || extractCover(obj.video) || extractCover(obj);
      return result;
    }
  }

  const priorityKeys = [
    "aweme_detail",
    "awemeDetail",
    "detail",
    "item",
    "data",
    "videoData",
    "loaderData",
    "video_detail",
    "videoDetail",
    "item_list",
  ];

  for (const key of priorityKeys) {
    if (obj[key]) {
      const result = findVideoData(obj[key], depth + 1, obj);
      if (result) {
        return result;
      }
    }
  }

  for (const key of Object.keys(obj)) {
    if (priorityKeys.includes(key)) {
      continue;
    }
    const value = obj[key];
    if (value && typeof value === "object") {
      const result = findVideoData(value, depth + 1, obj);
      if (result) {
        return result;
      }
    }
  }

  return null;
}

function tryExtractFromRouterData(html) {
  try {
    const match = html.match(/window\._ROUTER_DATA\s*=\s*({[\s\S]+?})\s*<\/script>/);
    if (!match) {
      return null;
    }
    const payload = JSON.parse(match[1]);
    return findVideoData(payload);
  } catch {
    return null;
  }
}

function tryExtractFromRenderData(html) {
  try {
    const match = html.match(/id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
    if (!match) {
      return null;
    }
    const decoded = decodeURIComponent(match[1]);
    const payload = JSON.parse(decoded);
    return findVideoData(payload);
  } catch {
    return null;
  }
}

function tryExtractFromScriptTags(html) {
  try {
    const scriptMatches = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const scriptContent of scriptMatches) {
      if (!/play_addr|bit_rate|aweme_detail|item_list/i.test(scriptContent)) {
        continue;
      }

      const bodyMatch = scriptContent.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (!bodyMatch) {
        continue;
      }

      const body = bodyMatch[1].trim();
      const candidate = body.match(/=\s*({[\s\S]+})\s*;?\s*$/) || body.match(/({[\s\S]+})/);
      if (!candidate) {
        continue;
      }

      try {
        const parsed = JSON.parse(candidate[1]);
        const result = findVideoData(parsed);
        if (result) {
          return result;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function tryFetchFromApi(videoId) {
  try {
    const apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`;
    const response = await axios.get(apiUrl, {
      headers: {
        "User-Agent": MOBILE_UA,
        Referer: "https://www.douyin.com/",
      },
      timeout: 10000,
      proxy: false,
    });

    const item = response.data?.item_list?.[0];
    if (!item) {
      return null;
    }

    const videoUrl = removeWatermark(extractAddressUrl(item.video?.play_addr));
    if (!videoUrl) {
      return null;
    }

    return {
      title: extractTitle(item, "抖音视频"),
      cover: extractCover(item.video || item),
      videoUrl,
      width: Number(item.video?.width || 0),
      height: Number(item.video?.height || 0),
    };
  } catch {
    return null;
  }
}

async function tryFetchFromWebPage(videoId) {
  try {
    const webUrl = `https://www.douyin.com/video/${videoId}`;
    const response = await axios.get(webUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://www.douyin.com/",
        Cookie: "msToken=; ttwid=;",
      },
      timeout: 15000,
      proxy: false,
    });

    const html = typeof response.data === "string" ? response.data : "";
    return (
      tryExtractFromRouterData(html) ||
      tryExtractFromRenderData(html) ||
      tryExtractFromScriptTags(html)
    );
  } catch {
    return null;
  }
}

async function parseDouyinVideo(url) {
  const redirectResponse = await axios.get(url, {
    headers: {
      "User-Agent": MOBILE_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    maxRedirects: 5,
    decompress: true,
    timeout: 15000,
    proxy: false,
  });

  const finalUrl =
    redirectResponse.request?.res?.responseUrl ||
    redirectResponse.request?._redirectable?._currentUrl ||
    url;

  const html = typeof redirectResponse.data === "string" ? redirectResponse.data : "";
  const videoId = extractVideoId(finalUrl);
  const videoInfo =
    tryExtractFromRouterData(html) ||
    tryExtractFromRenderData(html) ||
    tryExtractFromScriptTags(html) ||
    (videoId ? await tryFetchFromApi(videoId) : null) ||
    (videoId ? await tryFetchFromWebPage(videoId) : null);

  if (!videoInfo || !videoInfo.videoUrl) {
    throw new Error("无法从抖音页面中提取视频信息，请稍后重试");
  }

  if (!isAllowedUrl(videoInfo.videoUrl)) {
    throw new Error("解析得到的视频地址不在允许的下载域名范围内");
  }

  return {
    ...videoInfo,
    sourceUrl: finalUrl,
    videoId,
  };
}

function createJobId() {
  return `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function relativePathOrNull(filePath) {
  if (!filePath) {
    return null;
  }
  return path.relative(__dirname, filePath);
}

function parseBridgeStdout(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through and try to recover the final JSON payload.
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning.
    }
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{") {
      continue;
    }
    const candidate = trimmed.slice(index).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning.
    }
  }

  return null;
}

function persistJobMeta(job) {
  const metaPath = path.join(job.runDir, "meta.json");
  const payload = {
    jobId: job.jobId,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    inputText: job.inputText,
    douyinUrl: job.douyinUrl,
    videoInfo: job.videoInfo
      ? {
          title: job.videoInfo.title,
          cover: job.videoInfo.cover,
          sourceUrl: job.videoInfo.sourceUrl,
          videoId: job.videoInfo.videoId,
        }
      : null,
    files: {
      sourceVideo: relativePathOrNull(job.sourceVideoPath),
      txt: relativePathOrNull(job.txtPath),
      srt: relativePathOrNull(job.srtPath),
    },
  };
  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf8");
}

function setJobState(job, status, message, patch = {}) {
  if (!JOB_STATUSES.has(status)) {
    throw new Error(`Unsupported job status: ${status}`);
  }

  Object.assign(job, patch);
  job.status = status;
  job.message = message;
  job.updatedAt = new Date().toISOString();
  persistJobMeta(job);
  console.log(`[${job.jobId}] ${status}: ${message}`);
}

function serializeJob(job) {
  const payload = {
    success: true,
    jobId: job.jobId,
    status: job.status,
    message: job.message,
  };

  if (job.videoInfo) {
    payload.video = {
      title: job.videoInfo.title,
      cover: job.videoInfo.cover,
    };
  }

  if (job.error) {
    payload.error = job.error;
  }

  if (job.result) {
    payload.result = job.result;
  }

  return payload;
}

async function writeVideoToFile(videoUrl, outputPath) {
  if (!isAllowedUrl(videoUrl)) {
    throw new Error("下载地址不在允许的白名单范围内");
  }

  const response = await axios.get(videoUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      Referer: "https://www.douyin.com/",
    },
    responseType: "stream",
    maxRedirects: 5,
    timeout: 120000,
    proxy: false,
  });

  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    response.data.on("error", reject);
    writer.on("error", reject);
    writer.on("finish", resolve);
  });

  const stats = await fsPromises.stat(outputPath);
  if (!stats.size) {
    throw new Error("视频下载失败，未写入有效文件");
  }
}

async function runPythonBridge(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const args = [
      "-u",
      PYTHON_BRIDGE,
      "--input",
      videoPath,
      "--output-dir",
      outputDir,
      "--backend",
      "gradio",
      "--gradio-url",
      QWEN_GRADIO_URL,
    ];

    const child = spawn(PYTHON_BIN, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        QWEN_GRADIO_URL,
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill();
      reject(new Error("Python bridge 执行超时"));
    }, BRIDGE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        const error = new Error(stderr.trim() || stdout.trim() || `Python bridge exited with code ${code}`);
        error.stderr = stderr;
        reject(error);
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error("Python bridge ?????"));
        return;
      }

      const parsed = parseBridgeStdout(trimmed);
      if (parsed) {
        resolve(parsed);
      } else {
        const error = new Error(`Python bridge ???? JSON ??: ${trimmed}`);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function processJob(job) {
  try {
    setJobState(job, "parsing", "正在解析抖音分享链接");
    const videoInfo = await parseDouyinVideo(job.douyinUrl);

    setJobState(job, "downloading", "已解析成功，正在下载源视频", {
      videoInfo,
    });

    const sourceVideoPath = path.join(job.runDir, "source.mp4");
    await writeVideoToFile(videoInfo.videoUrl, sourceVideoPath);

    setJobState(job, "transcribing", "视频下载完成，正在提取文案", {
      sourceVideoPath,
    });

    const bridgeResult = await runPythonBridge(sourceVideoPath, job.runDir);
    const txtPath = bridgeResult.txt_path || path.join(job.runDir, "transcript.txt");
    const srtPath = bridgeResult.srt_path || path.join(job.runDir, "transcript.srt");

    const result = {
      title: videoInfo.title,
      cover: videoInfo.cover,
      transcriptText: String(bridgeResult.text || "").trim(),
      srtText: String(bridgeResult.srt_text || "").trim(),
      downloads: {
        txt: `/api/download/${job.jobId}/txt`,
        srt: `/api/download/${job.jobId}/srt`,
      },
    };

    setJobState(job, "completed", "文案提取完成", {
      txtPath,
      srtPath,
      result,
      error: null,
    });
  } catch (error) {
    const message = normalizeError(error);
    setJobState(job, "failed", message, {
      error: message,
    });
  }
}

async function createJob(inputText, douyinUrl) {
  const jobId = createJobId();
  const runDir = path.join(RUNS_DIR, jobId);
  await fsPromises.mkdir(runDir, { recursive: true });

  const job = {
    jobId,
    status: "queued",
    message: "任务已创建，等待处理",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inputText,
    douyinUrl,
    runDir,
    error: null,
    videoInfo: null,
    sourceVideoPath: null,
    txtPath: null,
    srtPath: null,
    result: null,
  };

  jobs.set(jobId, job);
  persistJobMeta(job);
  processJob(job);
  return job;
}

async function getPythonHealth(force = false) {
  const now = Date.now();
  if (!force && pythonHealthCache.value && pythonHealthCache.expiresAt > now) {
    return pythonHealthCache.value;
  }

  const health = await new Promise((resolve) => {
    let child;

    try {
      child = spawn(PYTHON_BIN, ["-u", PYTHON_BRIDGE, "--health-check"], {
        cwd: __dirname,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONIOENCODING: "utf-8",
          QWEN_GRADIO_URL,
        },
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        available: false,
        pythonBin: PYTHON_BIN,
        error: normalizeError(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        available: false,
        pythonBin: PYTHON_BIN,
        error: normalizeError(error),
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          available: false,
          pythonBin: PYTHON_BIN,
          error: stderr.trim() || stdout.trim() || `bridge exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({
          available: true,
          pythonBin: PYTHON_BIN,
          ...parsed,
        });
      } catch {
        resolve({
          available: false,
          pythonBin: PYTHON_BIN,
          error: "health-check 返回了非 JSON 内容",
        });
      }
    });
  });

  pythonHealthCache = {
    value: health,
    expiresAt: Date.now() + 5000,
  };

  return health;
}

async function getAsrHealth() {
  const requestUrl = `${QWEN_GRADIO_URL.replace(/\/+$/, "")}/gradio_api/info`;
  try {
    const response = await axios.get(requestUrl, {
      timeout: 4000,
      proxy: false,
    });
    return {
      reachable: response.status >= 200 && response.status < 500,
      url: QWEN_GRADIO_URL,
    };
  } catch (error) {
    return {
      reachable: false,
      url: QWEN_GRADIO_URL,
      error: normalizeError(error),
    };
  }
}

async function inspectRuntimeHealth(force = false) {
  const [python, asr] = await Promise.all([getPythonHealth(force), getAsrHealth()]);
  return {
    success: true,
    web: {
      ok: true,
      port: PORT,
    },
    python,
    asr,
  };
}

async function assertRuntimeReady() {
  const health = await inspectRuntimeHealth();
  if (!health.python.available) {
    const error = new Error("Python bridge 不可用，请先检查 Python 环境");
    error.statusCode = 503;
    throw error;
  }
  if (!health.asr.reachable) {
    const error = new Error("Qwen ASR 服务未就绪，请先启动本地 ASR 服务");
    error.statusCode = 503;
    throw error;
  }
}

app.get("/api/health", async (_req, res) => {
  try {
    const health = await inspectRuntimeHealth();
    res.json(health);
  } catch (error) {
    res.status(500).json({
      success: false,
      web: {
        ok: true,
        port: PORT,
      },
      python: {
        available: false,
        pythonBin: PYTHON_BIN,
        error: normalizeError(error),
      },
      asr: {
        reachable: false,
        url: QWEN_GRADIO_URL,
      },
    });
  }
});

app.post("/api/jobs", async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ success: false, error: "请先粘贴抖音分享文本或链接" });
    }

    if (text.length > 2000) {
      return res.status(400).json({ success: false, error: "输入内容过长，请只粘贴分享文本" });
    }

    const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: "请求过于频繁，请稍后再试" });
    }

    const douyinUrl = extractDouyinUrl(text);
    if (!douyinUrl) {
      return res.status(400).json({ success: false, error: "没有识别到有效的抖音分享链接" });
    }

    await assertRuntimeReady();
    const job = await createJob(text, douyinUrl);
    res.json({ success: true, jobId: job.jobId });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: normalizeError(error),
    });
  }
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: "任务不存在或已失效" });
  }
  res.json(serializeJob(job));
});

app.get("/api/download/:jobId/:kind", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: "任务不存在或已失效" });
  }

  const kind = req.params.kind;
  if (!["txt", "srt"].includes(kind)) {
    return res.status(400).json({ success: false, error: "只支持下载 txt 或 srt" });
  }

  const filePath = kind === "txt" ? job.txtPath : job.srtPath;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "目标文件不存在" });
  }

  const baseName = sanitizeFilename(job.videoInfo?.title || "douyin_transcript");
  const fileName = kind === "txt" ? `${baseName}.txt` : `${baseName}.srt`;
  res.download(filePath, fileName);
});

app.listen(PORT, () => {
  console.log(`抖音文案一键提取已启动: http://127.0.0.1:${PORT}`);
  console.log(`Python bridge: ${PYTHON_BRIDGE}`);
  console.log(`Python bin: ${PYTHON_BIN}`);
  console.log(`Qwen ASR: ${QWEN_GRADIO_URL}`);
});

