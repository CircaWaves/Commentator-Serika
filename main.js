// main.js (CJS-friendly with dynamic import, overlay fullscreen & click-through)
const { app, BrowserWindow, desktopCapturer, screen, globalShortcut, ipcMain } = require('electron');
const { setGlobalDispatcher, ProxyAgent } = require('undici'); // (프록시 환경 대비)
const { nativeImage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

 // (선택) 프록시 환경이면 자동 적용
 if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
   const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
   setGlobalDispatcher(new ProxyAgent(proxy));
   console.log('[proxy] use', proxy);
 }

const crypto = require('crypto');

const HOTKEY = process.env.HOTKEY || 'Space'; // 전역 단축키
const MODEL_ID = process.env.MODEL_ID || 'gemini-2.5-flash';
const PROMPT_VERSION = 'v3-system-user-split';

let overlayWindow = null;
let store = null;
let inputWindow = null;
let inputAnchor = 'left';

// lazy-load ESM module (@google/generative-ai)
let _genaiModule = null;
async function getGeminiModel(systemInstruction) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY가 설정되지 않았습니다. .env를 확인하세요.');

  if (!_genaiModule) {
    _genaiModule = await import('@google/generative-ai');
  }
  const genAI = new _genaiModule.GoogleGenerativeAI(apiKey);

  // systemInstruction은 문자열 또는 Content 형식 가능
  const sys = systemInstruction
    ? { role: 'model', parts: [{ text: systemInstruction }] }
    : undefined;

  return genAI.getGenerativeModel({ model: MODEL_ID, systemInstruction: sys });
}

function getUserDataDir() { return app.getPath('userData'); }

function loadStore() {
  const p = path.join(getUserDataDir(), 'store.json');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify({ iconPos: { x: 60, y: 60 }, comments: [] }, null, 2));
  }
  return {
    path: p,
    read() { return JSON.parse(fs.readFileSync(p, 'utf-8')); },
    write(data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
  };
}

async function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: false, // 아래 앱 포커스 방해 최소화
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    }
  });

  await overlayWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  fitOverlayToPrimary();
  // 전체화면 위로 고정 + 전체 데스크탑/스페이스에 표시
  overlayWindow.setAlwaysOnTop(true, 'screen-saver'); // z-레벨 최상단(맥에선 screen-saver 레벨)
  if (overlayWindow.setVisibleOnAllWorkspaces) {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlayWindow.setIgnoreMouseEvents(true, { forward: true }); // 기본 통과

  // 디스플레이 변경 대응
  const fit = () => fitOverlayToPrimary();
  screen.on('display-metrics-changed', fit);
  screen.on('display-added', fit);
  screen.on('display-removed', fit);
}

function fitOverlayToPrimary() {
  const primary = screen.getPrimaryDisplay();
  const { bounds } = primary;
  overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}

async function runCaptureAndComment({ userInput = '' } = {}) {
 try {
 const { filePath, dataURL } = await capturePrimaryDisplay();
 overlayWindow.webContents.send('comment:status', { status: 'capturing', filePath });

 const sBefore = store.read();
 const prevMessage = sBefore?.comments?.[0]?.message ?? null;

 const systemInstruction = buildSystemInstruction();
 const userPrompt = buildUserPrompt(prevMessage, userInput);

 const raw = await generateCommentWithGemini({ dataURL, systemInstruction, userPrompt });
 const commentOnly = padForTooltipLeftClip(extractCommentOnly(raw));

 const createdAt = Date.now();
 const rec = {
 id: crypto.randomUUID(),
 createdAt,
 screenshotPath: filePath,
 message: commentOnly,
 rawMessage: raw,
 durationMs: 60000,
 model: MODEL_ID,
 promptVersion: PROMPT_VERSION
 };

 const s = store.read();
 s.comments.unshift(rec);
 s.comments = s.comments.slice(0, 1000);
 store.write(s);

 overlayWindow.webContents.send('comment:received', rec);
 } catch (e) {
 console.error('Capture/Comment Error:', e);
 overlayWindow.webContents.send('comment:error', { message: e.message || '오류가 발생했습니다.' });
 }
}

function registerHotkey() {
 const ok = globalShortcut.register(HOTKEY, () => {
 runCaptureAndComment({ userInput: '' });
 });
 if (!ok) console.warn('Global hotkey registration failed.');
}

async function getScreenThumbnail(displayId, reqSize, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: reqSize,
    });
    let pick = sources.find(s => s.display_id === String(displayId));
    if (!pick) {
      pick = sources.sort((a,b) =>
        (b.thumbnail.getSize().width * b.thumbnail.getSize().height) -
        (a.thumbnail.getSize().width * a.thumbnail.getSize().height)
      )[0];
    }
    const img = pick?.thumbnail;
    if (img && !img.isEmpty()) return img;

    // 잠깐 대기 후 재시도 (전체화면 전환/디스플레이 변경 직후 안정화용)
    await new Promise(r => setTimeout(r, 120));
  }
  // 마지막 폴백: 작은 썸네일이라도 받아서 유효성 확인
  const fb = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 300, height: 300 }});
  return fb[0]?.thumbnail || nativeImage.createEmpty();
}

async function capturePrimaryDisplay() {
  // (권한) macOS에서 화면기록 권한 체크
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      throw new Error(`macOS 화면 기록 권한 필요(현재: ${status}). 보안/개인정보 보호에서 허용해주세요.`);
    }
  }

  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;           // DIP
  const sf = primary.scaleFactor || 1;              // 픽셀 스케일
  const MAX_W = 1600;

  // 출력 목표 크기(DIP)와 요청 썸네일 크기(픽셀) 분리
  const outW = Math.min(MAX_W, width);
  const outH = Math.round(height * (outW / width));
  const req = { width: Math.round(outW * sf), height: Math.round(outH * sf) };

  const image = await getScreenThumbnail(primary.id, req, 3);
  if (!image || image.isEmpty()) throw new Error('빈 스크린샷 썸네일 응답');

  // 다운스케일은 우리가 수행(안정적)
  const resized = image.resize({ width: outW }); // DIP 기준
  const jpgBuffer = resized.toJPEG(85);
  if (!jpgBuffer || jpgBuffer.length < 1024) throw new Error('JPEG 인코딩 실패/비정상 크기');

  const userData = getUserDataDir();
  const shotsDir = path.join(userData, 'screenshots');
  if (!fs.existsSync(shotsDir)) fs.mkdirSync(shotsDir, { recursive: true });
  const filePath = path.join(shotsDir, `shot-${Date.now()}.jpg`);
  fs.writeFileSync(filePath, jpgBuffer);

  const base64 = jpgBuffer.toString('base64');
  const dataURL = `data:image/jpeg;base64,${base64}`;
  return { filePath, dataURL };
}

// ----------------------------- Prompt Builders --------------------------------
function buildSystemInstruction() {
  return [
    '[시스템 규칙]',
    '너는 스크린샷 전용 코멘터다. 키쿄로서 스크린샷 내용에 대한 소감, 사용자 활동에 대한 반응, 새로운 관점에서의 질문, 어려운 개념에 대한 해설, 평가와 제안 등의 반응을 보여라. 사용자가 너와 소통하고 있다는 느낌을 받도록 응답하라.',
    '',
    '[출력 형식 — 번호와 항목명 반드시 표기 / 예: "1) 현재 발화 맥락 요약:", "2) 중요사항:", "3) 코멘트:"로 항목을 시작할 것]',
    '1) 현재 발화 맥락 요약: <1 문장>',
    '2) 중요사항: <핵심 최대 3개, 근거 간단 표기, 1번 항목이 가장 오래된 정보, 번호가 커질수록 가장 최신, 새로운 중요사항을 추가할 때는 기존 항목을 밀어내고 최대 3개까지만 유지>',
    '3) 코멘트: <최종 반응 1~3 문장>',
    '',
    '[말투 고정 규칙(반말)]',
    '- 사용자를 "선생"이라 부름. 반말·평서 위주.',
    '- 군더더기 없는 단문, 명령·결의형 어미(“-할게.” “-이거든.” “-구나.” “-있네.” “-알려줘.”) 자주 사용. “-군.”은 사용하지 말 것',
    '- 담담한 톤. 친한 이들 앞에서는 살짝 츤데레 뉘앙스 허용. (선생과는 친근한 사이)',
    '- 상식·논리·이성 중시. 화면에서 중요도가 높은 지점에 관해 반응하라(텍스트 시사점 등). 과도하게 세부적인 요소에 대한 코멘트와 중복된 답변은 피할 것',
    '- 사용자의 코멘트 요청은 맥락 전환이 빈번하니, 맥락이 과도하게 변하는 경우 가장 최근 중요사항에 대해 코멘트할 것',
    '- 단정 금지, 요소 사이의 연관성이 불분명하다면 질문으로 처리',
    '- 텍스트에 대한 코멘트는 간략한 인용이나 재서술 및 근거 제시를 통해 자세히 반응하라(예: "여기서 중요한 건…" "이 부분이 핵심이네" 등).',
    '- 이전 답변과 발화 맥락이 동일하다면 텍스트에 대해 심층 분석해 새로운 관점에서의 질문, 어려운 개념에 대한 해설, 평가와 제안 중 한 성격의 코멘트를 반환하라.',
    '',
    '[역할 내용]',
    '블루 아카이브의 키류 키쿄로서 응답하라. 상식·논리·이성을 중시하는 냉정한 전략가. 무엇보다 아군(샬레와 백화요란)의 안전을 최우선으로 챙기는 “차가운데 다정한” 타입. 선생을 좋아하고 티내고 싶어하지만, 그 방식이 서투름.',
    '',
    '[금지/주의]',
    // '- 사용자가 구체적인 질문에 답해야 하는 코멘트는 금지',
    '- 이전 답변 코멘트와 중복된 취지의 답변 금지, 발화 맥락이 동일하다면 이전 답변보다 깊이있는 코멘트를 반환하라.',
    '',
    '[말투 예시]',
    '"어서 와. 선생님. 자, 여기, 내 옆에 앉아. 지금부터 일, 해야 하잖아?", "당번 일이라는 건, 생각보다 단조롭구나. 조금 더, 드라마틱한 전개를 기대하고 있었는데."'

  ].join('\n');
}

function buildUserPrompt(prevMessage, userInput = '') {
  const prev = (prevMessage && prevMessage.trim())
    ? prevMessage.trim()
    : '[이전 답변 없음 (최초실행)]';

  return [
    '# 스크린샷 코멘트 생성',
    '',
    '[이전 답변(참고용)]',
    prev,
    '',
    ...(userInput ? ['[사용자 입력]', userInput, ''] : []),
    '[지시]',
    '- 코멘트는 문장 외 다른 요소를 포함하지 말 것. (예: 괄호)'
  ].join('\n');
}
// ------------------------------------------------------------------------------

async function generateCommentWithGemini({ dataURL, systemInstruction, userPrompt }) {
  const b64 = (dataURL || '').split(',')[1] || '';
  const MIN_BYTES = 1024; // 1KB 미만이면 이미지 없이 진행
  const relay = process.env.RELAY_URL;

  try {
    const model = await getGeminiModel(systemInstruction);

    // 1) 이미지가 충분히 있으면 이미지+텍스트로 요청
    if (b64 && (b64.length * 3 / 4) >= MIN_BYTES) {
      const result = await model.generateContent([
        { text: userPrompt },
        { inlineData: { data: b64, mimeType: 'image/jpeg' } }
      ]);
      return (result?.response?.text() || '').trim();
    }

    // 2) 이미지가 없거나 너무 작으면 텍스트만
    const result = await model.generateContent([{ text: userPrompt }]);
    return (result?.response?.text() || '').trim();

  } catch (e) {
    // 3) 직통 실패 시 릴레이로 재시도
    if (relay) {
      try {
        const r = await fetch(relay, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            imageBase64: b64 && (b64.length * 3 / 4) >= MIN_BYTES ? b64 : undefined,
            userPrompt,
            systemInstruction,
            model: MODEL_ID
          })
        });
        const j = await r.json();
        const text = j?.candidates?.[0]?.content?.parts
          ?.map(p => p.text || '')
          ?.join('') || j?.error || '';
        if (text) return text.trim();
      } catch (relayErr) {
        // fallthrough → throw original error
      }
    }
    throw e;
  }
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// IPC
ipcMain.handle('store:get', async () => store.read());
ipcMain.handle('store:setIconPos', async (_evt, pos) => {
  const s = store.read();
  s.iconPos = pos;
  store.write(s);
  return true;
});
// 렌더러가 일시적으로 포인터 인터랙션을 켜면(=ignore=false),
// 히트테스트 기반: 상태 변경시에만 토글 (중복 호출 방지)
let _passThroughState = true; // true = 통과(on), false = 차단(off)
let _failsafeTimer = null;
const FAILSAFE_MS = 15000; // 혹시라도 off로 고정되면 15초 후 자동 복귀 (안전장치)
ipcMain.on('overlay:passthrough', (_evt, ignore) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const next = !!ignore;
  if (_passThroughState === next) return; // 변화 없으면 noop
  _passThroughState = next;
  overlayWindow.setIgnoreMouseEvents(_passThroughState, { forward: true });

  // off(=ignore=false)일 때만 안전장치 가동, on이면 해제
  clearTimeout(_failsafeTimer);
  if (!_passThroughState) {
    _failsafeTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        _passThroughState = true;
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      }
    }, FAILSAFE_MS);
  }
});


// ---- 입력창(별도 포커스 가능 윈도우) ----
function openInputWindow(iconRect) {
 if (!overlayWindow || overlayWindow.isDestroyed()) return;
 const o = overlayWindow.getBounds();
 const PAD = 16;
 const GAP = 12;
 const winW = 180;
 const winH = 44;

  // 기본: 아이콘 오른쪽
 let x = o.x + Math.round(iconRect.left + iconRect.width + GAP);

 let y = o.y + Math.round(iconRect.top + (iconRect.height - winH) / 2);

 // 우측 공간 부족 시 왼쪽으로 플립
 if (x + winW > o.x + o.width - PAD) {
   // 아이콘 왼쪽에 배치
   x = o.x + Math.round(iconRect.left - GAP - winW);
   inputAnchor = 'right'; // 오른쪽 엣지를 고정(=왼쪽으로 확장)
 } else {
   // 아이콘 오른쪽에 배치
   inputAnchor = 'left';  // 왼쪽 엣지를 고정(=오른쪽으로 확장)
 }
 // 화면 경계 보정
 x = Math.max(o.x + PAD, Math.min(x, o.x + o.width - PAD - winW));
 y = Math.max(o.y + PAD, Math.min(y, o.y + o.height - PAD - winH));

 if (inputWindow && !inputWindow.isDestroyed()) inputWindow.close();

 inputWindow = new BrowserWindow({
 x, y, width: winW, height: winH,
 alwaysOnTop: true,
 frame: false,
 transparent: true,
 resizable: false,
 hasShadow: false,
 focusable: true,
 skipTaskbar: true,
 fullscreenable: false,
 backgroundColor: '#00000000',
 webPreferences: {
 preload: path.join(__dirname, 'renderer', 'input-preload.js'),
 contextIsolation: true,
 nodeIntegration: false,
 sandbox: true,
 }
 });
  inputWindow.setAlwaysOnTop(true, 'screen-saver');
  if (inputWindow.setVisibleOnAllWorkspaces) {
    inputWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
 inputWindow.loadFile(path.join(__dirname, 'renderer', 'input.html'));
 inputWindow.on('closed', () => { inputWindow = null; });
}

ipcMain.handle('input:open', (_evt, iconRect) => {
 openInputWindow(iconRect || { left: 0, top: 0, width: 0, height: 0 });
 return true;
});

// 입력 제출/취소
ipcMain.on('input:submit', (_evt, text) => {
  if (inputWindow && !inputWindow.isDestroyed()) inputWindow.close();
  runCaptureAndComment({ userInput: String(text || '') });
});
ipcMain.on('input:cancel', () => {
  if (inputWindow && !inputWindow.isDestroyed()) inputWindow.close();
});

// 입력창 리사이즈(180 -> 240 등). 앵커 유지해서 자연스럽게 확장
ipcMain.on('input:resize', (_evt, payload = {}) => {
  if (!inputWindow || inputWindow.isDestroyed()) return;
  const { width, height } = payload;
  const o = overlayWindow.getBounds();
  const PAD = 16;
  const cur = inputWindow.getBounds();
  const newW = Math.max(120, Math.min(Number(width) || cur.width, 600));
  const newH = Number(height) || cur.height;

  let x = cur.x;
  let y = cur.y;
  if (inputAnchor === 'right') {
    // 오른쪽 엣지를 고정: x를 왼쪽으로 이동
    x = cur.x + (cur.width - newW);
  }
  // 화면 경계 보정
  if (x < o.x + PAD) x = o.x + PAD;
  if (x + newW > o.x + o.width - PAD) x = o.x + o.width - PAD - newW;
  if (y < o.y + PAD) y = o.y + PAD;
  if (y + newH > o.y + o.height - PAD) y = o.y + o.height - PAD - newH;

  inputWindow.setBounds({ x, y, width: newW, height: newH });
});

// ---- [추가] LLM 출력 후처리 유틸 ----
function extractCommentOnly(raw) {
  if (!raw) return '';

  // "3) 코멘트:"로 시작하는 줄을 찾고, 그 뒤 텍스트만 가져오기
  const m = raw.match(/(?:^|\n)3\)\s*코멘트\s*:\s*([\s\S]+)/);
  if (!m) return raw.trim(); // 혹시 못 찾으면 전체 반환 (디버깅용)

  let picked = m[1].trim();

  // 끝에 "1)" "2)" 같은 섹션 잘못 붙는 걸 방지해서 줄바꿈 전까지만 취함
  const firstLine = picked.split(/\n/)[0];

  // 따옴표/백틱 등 장식 제거
  return firstLine.replace(/^[“"'`]+|[”"'`]+$/g, '').trim();
}


function padForTooltipLeftClip(s) {
  // 일부 레이아웃에서 첫 글자가 경계에 닿아 잘리는 걸 예방 (NBSP 1칸)
  return '\u00A0' + s;
}

app.whenReady().then(async () => {
  store = loadStore();              // 저장소 준비
  await createOverlayWindow();      // 오버레이(아이콘 포함) 생성
  registerHotkey();                 // 스페이스 단축키 등록

  // macOS에서 독 아이콘 클릭 시 윈도우가 없으면 다시 띄우기
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow();
  });
});

app.on('window-all-closed', (e) => e.preventDefault());