"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const readline = require("readline");
const { webcrypto } = require("crypto");
const pending = new Map();
const timers = new Set();
let sequence = 0;
let started = false;
const input = readline.createInterface({ input: process.stdin });
function emit(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function finish(value) {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  emit(value);
  input.close();
  process.stdin.pause();
}
async function main(args) {
  const profile = args.profile || {};
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout(fn, ms, ...values) {
      const timer = setTimeout(() => { timers.delete(timer); fn(...values); }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    setInterval() { return 0; }, clearInterval() {}, queueMicrotask,
    fetch(url, options = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        emit({ kind: "fetch", id, url: String(url), method: options.method || "GET", body: options.body || "" });
      });
    },
    TextEncoder, TextDecoder, URL, URLSearchParams, crypto: webcrypto,
    btoa: value => Buffer.from(String(value), "latin1").toString("base64"),
    atob: value => Buffer.from(String(value), "base64").toString("latin1"),
    __UA__: profile.user_agent || "Mozilla/5.0",
    __CORES__: profile.hardware_concurrency || 8,
    __SDK_URL__: args.sdk_url,
    __SEED_DID_KEY__: "oai-did", __SEED_DID_VAL__: args.device_id,
    __PAGE_URL__: "https://auth.openai.com/log-in",
    __LANGUAGE__: profile.language || "en-US",
    __LANGUAGES__: profile.languages || ["en-US", "en"],
    __TIMEZONE__: profile.timezone || "America/New_York",
    __COOKIE_HEADER__: "",
  };
  const bootstrap = fs.readFileSync(path.join(__dirname, "sentinel_bootstrap.js"), "utf8");
  const sdkSource = fs.readFileSync(args.sdk_file, "utf8") + "\n;globalThis.__sdk = SentinelSDK;";
  const frameUrl = new URL("https://chatgpt.com/backend-api/sentinel/frame.html");
  frameUrl.searchParams.set("sv", args.sdk_url.split("/").slice(-2)[0]);
  const frame = { ...context, __PAGE_URL__: frameUrl.href };
  const parentListeners = [];
  const frameListeners = [];
  const parentWindow = { postMessage(data) {
    queueMicrotask(() => parentListeners.forEach(fn => fn({ data, source: frameWindow, origin: frameUrl.origin })));
  } };
  const frameWindow = { postMessage(data) {
    queueMicrotask(() => frameListeners.forEach(fn => fn({ data, source: parentWindow, origin: "https://auth.openai.com" })));
  } };
  for (const [target, listeners] of [[context, parentListeners], [frame, frameListeners]]) {
    vm.createContext(target);
    vm.runInContext(bootstrap, target, { timeout: 10000 });
    const addListener = target.addEventListener;
    target.addEventListener = (type, fn, ...rest) => {
      if (type === "message") listeners.push(fn);
      else if (addListener) addListener(type, fn, ...rest);
    };
  }
  frame.top = parentWindow;
  frame.parent = parentWindow;
  vm.runInContext(sdkSource, frame, { timeout: 10000 });
  const createElement = context.document.createElement.bind(context.document);
  context.document.createElement = tag => {
    const element = createElement(tag);
    if (String(tag).toLowerCase() === "iframe") {
      element.contentWindow = frameWindow;
      element.addEventListener = (type, fn) => { if (type === "load") queueMicrotask(fn); };
    }
    return element;
  };
  vm.runInContext(sdkSource, context, { timeout: 10000 });
  const sdk = context.__sdk;
  if (!sdk || !["init", "token", "sessionObserverToken"].every(key => typeof sdk[key] === "function")) {
    throw new Error("SDK_PUBLIC_API_INCOMPATIBLE");
  }
  const result = await sdk.init(args.flow);
  if (typeof result === "string" && result) throw new Error("SDK init failed");
  const token = String(await sdk.token(args.flow) || "");
  await new Promise(resolve => context.setTimeout(resolve, 5000));
  const so_token = String(await sdk.sessionObserverToken(args.flow) || "");
  finish({ kind: "result", token, so_token });
}
input.on("line", line => {
  try {
    const data = JSON.parse(line);
    if (!started) {
      started = true;
      main(data).catch(error => finish({ kind: "error", message: String(error.stack || error.message || error) }));
      return;
    }
    const request = pending.get(data.id);
    if (!request) throw new Error("Unknown SDK request ID");
    pending.delete(data.id);
    if (data.error) { request.reject(new Error(data.error)); return; }
    request.resolve({
      status: data.status, ok: data.status >= 200 && data.status < 300,
      headers: { get: key => (data.headers || {})[key.toLowerCase()] || null },
      text: async () => data.body, json: async () => JSON.parse(data.body),
    });
  } catch (error) { finish({ kind: "error", message: String(error.message || error) }); }
});
