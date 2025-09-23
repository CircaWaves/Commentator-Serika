// pack-to-txt.js (v2) — renderer/ 하위가 중첩 위치여도 모두 포함 & 디버그 로그 추가
/* 주요 코드만 묶는 번들러 (allow-list 방식, 경로 세그먼트 매칭) */
"use strict";
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(process.argv[2] || process.cwd());
const outFile = path.resolve(
  process.argv[3] || path.join(rootDir, `${path.basename(rootDir)}-bundle.txt`)
);

// ---- 설정(필요하면 여기만 수정) ----
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".idea", ".vscode",
  "dist", "out", "build", ".turbo", ".next", ".parcel-cache",
  "coverage", "tmp", "temp", "logs", "data"
]);

// 텍스트로 다루지 않을 바이너리 확장자
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".icns",
  ".mp4", ".mov", ".mkv", ".mp3", ".wav", ".ogg", ".pdf", ".zip", ".gz", ".7z", ".tar"
]);

// 포함할 텍스트 확장자(주요 코드/설정 위주)
const TEXT_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".json", ".html", ".css", ".md", ".yml", ".yaml",
  ".txt", ".svg" // ← SVG/텍스트도 필요시 포함
]);

// 파일명/패턴 제외(민감정보/잡파일)
const EXCLUDE_FILE_BASENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "thumbs.db", ".DS_Store"
]);

// 허용 "디렉터리 이름"(allow-list): 경로 **어디에 있든** 이 디렉터리 세그먼트를 포함하면 허용
const ALLOW_DIRS = new Set(["renderer", "src", "scripts"]);

// 허용 단일 파일(루트 상대 또는 패키지 main 포함)
const ALLOW_FILES = new Set([
  normalize("main.js"),
  normalize("preload.js"),
  normalize("preload.mjs"),
  normalize("package.json"),
  normalize("README.md")
]);

// 대용량 텍스트 스킵 임계값(바이트). 환경변수로 조정 가능.
const MAX_FILE_BYTES = Number(process.env.MAX_BUNDLE_FILE_BYTES || 200 * 1024);

// 디버그(스킵 사유 출력)
const DEBUG = process.env.DEBUG_BUNDLE === "1";
// -----------------------------------

function normalize(p) {
  return p.split(path.sep).join("/");
}
function isBinaryExt(p) {
  return BINARY_EXTS.has(path.extname(p).toLowerCase());
}
function isTextExt(p) {
  return TEXT_EXTS.has(path.extname(p).toLowerCase());
}
function isEnvLike(base) {
  // .env, .env.* 모두 제외
  return base === ".env" || base.startsWith(".env.");
}
function shouldSkipDir(name) {
  return EXCLUDE_DIRS.has(name);
}
function debugSkip(rel, reason) {
  if (DEBUG) console.log(`skip: ${normalize(rel)}  — ${reason}`);
}

function loadPkgMainAllow() {
  // package.json의 main이 있으면 허용 파일에 추가
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    if (pkg && pkg.main) {
      ALLOW_FILES.add(normalize(pkg.main));
    }
  } catch {}
}
loadPkgMainAllow();

function isAllowed(rel) {
  const relN = normalize(rel);

  // 1) 단일 허용 파일(루트 상대·또는 패키지 main)
  if (ALLOW_FILES.has(relN)) return true;

  // 2) 허용 디렉터리 세그먼트가 경로 어딘가에 포함되어 있으면 허용
  //    (예: a/b/renderer/index.html, packages/app/src/main.ts 등)
  const segs = relN.split("/");
  for (let i = 0; i < segs.length - 1; i++) { // 마지막은 파일명이므로 -1
    if (ALLOW_DIRS.has(segs[i])) return true;
  }

  return false;
}

function* walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (DEBUG) console.warn(`readDir error: ${dir} — ${e.message}`);
    return;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(rootDir, full);
    if (!rel || rel.startsWith("..")) continue; // 루트 밖 무시
    const base = ent.name;

    if (ent.isDirectory()) {
      if (shouldSkipDir(base)) continue;
      // 하위 전체를 걷되, 파일 단계에서 필터링
      yield* walk(full);
    } else if (ent.isFile()) {
      if (isBinaryExt(full)) { debugSkip(rel, "binary"); continue; }
      if (!isTextExt(full))  { debugSkip(rel, "non-text-ext"); continue; }
      if (EXCLUDE_FILE_BASENAMES.has(base)) { debugSkip(rel, "excluded-name"); continue; }
      if (isEnvLike(base)) { debugSkip(rel, "env-like"); continue; }
      if (!isAllowed(rel)) { debugSkip(rel, "not-allowed"); continue; }

      yield { full, rel };
    }
  }
}

function headerLine(txt = "", char = "=") {
  const width = 80;
  const mid = ` ${txt} `;
  if (!txt) return char.repeat(width);
  const side = Math.max(0, Math.floor((width - mid.length) / 2));
  return char.repeat(side) + mid + char.repeat(Math.max(0, width - side - mid.length));
}

function main() {
  const now = new Date().toISOString();
  const files = Array.from(walk(rootDir))
    .sort((a, b) => normalize(a.rel).localeCompare(normalize(b.rel)));

  // 대용량 텍스트 스킵
  const filtered = files.filter(f => {
    try {
      const st = fs.statSync(f.full);
      if (st.size <= MAX_FILE_BYTES) return true;
      debugSkip(f.rel, `too-large(${st.size}B)`);
      return false;
    } catch (e) {
      debugSkip(f.rel, `stat-error: ${e.message}`);
      return false;
    }
  });

  fs.writeFileSync(outFile, "", "utf8");
  fs.appendFileSync(
    outFile,
    `${headerLine()}
# PROJECT BUNDLE
Root: ${rootDir}
Generated: ${now}
Files: ${filtered.length}
${headerLine()}\n\n`,
    "utf8"
  );

  for (const f of filtered) {
    let content;
    try { content = fs.readFileSync(f.full, "utf8"); }
    catch (e) { debugSkip(f.rel, `read-error: ${e.message}`); continue; }

    const size = Buffer.byteLength(content, "utf8");
    const rel = normalize(f.rel);

    fs.appendFileSync(
      outFile,
      `${headerLine(`FILE: ${rel}`, "=")}\n(size: ${size} bytes)\n\n${content}\n\n`,
      "utf8"
    );
  }

  fs.appendFileSync(outFile, `${headerLine("END OF BUNDLE", "=")}\n`, "utf8");
  console.log(`✅ Done: ${outFile}`);
}

main();
