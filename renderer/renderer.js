
// renderer.js (overlay click-through control + accurate tooltip position)
const iconEl = document.getElementById('icon');
const tooltipEl = document.getElementById('tooltip');
const tooltipTextEl = document.getElementById('tooltip-text');
const spinnerEl = document.getElementById('spinner');

const TTL_MS = 60000; // 1분
let hideTimer = null;
const EDGE = 16;
let skipNextClick = false;
let dragStartX = 0, dragStartY = 0, movedWhileDrag = false;

function clamp(v, min, max){ return Math.min(Math.max(v, min), max); }

// 초기 위치 로딩
(async () => {
  const store = await window.api.getStore();
  const { iconPos } = store;
  setIconPosition(iconPos.x, iconPos.y);    // 화면 크기에 맞춰 자동 보정
  // 보정된 값이 저장값과 다르면 즉시 저장
  const rect = iconEl.getBoundingClientRect();
  if (Math.abs(rect.left - iconPos.x) > 1 || Math.abs(rect.top - iconPos.y) > 1) {
    await window.api.setIconPos({ x: rect.left, y: rect.top });
  }
})();

// 상태/이벤트
window.api.onStatus(({ status }) => {
  if (status === 'capturing') {
    spinnerEl.classList.remove('hidden');
  }
});

window.api.onComment((rec) => {
  spinnerEl.classList.add('hidden');

  // ⬇️ 전체 대신 '코멘트만'
  const commentOnly = extractCommentOnly(rec.message);
  showTooltip(commentOnly); // isHTML 옵션 없이 순수 텍스트로

  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideTooltip(), TTL_MS);
});

window.api.onError((_err) => {
  spinnerEl.classList.add('hidden');
  showTooltip('코멘트 생성 중 오류가 발생했습니다. 다시 시도해주세요.');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideTooltip(), TTL_MS);
});

tooltipEl.addEventListener('click', () => {
  hideTooltip();
  // 툴팁 클릭으로 오버레이만 만진 경우, 입력창 포커스가 안 바뀌어 남아있을 수 있음 → 강제 닫기
  window.api.cancelInput();
});

function showTooltip(content, opts = {}) {
  const { isHTML = false } = opts;
  if (isHTML) {
    tooltipTextEl.innerHTML = content; // content는 내부에서 escape 처리됨
  } else {
    tooltipTextEl.textContent = content;
  }
  tooltipEl.classList.remove('hidden'); // 먼저 보여주고
  positionTooltip();                    // 아이콘 기준으로 정확히 위치
  syncOverlayPassthrough();             // 드래그/툴팁 상태에 맞게 패스스루
}


function hideTooltip() {
  tooltipEl.classList.add('hidden');
  syncOverlayPassthrough();
}

// 드래그
let dragging = false;
let offsetX = 0, offsetY = 0;

iconEl.addEventListener('pointerenter', () => window.api.setOverlayPassthrough(false));
iconEl.addEventListener('pointerleave', () => { if (!dragging) syncOverlayPassthrough(); });

iconEl.addEventListener('pointerdown', (e) => {
  window.api.cancelInput();
  dragging = true;
  iconEl.setPointerCapture(e.pointerId);
  const rect = iconEl.getBoundingClientRect();
  offsetX = e.clientX - rect.left;
  offsetY = e.clientY - rect.top;
  dragStartX = e.clientX; dragStartY = e.clientY; movedWhileDrag = false;
  syncOverlayPassthrough();
});

iconEl.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  if (!movedWhileDrag && (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3)) {
  movedWhileDrag = true;
  }
  const x = e.clientX - offsetX;
  const y = e.clientY - offsetY;
  setIconPosition(x, y);
});

iconEl.addEventListener('pointerup', async (e) => {
  dragging = false;
  iconEl.releasePointerCapture(e.pointerId);
  const rect = iconEl.getBoundingClientRect();
  await window.api.setIconPos({ x: rect.left, y: rect.top });
  if (movedWhileDrag) skipNextClick = true; // 드래그한 경우 다음 click 무시
  syncOverlayPassthrough();
});

iconEl.addEventListener('click', () => {
 if (skipNextClick) { skipNextClick = false; return; }
 const r = iconEl.getBoundingClientRect();
 window.api.openInputAt({ left: r.left, top: r.top, width: r.width, height: r.height });
});

function setIconPosition(x, y) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = iconEl.offsetWidth || parseInt(getComputedStyle(iconEl).width) || 48;
  const h = iconEl.offsetHeight || parseInt(getComputedStyle(iconEl).height) || 48;
  if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 60; y = 60; }
  x = clamp(x, 8, vw - w - 8);
  y = clamp(y, 8, vh - h - 8);
  iconEl.style.left = `${x}px`;
  iconEl.style.top  = `${y}px`;

  // ⬇️ 툴팁이 보이는 동안에는 아이콘과 함께 붙어서 이동
  if (isTooltipVisible()) positionTooltip();
 }
 
// --- 툴팁 위치/상태 유틸 ---
function isTooltipVisible() {
  return !tooltipEl.classList.contains('hidden');
}

function positionTooltip() {
  // 아이콘 중앙 정렬, 기본은 위쪽 12px 간격. 위쪽 공간이 부족하면 아래로 플립.
  const i = iconEl.getBoundingClientRect();
  const t = tooltipEl.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let left = i.left + i.width / 2 - t.width / 2;
  left = clamp(left, EDGE, vw - t.width - EDGE);

  let top = i.top - 12 - t.height;
  let placement = 'top';
  if (top < EDGE) {
    top = i.bottom + 12;
    placement = 'bottom';
  }
  top = clamp(top, EDGE, vh - t.height - EDGE);

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top  = `${top}px`;
  tooltipEl.dataset.placement = placement;
}

function syncOverlayPassthrough() {
  // 드래그 중이거나 툴팁이 보이면 오버레이가 마우스를 '받도록'(패스스루 OFF)
  const needInteract = dragging || isTooltipVisible();
}


// --- parsing helpers ---
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function extractCommentOnly(raw){
 // NBSP(\u00A0)는 남기고 일반 공백만 트림
 const text = String(raw ?? '')
   .replace(/\r\n?/g, '\n')
   .replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ''); // NBSP 제외

  // 1순위: 기존 파서를 통과해 3) 코멘트가 있으면 그거만
  const parsed = parseComment(text);
  if (parsed && parsed.comment) return parsed.comment.trim();

  // 2순위: "3) 코멘트/논평/최종 논평:" 블록만 직접 캡처 (마크다운 프리픽스 허용)
  const p3 = '(?:코멘트|논평|최종\\s*논평)';
  const rx = new RegExp(
    `(?:^|\\n)[\\s>*#-]*3\\s*[\\).]\\s*(?:${p3})\\s*[:：]?\\s*([\\s\\S]*)$`,
    'i'
  );
  const m = text.match(rx);
  if (m) return m[1].trim();

  // 3순위: 라벨 없이 숫자만 있을 때 3) 이후 전부
  const rx2 = /(?:^|\n)[\s>*#-]*3\s*[\).][^\n]*\n([\s\S]*)$/i;
  const m2 = text.match(rx2);
  if (m2) return m2[1].trim();

  // 4순위: 마지막 문단을 코멘트로 간주
  const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (paras.length) return paras[paras.length - 1];

  return text;
}


function sectionRegex(num, labelPattern) {
  // 라벨 앞에 인용/헤딩/리스트/볼드 같은 마크다운 프리픽스 허용
  return new RegExp(
    `(?:^|\\n)[\\s>*#-]*${num}\\s*[\\).]\\s*(?:${labelPattern})\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n[\\s>*#-]*${num+1}\\s*[\\).]|$)`,
    'i'
  );
}

function splitHighlights(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let items = [];
  for (const l of lines) {
    if (/^(?:[-*•·∙]|(\d+[\.\)]))\s+/.test(l)) items.push(l.replace(/^(?:[-*•·∙]|\d+[\.\)])\s+/, ''));
  }
  if (items.length === 0) {
    // 불릿 마커가 없다면 문장 단위로 최대 4개로 쪼갬
    const rough = text.split(/[\n;•·∙]|(?<=\.)\s+/).map(s => s.trim()).filter(Boolean);
    items = rough.slice(0, 4);
  }
  return items.slice(0, 6); // 너무 길면 컷
}

function parseComment(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();

  // 라벨 패턴(시스템 프롬프트와 동의어 약간 허용)
  const p1 = '(?:현재\\s*대화?맥락\\s*요약|대화?맥락\\s*요약|요약)';
  const p2 = '(?:코멘트\\s*중요사항|중요\\s*사항|핵심|포인트|중요포인트)';
  const p3 = '(?:코멘트|논평|최종\\s*논평)';

  const m1 = text.match(sectionRegex(1, p1));
  const m2 = text.match(sectionRegex(2, p2));
  const m3 = text.match(sectionRegex(3, p3));

  if (m1 && m2 && m3) {
    return {
      ok: true,
      summary: m1[1].trim(),
      highlights: splitHighlights(m2[1]),
      comment: m3[1].trim(),
      raw: text
    };
  }

  // 폴백: 1)/2)/3) 숫자 구분만 의존
  const parts = text.split(/\n\s*(?=\d\s*[\).]\s*)/g);
  if (parts.length >= 2) {
    const body = parts.join('\n');
    const a = body.match(sectionRegex(1, '.+?'));
    const b = body.match(sectionRegex(2, '.+?'));
    const c = body.match(sectionRegex(3, '.+?'));
    if (a || b || c) {
      return {
        ok: true,
        summary: a ? a[1].trim() : '',
        highlights: b ? splitHighlights(b[1]) : [],
        comment: c ? c[1].trim() : '',
        raw: text
      };
    }
  }

  // 최종 폴백: 첫 문단/불릿/나머지
  const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const first = paras[0] || text.split('\n')[0] || text;
  const rest = text.slice(first.length).trim();
  return {
    ok: false,
    summary: first,
    highlights: splitHighlights(rest),
    comment: rest,
    raw: text
  };
}

function renderParsedComment(parsed) {
  const sum = escapeHTML(parsed.summary || '');
  const bullets = (parsed.highlights || []).map(li => `<li>${escapeHTML(li)}</li>`).join('');
  const com = escapeHTML(parsed.comment || '');

  return `
    <div class="sect">
      <div class="sect-title">1) 현재 대화맥락 요약</div>
      <div class="sect-body">${sum || '—'}</div>
    </div>
    <div class="sect">
      <div class="sect-title">2) 코멘트 중요사항</div>
      ${bullets ? `<ul class="bullets">${bullets}</ul>` : '<div class="sect-body">—</div>'}
    </div>
    <div class="sect">
      <div class="sect-title">3) 코멘트</div>
      <div class="sect-body">${com || '—'}</div>
    </div>
  `.trim();
}
