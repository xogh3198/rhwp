/**
 * 원본 오픈소스 대비 이력/비교 확장 (상세)
 *
 * [배경]
 * - 기존 bytes 중심 비교는 파일을 다시 로드하는 순간 문단 정체성(stable_id)이 끊겨
 *   `sharedStableIdCount=0`으로 떨어지고, alignment 의존이 커져 "밀림"이 자주 발생했다.
 *
 * [설계 철학 — 도메인 분리]
 * - 이력(같은 혈통): sid(stable_id)로 문단 정체성을 유지하면 구조·텍스트가 크게 바뀌어도
 *   `identity` 경로에서 O(N)에 가깝게 "이 문단 ↔ 저 문단"을 확정할 수 있다.
 * - 외부 문서 비교(다른 혈통): 두 HWP 간에 공유 sid가 없으므로 `alignment`만 쓴다.
 *   유일하고 긴 문단을 앵커로 "가짜 뼈대"를 세우고, 그 사이 구간을 DP/그리디로 채운다.
 *
 * [설계 철학 — 단계적 비교 (성능·정확도)]
 * - 1단계(구조 뼈대): 앵커로 문서를 큰 구간으로 나눈다. 전 문단×문단 유사도 행렬(O(N²))로
 *   최고 점만 맞추는 방식은 피한다(브라우저 부담 + "1. 개요" 같은 반복 문구 오매칭).
 * - 2단계(구조적 짝짓기): 구간 안에서 순서를 최대한 유지하며 1:1 정렬; "추가 vs 수정"의
 *   대부분은 여기서 결정된다. 유사도는 이 단계에서 DP 치환 비용 하한 등 '가중치' 역할.
 * - 3단계(디테일): 짝이 맞은 문단 쌍에만 문자 단위 요약(`myersCharDiffSummary` 등)을 적용.
 *
 * [설계 철학 — 유사도는 안전망]
 * - 1차 라벨의 주역으로 쓰지 않는다. 정렬(DP) 단계에서는 치환 비용·약매칭 방지 등에만 쓴다.
 *
 * [alignment 파이프라인 요약 — 문서 비교(alignment) 경로]
 * 1) `buildAnchorPairs`: 양쪽에서 시그니처·품질이 유일한 "긴" 문단 쌍만 글로벌 앵커로 고정.
 * 2) 앵커 사이 구간마다 `matchSegment` → (셀 수·시간 한도 내) `matchSegmentDp` 또는 `matchWindowedGreedy`.
 *    - DP: `matchCost` = `getEffectiveSimilarity` + `softSimilarityThresholdForPair` + `MATCH_COST_WEAK`.
 *    - Greedy: `scorePairGreedy` + 윈도 + `minScore` + (1위가 `isNearStructure`면 `ambiguous` 생략).
 * 3) `buildTextDiffs`: 정렬된 `AlignedPair` 스트림을 순회하며 빈문단 승격·쪼개기 라벨·삭제+추가→수정
 *    병합(`shouldMergeRemovedAddedAsModify`) 등 후처리 후 `DiffItem[]` 생성.
 * - `isNearStructure`는 `globalIndex` 차 ≤2라 위쪽 삽입으로 밀리면 false가 되기 쉬움 → 그 경우에도
 *   `(L,null)(null,R)` 연속은 REMOVED_ADDED_* 규칙으로 "텍스트 변경" 승격 가능.
 *
 * [튜닝 상수 읽는 법 — 파일 상단 `// ─── 튜닝 상수` 블록]
 * - 앵커/윈도: WINDOW_SIZE, ANCHOR_*, SEGMENT_DP_MAX, HARD_SEGMENT_CELL_LIMIT, ALIGNMENT_MAX_COMPUTE_MS
 * - 유사도·비용: MATCH_SOFT_SIM_MIN, MATCH_COST_WEAK, NEAR_STRUCTURE_*, textSimilarity 가중(0.2/0.8)
 * - 그리디: NEAR_STRUCTURE_GREEDY_BONUS, GREEDY_AMBIGUOUS_GAP, minScore(함수 내 리터럴 3.45)
 * - 후처리: PARA_SPLIT_JOIN_SIM_MIN, REMOVED_ADDED_* (삭제+추가 병합)
 *
 * [핵심 확장]
 * 1) 입력 경로 이원화
 *    - `buildSnapshotFromBytes`: 외부 파일(bytes) 비교용
 *    - `buildSnapshotFromWasm`: 현재 편집 문서를 IR 스냅샷(JSON)으로 직접 채집
 *      -> 같은 세션 내 이력 비교에서 sid를 보존해 identity 매칭률을 높인다.
 *
 * 2) 전략 명시 선택
 *    - 이력 비교는 `identity`, 문서 비교는 `alignment`를 호출부에서 명시한다.
 *    - identity에 필요한 sid 맵 구성 실패 시에만 alignment로 안전 폴백한다.
 *
 * 3) 컨트롤(표/그림) 매칭 안정화
 *    - 위치 기반 키(`sec:para:idx`) 대신 부모 문단 sid를 포함한 키를 우선 사용한다.
 *      예: `sid:<paraStableId>:<ctrlIdx>:<type>`
 *    - 문단 번호가 밀려도 같은 개체를 같은 개체로 추적하기 위한 변경이다.
 *
 * 4) 렌더/페이지 정보 보강
 *    - 스냅샷 시점에 페이지 표시 번호를 수집해 diff 항목에 좌/우 sectionPage를 주석화한다.
 *    - 컨트롤/메타 항목처럼 문단 직접 매핑이 불안정한 경우 anchor/page 매핑으로 보완한다.
 *
 * 5) 이동 오탐 억제
 *    - 엔터/삽입으로 인한 단순 reflow를 `paragraphMeta moved`로 과검출하지 않도록 후처리한다.
 *
 * [유지보수·리뷰 포인트]
 * - 이 파일은 "비교 품질(정확성) + UI 탐색성(경로/앵커)"를 함께 책임진다.
 * - 비교 품질 이슈를 수정할 때는 `compareSnapshots` 진입 전후 로그(①②③)를 함께 확인해야 한다.
 * - 아키텍처 설명·발표 시에는 위 단계(앵커→정렬→문자)로 브라우저 비용을 어떻게 막는지
 *   시각적으로 보여주는 것이 효과적이다.
 */
import { WasmBridge } from '@/core/wasm-bridge';
import type { DocumentInfo } from '@/core/types';
import { compareDbg, isCompareDebugEnabled } from './compare-debug';
import type {
  CompareAnchorTuning,
  CompareControlSnapshot,
  CompareDocumentSnapshot,
  CompareOptions,
  CompareParaSnapshot,
  ComparePerformanceTuning,
  CompareSession,
  CompareStrategy,
  DiffAnchor,
  DiffItem,
  DiffKind,
} from './types';

// ─── 튜닝 상수 (값 변경 시 대표 문서로 회귀 확인 권장) ─────────────────
// 상호 의존: NEAR_STRUCTURE_* 는 isNearStructure 가 true 일 때만 전부 켜짐.
//           밀린 문단은 isNear 가 false 가 되므로 REMOVED_ADDED_* 가 보완층으로 동작한다.
/** alignment 경로: 오른쪽 문단마다 왼쪽에서 고를 때의 탐색 반경(문단 개수) */
const WINDOW_SIZE = 32;
/** `buildAnchorPairs`: 시그니처가 같아도 너무 짧은 문단은 앵커 후보에서 제외(오탐 앵커 방지) */
const ANCHOR_MIN_TEXT_LEN = 20;
/** 동일 서명 문단 쌍의 globalIndex 차가 이 값보다 크면 "문단 이동" 메타 후보로 본다 */
const MOVE_DISTANCE_THRESHOLD = 3;
/** 정렬이 (null,R앞)(L,R뒤)로 나온 쪼개기만: L≈R앞+R뒤일 때 R앞=변경·R뒤=추가로 재라벨 */
const PARA_SPLIT_JOIN_SIM_MIN = 0.86;
/** 구간 내 DP 직접 적용 최대 한 변 길이 (n*m <= MAX^2) */
const SEGMENT_DP_MAX = 150;
/** DP에서 약한 유사도끼리 붙는 것 방지 (치환 비용 하한으로 del+ins보다 불리하게) */
const MATCH_SOFT_SIM_MIN = 0.7;
/** `matchCost`: 유사도가 너무 낮으면 치환 대신 삽입+삭제 쪽으로 유도하는 비용 상한 */
const MATCH_COST_WEAK = 4;
/** `isNearStructure`이고 문단이 충분히 길 때, `textSimilarity` 결과를 DP/그리디 평가용으로만 끌어올리는 하한 */
const NEAR_STRUCTURE_SIM_BOOST = 0.4;
/** 위 부스트를 받기 위한 최소 raw 유사도(무연관 짧은 문단·우연 일치 완화) */
const NEAR_STRUCTURE_MIN_SIM = 0.12;
/** 구조 근접 시 치환 비용(`1-sim`)에서 깎는 할인 — `getEffectiveSimilarity`와 별개 튜닝 */
const NEAR_STRUCTURE_COST_DISCOUNT = 0.4;
/** 그리디 `scorePairGreedy`: `isNearStructure`일 때 `minScore`(의역·서명 불일치) 통과용 가산 */
const NEAR_STRUCTURE_GREEDY_BONUS = 1.5;
/** 그리디: 1·2위 점수 차가 이 값 미만이면 동률로 보고 매칭 포기(1위가 구조 근접이면 검사 생략) */
const GREEDY_AMBIGUOUS_GAP = 0.35;
/** (L,null)(null,R) 등 삭제+추가로만 남았지만 동일 슬롯 수정으로 승격할 최소 textSimilarity */
const REMOVED_ADDED_MERGE_SIM_MIN = 0.28;
/** 위 승격: 같은 구역에서 허용하는 문단 번호·globalIndex 최대 간격(위쪽 삽입으로 밀린 경우) */
const REMOVED_ADDED_MAX_PARA_GAP = 12;
const REMOVED_ADDED_MAX_GLOBAL_GAP = 24;
/** `myersCharDiffSummary`: 문자 단위 DP를 돌릴 최대 문자열 길이(메모리·시간 상한) */
const MYERS_MAX = 420;
/** 앵커 품질 기본 가드레일: 공백 비율 상한 */
const ANCHOR_MAX_WHITESPACE_RATIO = 0.62;
/** 앵커 품질 기본 가드레일: 최소 고유 문자 수 */
const ANCHOR_MIN_UNIQUE_CHARS = 6;
/** 앵커 품질 기본 가드레일: 최소 엔트로피 */
const ANCHOR_MIN_ENTROPY = 1.9;
/** 브라우저 프리징 방지: 구간 셀 수 하드캡(초과 시 DP 금지) */
const HARD_SEGMENT_CELL_LIMIT = 180_000;
/** 브라우저 프리징 방지: alignment 타임버짓 기본값(ms) */
const ALIGNMENT_MAX_COMPUTE_MS = 2600;

type CompareRuntimeGuard = {
  deadline: number;
  bailedOut: boolean;
};

let activeRuntimeGuard: CompareRuntimeGuard | null = null;

function resolveAnchorTuning(options: CompareOptions): Required<CompareAnchorTuning> {
  return {
    minTextLen: options.anchorTuning?.minTextLen ?? ANCHOR_MIN_TEXT_LEN,
    minUniqueChars: options.anchorTuning?.minUniqueChars ?? ANCHOR_MIN_UNIQUE_CHARS,
    maxWhitespaceRatio: options.anchorTuning?.maxWhitespaceRatio ?? ANCHOR_MAX_WHITESPACE_RATIO,
    minEntropy: options.anchorTuning?.minEntropy ?? ANCHOR_MIN_ENTROPY,
  };
}

function resolvePerformanceTuning(options: CompareOptions): Required<ComparePerformanceTuning> {
  return {
    maxComputeMs: options.performanceTuning?.maxComputeMs ?? ALIGNMENT_MAX_COMPUTE_MS,
    hardSegmentCells: options.performanceTuning?.hardSegmentCells ?? HARD_SEGMENT_CELL_LIMIT,
  };
}

function shannonEntropy(text: string): number {
  if (!text) return 0;
  const freq = new Map<string, number>();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const c of freq.values()) {
    const p = c / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isAnchorTextQualityOk(text: string, tuning: Required<CompareAnchorTuning>): boolean {
  if (text.length < tuning.minTextLen) return false;
  const whitespaceCount = (text.match(/\s/g) ?? []).length;
  if (whitespaceCount / Math.max(1, text.length) > tuning.maxWhitespaceRatio) return false;
  if (new Set(text).size < tuning.minUniqueChars) return false;
  return shannonEntropy(text) >= tuning.minEntropy;
}

function shouldBailToGreedy(): boolean {
  if (!activeRuntimeGuard) return false;
  if (activeRuntimeGuard.bailedOut) return true;
  if (Date.now() <= activeRuntimeGuard.deadline) return false;
  activeRuntimeGuard.bailedOut = true;
  return true;
}

/** 동일 stable_id 문단의 문자 단위 편집 거리·간단 패턴 요약 (2-depth diff) */
function myersCharDiffSummary(left: string, right: string): string {
  const n = left.length;
  const m = right.length;
  if (n === 0 && m === 0) return '';
  if (n * m > MYERS_MAX * MYERS_MAX) {
    return `문자 diff 생략(과대: ${n}×${m})`;
  }
  // 편집 거리(Levenshtein) 테이블: dp[i][j] = left[0..i), right[0..j) 정렬 비용
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const eq = left.charCodeAt(i - 1) === right.charCodeAt(j - 1) ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + eq);
    }
  }
  let i = n;
  let j = m;
  const ops: string[] = [];
  // 역추적: 삭제(-) / 삽입(+) / 치환(×) / 일치(=) — UI용 짧은 패턴 문자열로 압축
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left.charCodeAt(i - 1) === right.charCodeAt(j - 1)) {
      ops.push('=');
      i -= 1;
      j -= 1;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push('-');
      i -= 1;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      ops.push('+');
      j -= 1;
    } else if (i > 0 && j > 0) {
      ops.push('×');
      i -= 1;
      j -= 1;
    } else if (i > 0) {
      ops.push('-');
      i -= 1;
    } else {
      ops.push('+');
      j -= 1;
    }
  }
  ops.reverse();
  const pat = ops.join('').replace(/=+/g, '·').slice(0, 100);
  return `편집거리 ${dp[n][m]} · ${pat}`;
}

/** 비교 옵션에 따른 문단 텍스트 정규화(공백 무시·대소문자) */
function normalizeText(text: string, options: CompareOptions): string {
  const base = options.ignoreWhitespace ? text.replace(/\s+/g, ' ').trim() : text;
  return options.caseSensitive ? base : base.toLowerCase();
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function simpleHashBytes(bytes: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** DiffItem.id — kind와 고유 키를 합쳐 UI/로그에서 항목을 식별 */
function mkDiffId(kind: DiffKind, key: string): string {
  return `${kind}:${key}`;
}

function mapControlKind(type: string, summary: string): DiffKind {
  if (type === 'table') return 'table';
  if (type === 'image') return 'image';
  if (type === 'shape' || type === 'group') {
    if (summary.toLowerCase().includes('chart')) return 'chart';
    return 'shape';
  }
  if (summary.toLowerCase().includes('chart')) return 'chart';
  return 'paragraphMeta';
}

function canonicalControlKey(c: CompareControlSnapshot): string {
  const m = c.key.match(/^(sid:[^:]+:\d+|loc:-?\d+:-?\d+:\d+):[^:]+$/);
  if (!m) return `${c.kind}::${c.key}`;
  const stem = m[1];
  // 요소별 변경 추적 안정화:
  // - 동일 anchor(control index)인데 type만 group/shape로 달라지는 중복을 하나로 합친다.
  // - 매칭 단계에서는 canonical key를 기준으로 "같은 개체"를 판정한다.
  if (c.kind === 'shape' || c.kind === 'chart') return `${c.kind}::${stem}:shape`;
  if (c.kind === 'table') return `${c.kind}::${stem}:table`;
  return `${c.kind}::${stem}:image`;
}

function controlSnapshotQuality(c: CompareControlSnapshot): number {
  let score = 0;
  // 요소별 변경 추적 품질 점수:
  // - 텍스트/픽셀해시/유효 bbox가 있는 스냅샷을 우선 채택해
  //   동일 key 중 더 "정보가 풍부한" 항목을 남긴다.  
  if (c.summary.includes('text="') && !c.summary.includes('text="(없음)"')) score += 4;
  if (!c.summary.includes('pix=nopix')) score += 2;
  if (!c.summary.includes('nobox')) score += 1;
  if (c.type === 'shape') score += 1; // group보다 shape 상세값이 많은 편
  return score;
}

function kindLabel(kind: DiffKind): string {
  if (kind === 'table') return '표';
  if (kind === 'shape') return '도형';
  if (kind === 'image') return '이미지';
  if (kind === 'chart') return '그래프';
  if (kind === 'text') return '텍스트';
  return '메타';
}

/**
 * 표 셀 텍스트·속성을 요약한 짧은 문자열 — 컨트롤 diff에서 "같은 표인지" 판별용.
 * WASM에 `getTableSignature`가 있으면 그걸 우선(정확·빠름), 없으면 셀 순회 폴백.
 */
function buildTableSummary(
  wasm: WasmBridge,
  options: CompareOptions,
  sec: number,
  para: number,
  ci: number,
): string {
  let sigDigest = 'nosig';
  try {
    const sigJson = wasm.getTableSignature(sec, para, ci);
    sigDigest = simpleHash(sigJson);
  } catch {
    // 신/구 WASM 호환: 시그니처 API가 없으면 기존 JS 조합 경로 사용
  }

  const dim = wasm.getTableDimensions(sec, para, ci);
  const cellCount = Math.max(0, dim.rowCount * dim.colCount);
  const cellSnippets: string[] = [];
  const cellPreviewPairs: string[] = [];
  const cellHashPairs: string[] = [];
  for (let cellIdx = 0; cellIdx < cellCount; cellIdx += 1) {
    let paraCount = 0;
    try {
      paraCount = wasm.getCellParagraphCount(sec, para, ci, cellIdx);
    } catch {
      paraCount = 0;
    }
    const paraTexts: string[] = [];
    for (let cpi = 0; cpi < paraCount; cpi += 1) {
      try {
        const plen = wasm.getCellParagraphLength(sec, para, ci, cellIdx, cpi);
        const t = plen > 0 ? wasm.getTextInCell(sec, para, ci, cellIdx, cpi, 0, plen) : '';
        if (t) paraTexts.push(normalizeText(t, options));
      } catch {
        // 일부 셀 접근 실패 시 해당 문단만 스킵
      }
    }
    const joined = paraTexts.join('|');
    cellSnippets.push(joined);
    if (joined && cellPreviewPairs.length < 240) {
      // 요소별 변경 추적(표 텍스트):
      // - cprev: UI 표시용(사람이 읽는 셀 미리보기)
      // - csha : 긴 문장/여러 줄에서 잘림이 있어도 변경 감지를 유지하기 위한 셀 단위 해시
      const compact = joined
        .replaceAll('"', "'")
        .replaceAll('\r\n', '\n')
        .replaceAll('\n', ' ↵ ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 180);
      const row = dim.colCount > 0 ? Math.floor(cellIdx / dim.colCount) + 1 : 1;
      const col = dim.colCount > 0 ? (cellIdx % dim.colCount) + 1 : (cellIdx + 1);
      const key = `r${row}c${col}`;
      cellPreviewPairs.push(`${key}=${encodeURIComponent(compact)}`);
      cellHashPairs.push(`${key}=${simpleHash(joined)}`);
    }
  }
  const textDigest = simpleHash(cellSnippets.join('||'));
  const textPreview = cellSnippets
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s.replaceAll('"', "'").replace(/\s+/g, ' ').trim())
    .join(' | ')
    .slice(0, 80);
  let propsDigest = '';
  try {
    const props = wasm.getTableProperties(sec, para, ci);
    propsDigest = simpleHash(JSON.stringify(props));
  } catch {
    propsDigest = 'noprops';
  }
  let bboxDigest = 'nobox';
  try {
    const bbox = wasm.getTableBBox(sec, para, ci);
    bboxDigest = `${Math.round(bbox.width)}x${Math.round(bbox.height)}`;
  } catch {
    bboxDigest = 'nobox';
  }
  const cellPreview = cellPreviewPairs.join('&');
  const cellHash = cellHashPairs.join('&');
  return `table r=${dim.rowCount} c=${dim.colCount} tprev="${textPreview || '(없음)'}" cprev="${cellPreview || '(없음)'}" csha="${cellHash || '(없음)'}" txt=${textDigest} props=${propsDigest} box=${bboxDigest} sig=${sigDigest}`;
}

function extractControlIndexFromKey(key: string): number | null {
  const m = key.match(/:(\d+):[^:]+$/);
  if (!m) return null;
  return Number.isFinite(Number(m[1])) ? Number(m[1]) : null;
}

function parseSummaryKV(summary: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of summary.matchAll(/([a-z]+)=("([^"]*)"|[^\s]+)/g)) {
    const raw = m[2] ?? '';
    out[m[1]] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

function countChangedCellsByHash(leftHash: string, rightHash: string): number {
  const parse = (v: string): Map<string, string> => {
    const out = new Map<string, string>();
    if (!v || v === '(없음)') return out;
    for (const pair of v.split('&')) {
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const key = pair.slice(0, i);
      const value = pair.slice(i + 1);
      out.set(key, value);
    }
    return out;
  };
  const l = parse(leftHash);
  const r = parse(rightHash);
  const keys = new Set<string>([...l.keys(), ...r.keys()]);
  let changed = 0;
  for (const k of keys) {
    if ((l.get(k) ?? '') !== (r.get(k) ?? '')) changed += 1;
  }
  return changed;
}

function buildGranularControlDiffs(
  l: CompareControlSnapshot,
  r: CompareControlSnapshot,
  idStem: string,
): DiffItem[] {
  const lk = parseSummaryKV(l.summary);
  const rk = parseSummaryKV(r.summary);
  const items: DiffItem[] = [];
  const label = kindLabel(l.kind);
  const push = (suffix: string, title: string, leftPreview: string, rightPreview: string, force = false) => {
    if (!force && leftPreview === rightPreview) return;
    items.push({
      id: mkDiffId(l.kind, `${idStem}:${suffix}`),
      kind: l.kind,
      severity: 'modified',
      path: { section: r.section, paragraph: r.paragraph, controlKey: r.key },
      title,
      leftPreview,
      rightPreview,
      leftAnchor: l.anchor,
      rightAnchor: r.anchor,
    });
  };

  if (l.type === 'table' && r.type === 'table') {
    const hasCellText =
      (lk.cprev && lk.cprev !== '(없음)') ||
      (rk.cprev && rk.cprev !== '(없음)') ||
      (lk.tprev && lk.tprev !== '(없음)') ||
      (rk.tprev && rk.tprev !== '(없음)');
    const tableLabel = hasCellText ? '표' : '테이블';
    const rowsColsChanged = (lk.r ?? '') !== (rk.r ?? '') || (lk.c ?? '') !== (rk.c ?? '');
    push('rows-cols', `${tableLabel} 행/열 변경`, `r=${lk.r ?? '(없음)'} c=${lk.c ?? '(없음)'}`, `r=${rk.r ?? '(없음)'} c=${rk.c ?? '(없음)'}`);
    push('size', `${tableLabel} 크기 변경`, `box=${lk.box ?? '(없음)'}`, `box=${rk.box ?? '(없음)'}`);
    // UI의 행/열별 셀 비교는 cprev(r1c1=...&r1c2=...) 포맷을 기준으로 동작한다.
    // cprev가 없을 때만 tprev로 폴백한다.
    const lText = `cprev="${lk.cprev ?? lk.tprev ?? '(없음)'}"`;
    const rText = `cprev="${rk.cprev ?? rk.tprev ?? '(없음)'}"`;
    const tableTextChanged = (lk.txt ?? '') !== (rk.txt ?? '') || lText !== rText;
    const changedCells = countChangedCellsByHash(lk.csha ?? '', rk.csha ?? '');
    const textTitle = rowsColsChanged
      ? `${tableLabel} 텍스트 변경(구조변경 동반${changedCells > 0 ? `, ${changedCells}셀` : ''})`
      : `${tableLabel} 텍스트 변경${changedCells > 0 ? `(${changedCells}셀)` : ''}`;
    push('text', textTitle, lText, rText, tableTextChanged);
    push('style', `${tableLabel} 속성 변경`, `props=${lk.props ?? '(없음)'}`, `props=${rk.props ?? '(없음)'}`);
    return items;
  }

  if (l.type === 'image' && r.type === 'image') {
    push('size', '그림 크기 변경', `box=${lk.box ?? '(없음)'}`, `box=${rk.box ?? '(없음)'}`);
    const imageTextChanged = (lk.text ?? '') !== (rk.text ?? '') || ((lk.pix ?? '') !== (rk.pix ?? '') && (lk.text ?? '') === (rk.text ?? ''));
    push('text', '그림 텍스트 변경', `text="${lk.text ?? '(없음)'}" pix=${lk.pix ?? '(없음)'}`, `text="${rk.text ?? '(없음)'}" pix=${rk.pix ?? '(없음)'}`, imageTextChanged);
    push('crop', '그림 자르기 변경', `crop=${lk.crop ?? '(없음)'}`, `crop=${rk.crop ?? '(없음)'}`);
    push('effect', '그림 효과 변경', `effect=${lk.effect ?? '(없음)'} bc=${lk.bc ?? '(없음)'}`, `effect=${rk.effect ?? '(없음)'} bc=${rk.bc ?? '(없음)'}`);
    return items;
  }

  if ((l.type === 'shape' || l.type === 'group') && (r.type === 'shape' || r.type === 'group')) {
    push('size', `${label} 크기 변경`, `box=${lk.box ?? '(없음)'}`, `box=${rk.box ?? '(없음)'}`);
    const shapeTextChanged = (lk.text ?? '') !== (rk.text ?? '') || ((lk.pix ?? '') !== (rk.pix ?? '') && (lk.text ?? '') === (rk.text ?? ''));
    push('text', `${label} 텍스트 변경`, `text="${lk.text ?? '(없음)'}" pix=${lk.pix ?? '(없음)'}`, `text="${rk.text ?? '(없음)'}" pix=${rk.pix ?? '(없음)'}`, shapeTextChanged);
    push('rotate', `${label} 회전/대칭 변경`, `rot=${lk.rot ?? '(없음)'} flip=${lk.flip ?? '(없음)'}`, `rot=${rk.rot ?? '(없음)'} flip=${rk.flip ?? '(없음)'}`);
    push('layout', `${label} 배치 변경`, `wrap=${lk.wrap ?? '(없음)'} rel=${lk.rel ?? '(없음)'}`, `wrap=${rk.wrap ?? '(없음)'} rel=${rk.rel ?? '(없음)'}`);
    return items;
  }

  push('generic', `${label} 속성 변경`, l.summary, r.summary);
  return items;
}

/**
 * WASM이 열린 단일 문서에서 비교용 스냅샷을 만든다.
 * - 문단: 텍스트, 정규화 텍스트, stable_id, 레이아웃 앵커(커서 rect 기반), 구역 내 쪽번호
 * - 개체: 페이지 레이아웃 + 문단별 table 순회를 합쳐 키를 `sid:` 우선으로 통일
 */
function fillSnapshotFromWasm(
  wasm: WasmBridge,
  info: DocumentInfo,
  displayName: string,
  options: CompareOptions,
): CompareDocumentSnapshot {
  // 비교 스냅샷 직전에 강제 재조판하여 폰트/도형 반영 지연으로 인한 페이지 밀림을 줄인다.
  wasm.refreshLayout();

  const displayedPageByGlobalPage = new Map<number, number>();
  for (let page = 0; page < info.pageCount; page += 1) {
    try {
      const pi = wasm.getPageInfo(page);
      displayedPageByGlobalPage.set(page, pi.pageNumber ?? (page + 1));
    } catch {
      // page info 조회 실패 시 후속 fallback 사용
    }
  }

  const paragraphs: CompareParaSnapshot[] = [];
  let globalIndex = 0;
  for (let sec = 0; sec < info.sectionCount; sec += 1) {
    const paraCount = wasm.getParagraphCount(sec);
    for (let para = 0; para < paraCount; para += 1) {
      const length = wasm.getParagraphLength(sec, para);
      const text = length > 0 ? wasm.getTextRange(sec, para, 0, length) : '';
      const controls = wasm.getControlTextPositions(sec, para);
      const normalizedText = normalizeText(text, options);
      // 문단 "내용+컨트롤 개수" 지문 — alignment에서 앵커/유일쌍 찾기에 사용
      const signature = simpleHash(`${normalizedText}|cc:${controls.length}`);
      const stableId = wasm.getParagraphStableId(sec, para);
      const anchor = (() => {
        try {
          const rect = wasm.getCursorRect(sec, para, 0);
          return {
            pageIndex: rect.pageIndex,
            x: rect.x,
            y: rect.y,
            // 문단 시작 위치 기준 넓은 박스: UI 하이라이트·hitTest에 쓰기 위함(정밀 bbox는 아님)
            width: 320,
            height: Math.max(18, rect.height || 18),
          };
        } catch {
          return undefined;
        }
      })();
      const sectionPage = (() => {
        if (!anchor) return 1;
        return displayedPageByGlobalPage.get(anchor.pageIndex) ?? (anchor.pageIndex + 1);
      })();
      paragraphs.push({
        section: sec,
        paragraph: para,
        sectionPage,
        globalIndex,
        stableId,
        text,
        normalizedText,
        controlCount: controls.length,
        signature,
        isAnchorCandidate: false,
        anchor,
      });
      globalIndex += 1;
    }
  }

  // 앵커 오염 방지: 너무 짧거나 중복 텍스트(개요/빈 문단)는 앵커 후보에서 제외.
  const anchorTuning = resolveAnchorTuning(options);
  const sigCount = new Map<string, number>();
  for (const p of paragraphs) {
    sigCount.set(p.signature, (sigCount.get(p.signature) ?? 0) + 1);
  }
  for (const p of paragraphs) {
    const hasLowQualityText = !isAnchorTextQualityOk(p.normalizedText, anchorTuning);
    const isDuplicate = (sigCount.get(p.signature) ?? 0) > 1;
    p.isAnchorCandidate = !hasLowQualityText && !isDuplicate;
  }
  const paraStableByPos = new Map<string, string>();
  const paraTextByPos = new Map<string, string>();
  for (const p of paragraphs) {
    paraStableByPos.set(`${p.section}:${p.paragraph}`, p.stableId);
    paraTextByPos.set(`${p.section}:${p.paragraph}`, p.normalizedText.slice(0, 48));
  }

  const controls: CompareControlSnapshot[] = [];
  const shapeDebugRows: Array<{
    source: 'layout' | 'direct';
    sec: number;
    para: number;
    ci: number;
    type: string;
    shapeTextLen: number;
    usedDescription: boolean;
    usedParaFallback: boolean;
    hasPix: boolean;
  }> = [];
  for (let page = 0; page < info.pageCount; page += 1) {
    const layout = wasm.getPageControlLayout(page);
    for (const item of layout.controls) {
      const sec = item.secIdx ?? -1;
      const para = item.paraIdx ?? -1;
      const ci = item.controlIdx ?? -1;
      const paraStableId = sec >= 0 && para >= 0 ? paraStableByPos.get(`${sec}:${para}`) : undefined;
      const key = paraStableId
        ? `sid:${paraStableId}:${ci}:${item.type}`
        : `loc:${sec}:${para}:${ci}:${item.type}`;
      let summary = `${item.type} ${Math.round(item.w)}x${Math.round(item.h)}`;

      try {
        if (item.type === 'table' && sec >= 0 && para >= 0 && ci >= 0) {
          summary = buildTableSummary(wasm, options, sec, para, ci);
        } else if (item.type === 'image' && sec >= 0 && para >= 0 && ci >= 0) {
          const pic = wasm.getPictureProperties(sec, para, ci);
          const w = Math.round(pic.width);
          const h = Math.round(pic.height);
          const crop = [pic.cropLeft, pic.cropTop, pic.cropRight, pic.cropBottom].map((v) => Math.round(v)).join(',');
          const effect = `${pic.effect}:${pic.rotationAngle ?? 0}`;
          const bc = `${pic.brightness ?? 0}/${pic.contrast ?? 0}`;
          const paraText = paraTextByPos.get(`${sec}:${para}`) ?? '';
          const desc = ((pic.description ?? '').trim() || paraText).replaceAll('"', "'").slice(0, 48);
          let pix = 'nopix';
          try {
            const raw = wasm.getControlImageData(sec, para, ci);
            pix = simpleHashBytes(raw);
          } catch {
            pix = 'nopix';
          }
          summary = `image box=${w}x${h} crop=${crop} effect=${effect} bc=${bc} text="${desc || '(없음)'}" pix=${pix}`;
        } else if ((item.type === 'shape' || item.type === 'group') && sec >= 0 && para >= 0 && ci >= 0) {
          const props = wasm.getShapeProperties(sec, para, ci);
          const box = `${Math.round(props.width)}x${Math.round(props.height)}`;
          const rot = Math.round(props.rotationAngle ?? 0);
          const flip = `${props.horzFlip ? 1 : 0}${props.vertFlip ? 1 : 0}`;
          const wrap = props.textWrap ?? 'none';
          const rel = `${props.horzRelTo ?? '-'}:${props.vertRelTo ?? '-'}`;
          const paraText = paraTextByPos.get(`${sec}:${para}`) ?? '';
          let shapeText = '';
          try {
            const st = wasm.getShapeText(sec, para, ci);
            if (st.ok && st.text) shapeText = st.text;
          } catch {
            shapeText = '';
          }
          const desc = (shapeText.trim() || (props.description ?? '').trim() || paraText).replaceAll('"', "'").slice(0, 120);
          const usedDescription = !shapeText.trim() && Boolean((props.description ?? '').trim());
          const usedParaFallback = !shapeText.trim() && !(props.description ?? '').trim() && Boolean(paraText.trim());
          let pix = 'nopix';
          try {
            const raw = wasm.getControlImageData(sec, para, ci);
            pix = simpleHashBytes(raw);
          } catch {
            pix = 'nopix';
          }
          summary = `shape box=${box} rot=${rot} flip=${flip} wrap=${wrap} rel=${rel} text="${desc || '(없음)'}" pix=${pix}`;
          shapeDebugRows.push({
            source: 'layout',
            sec,
            para,
            ci,
            type: item.type,
            shapeTextLen: shapeText.trim().length,
            usedDescription,
            usedParaFallback,
            hasPix: pix !== 'nopix',
          });
        }
      } catch {
        // 일부 개체 타입은 속성 조회 API가 제한될 수 있다.
      }

      controls.push({
        key,
        type: item.type,
        section: sec,
        paragraph: para,
        summary,
        kind: mapControlKind(item.type, summary),
        anchor: {
          pageIndex: page,
          x: item.x,
          y: item.y,
          width: Math.max(12, item.w),
          height: Math.max(12, item.h),
        },
      });
    }
  }

  // RTMS 계열에서 유효했던 방식과 동일한 취지:
  // 페이지 레이아웃 매핑(item.secIdx/paraIdx)에만 의존하지 말고,
  // 문단의 컨트롤 인덱스를 직접 순회하며 table/shape/image를 식별/요약한다.
  for (const p of paragraphs) {
    const controlCount = wasm.getControlTextPositions(p.section, p.paragraph).length;
    for (let ci = 0; ci < controlCount; ci += 1) {
      try {
        const summary = buildTableSummary(wasm, options, p.section, p.paragraph, ci);
        const key = p.stableId
          ? `sid:${p.stableId}:${ci}:table`
          : `loc:${p.section}:${p.paragraph}:${ci}:table`;
        let anchor = p.anchor ?? { pageIndex: 0, x: 0, y: 0, width: 12, height: 12 };
        try {
          const bbox = wasm.getTableBBox(p.section, p.paragraph, ci);
          anchor = {
            pageIndex: bbox.pageIndex,
            x: bbox.x,
            y: bbox.y,
            width: Math.max(12, bbox.width),
            height: Math.max(12, bbox.height),
          };
        } catch {
          // bbox 조회 실패 시 문단 anchor 유지
        }
        controls.push({
          key,
          type: 'table',
          section: p.section,
          paragraph: p.paragraph,
          summary,
          kind: 'table',
          anchor,
        });
      } catch {
        // getTableDimensions 실패 => table이 아닌 컨트롤
      }

      // 요소별 변경 추적 정책(도형/그림):
      // - shape/image는 layout 경로만 사용해 오매핑을 최소화한다.
      // - direct 경로는 table 전용으로 제한한다.
    }
  }

  const uniqueControls = new Map<string, CompareControlSnapshot>();
  for (const c of controls) {
    const ck = canonicalControlKey(c);
    const prev = uniqueControls.get(ck);
    if (!prev) {
      uniqueControls.set(ck, c);
      continue;
    }
    // 같은 개체로 판정되면 더 품질 높은 스냅샷으로 교체
    if (controlSnapshotQuality(c) > controlSnapshotQuality(prev)) {
      uniqueControls.set(ck, c);
    }
  }

  if (isCompareDebugEnabled()) {
    const rows = shapeDebugRows;
    const bySource = {
      layout: rows.filter((r) => r.source === 'layout').length,
      direct: rows.filter((r) => r.source === 'direct').length,
    };
    const withShapeText = rows.filter((r) => r.shapeTextLen > 0).length;
    const withDescription = rows.filter((r) => r.usedDescription).length;
    const withParaFallback = rows.filter((r) => r.usedParaFallback).length;
    const withPix = rows.filter((r) => r.hasPix).length;
    compareDbg('[shape-text-debug] 수집 요약', {
      total: rows.length,
      bySource,
      withShapeText,
      withDescription,
      withParaFallback,
      withPix,
    });
    compareDbg(
      '[shape-text-debug] 샘플(최대 20)',
      rows.slice(0, 20).map((r) => ({
        src: r.source,
        sec: r.sec,
        para: r.para,
        ci: r.ci,
        type: r.type,
        shapeTextLen: r.shapeTextLen,
        desc: r.usedDescription,
        paraFallback: r.usedParaFallback,
        pix: r.hasPix,
      })),
    );
    compareDbg(
      '[shape-text-debug] 미추출 대상(shapeTextLen=0)',
      rows
        .filter((r) => r.shapeTextLen === 0)
        .map((r) => ({
          src: r.source,
          sec: r.sec,
          para: r.para,
          ci: r.ci,
          type: r.type,
          desc: r.usedDescription,
          paraFallback: r.usedParaFallback,
          pix: r.hasPix,
        })),
    );
  }

  return {
    meta: {
      name: displayName,
      sectionCount: info.sectionCount,
      pageCount: info.pageCount,
      pageDisplayNumbers: Array.from({ length: info.pageCount }, (_, pageIndex) =>
        displayedPageByGlobalPage.get(pageIndex) ?? (pageIndex + 1),
      ),
    },
    paragraphs,
    controls: [...uniqueControls.values()],
  };
}

/** 디스크/외부 바이트 → 별도 WASM 인스턴스로 파싱 (stable_id는 이 인스턴스 세션 기준) */
export async function buildSnapshotFromBytes(
  bytes: Uint8Array,
  fileName: string,
  options: CompareOptions,
): Promise<CompareDocumentSnapshot> {
  const wasm = new WasmBridge();
  await wasm.initialize();
  const info = wasm.loadDocument(bytes, fileName);
  return fillSnapshotFromWasm(wasm, info, fileName, options);
}

/** 편집기에 올라온 문서 그대로 스냅샷 — 이력 비교 시 stable_id 유지 */
export function buildSnapshotFromWasm(
  wasm: WasmBridge,
  displayName: string,
  options: CompareOptions,
): CompareDocumentSnapshot {
  const info = wasm.getDocumentInfo();
  return fillSnapshotFromWasm(wasm, info, displayName, options);
}

/** IR `stable_id` → 스냅샷 (문서 내 유일할 때만) */
function buildStableIdMap(snap: CompareDocumentSnapshot): Map<string, CompareParaSnapshot> | null {
  const m = new Map<string, CompareParaSnapshot>();
  const seen = new Map<string, number>();
  for (const p of snap.paragraphs) {
    if (!p.stableId) return null;
    // fallback stable_id가 중복되는 문서(빈 문단 다수 등)도 identity를 사용하기 위해
    // 등장 순서 기반 suffix로 키를 정규화한다.
    const occ = seen.get(p.stableId) ?? 0;
    seen.set(p.stableId, occ + 1);
    const key = occ === 0 ? p.stableId : `${p.stableId}#${occ}`;
    m.set(key, p);
  }
  return m;
}

/**
 * identity 텍스트 비교: stable_id 정규화 키로 좌/우 문단을 1:1 매칭.
 * - 양쪽 중 한쪽에만 있으면 added/removed
 * - 둘 다 있으면 normalizedText 불일치 시 modified + 문자 요약
 * - kinds에 paragraphMeta가 있으면 이동/컨트롤 수 변화도 별도 항목으로 낸다
 */
function buildIdentityTextDiffs(left: CompareDocumentSnapshot, right: CompareDocumentSnapshot, kinds: DiffKind[]): DiffItem[] {
  const lmap = buildStableIdMap(left);
  const rmap = buildStableIdMap(right);
  if (!lmap || !rmap) return [];

  // 양쪽 Map의 key(stableId)를 합집합으로 만든다.
  // -> 어떤 id든 최소 1회는 순회되므로 "한쪽만 존재(추가/삭제)"도 놓치지 않는다.
  const keys = [...new Set([...lmap.keys(), ...rmap.keys()])];
  keys.sort((a, b) => {
    const la = lmap.get(a);
    const lb = lmap.get(b);
    const ra = rmap.get(a);
    const rb = rmap.get(b);
    const sa = la?.section ?? ra?.section ?? 0;
    const sb = lb?.section ?? rb?.section ?? 0;
    if (sa !== sb) return sa - sb;
    const pa = la?.paragraph ?? ra?.paragraph ?? 0;
    const pb = lb?.paragraph ?? rb?.paragraph ?? 0;
    return pa - pb;
  });

  const diffs: DiffItem[] = [];
  for (const id of keys) {
    // 동일 id를 좌/우 Map에서 각각 조회:
    // - l만 있으면: 기준 문서에는 있었는데 비교 문서에는 없음 => removed
    // - r만 있으면: 비교 문서에 새로 생김 => added
    // - 둘 다 있으면: 내용(normalizedText) 비교로 modified 여부 판단
    // 조회 자체는 Map#get 이라 평균 O(1), 전체는 key 개수에 비례해 O(N)으로 동작한다.
    const l = lmap.get(id);
    const r = rmap.get(id);
    if (l && !r) {
      diffs.push({
        id: mkDiffId('text', `id-removed:${id}`),
        kind: 'text',
        severity: 'removed',
        path: { section: l.section, paragraph: l.paragraph },
        title: '문단 삭제',
        leftPreview: l.text,
        rightPreview: '',
        leftAnchor: l.anchor,
      });
      continue;
    }
    if (!l && r) {
      diffs.push({
        id: mkDiffId('text', `id-added:${id}`),
        kind: 'text',
        severity: 'added',
        path: { section: r.section, paragraph: r.paragraph },
        title: '문단 추가',
        leftPreview: '',
        rightPreview: r.text,
        rightAnchor: r.anchor,
      });
      continue;
    }
    if (!l || !r) continue;

    if (l.normalizedText !== r.normalizedText) {
      diffs.push({
        id: mkDiffId('text', `id-modified:${id}`),
        kind: 'text',
        severity: 'modified',
        path: preferRightPath(l, r),
        title: '텍스트 변경',
        leftPreview: l.text,
        rightPreview: r.text,
        leftAnchor: l.anchor,
        rightAnchor: r.anchor,
        inlineTextDiff: myersCharDiffSummary(l.text, r.text),
      });
    }

    if (
      kinds.includes('paragraphMeta') &&
      l.signature === r.signature &&
      Math.abs(l.globalIndex - r.globalIndex) > MOVE_DISTANCE_THRESHOLD
    ) {
      diffs.push({
        id: mkDiffId('paragraphMeta', `id-moved:${id}`),
        kind: 'paragraphMeta',
        severity: 'modified',
        path: preferRightPath(l, r),
        title: '문단 순서 이동',
        leftPreview: `A idx=${l.globalIndex}`,
        rightPreview: `B idx=${r.globalIndex}`,
        leftAnchor: l.anchor,
        rightAnchor: r.anchor,
      });
    }

    if (kinds.includes('paragraphMeta') && l.controlCount !== r.controlCount) {
      diffs.push({
        id: mkDiffId('paragraphMeta', `id-ctrlcount:${id}`),
        kind: 'paragraphMeta',
        severity: 'modified',
        path: preferRightPath(l, r),
        title: '문단 개체 수 변경',
        leftPreview: `controls=${l.controlCount}`,
        rightPreview: `controls=${r.controlCount}`,
        leftAnchor: l.anchor,
        rightAnchor: r.anchor,
      });
    }
  }
  return diffs;
}

/** 호출부에서 지정한 strategy를 적용(단, identity 맵 구성 실패 시 alignment 폴백). */
function resolveTextCompareStrategy(
  strategy: CompareStrategy,
  left: CompareDocumentSnapshot,
  right: CompareDocumentSnapshot,
): 'identity' | 'alignment' {
  const canId = Boolean(buildStableIdMap(left) && buildStableIdMap(right));
  if (strategy === 'identity') return canId ? 'identity' : 'alignment';
  return 'alignment';
}

/** suppressPureReflowMoves가 걸러낼 "문단 순서 이동"류 diff 식별 */
function isParagraphMoveMeta(diff: DiffItem): boolean {
  return diff.kind === 'paragraphMeta' && (diff.id.includes('moved:') || diff.id.includes('id-moved:'));
}

/**
 * 삽입/삭제로 globalIndex만 밀린 것과 "진짜 순서 바뀜"을 구분해 moved 노이즈를 제거한다.
 * (공유 sid의 상대 순서가 유지되고, 밀림량이 앞쪽 순수 추가/삭제 개수와 일치하면 제외)
 */
function suppressPureReflowMoves(
  diffs: DiffItem[],
  left: CompareDocumentSnapshot,
  right: CompareDocumentSnapshot,
): DiffItem[] {
  const lmap = buildStableIdMap(left);
  const rmap = buildStableIdMap(right);
  if (!lmap || !rmap) return diffs;

  const sharedLeftIds = left.paragraphs.map((p) => p.stableId).filter((id) => id && rmap.has(id));
  const sharedRightIds = right.paragraphs.map((p) => p.stableId).filter((id) => id && lmap.has(id));
  const rankLeft = new Map<string, number>();
  const rankRight = new Map<string, number>();
  sharedLeftIds.forEach((id, i) => rankLeft.set(id, i));
  sharedRightIds.forEach((id, i) => rankRight.set(id, i));

  const rightOnlyPrefixCount: number[] = Array(right.paragraphs.length + 1).fill(0);
  for (let i = 0; i < right.paragraphs.length; i += 1) {
    rightOnlyPrefixCount[i + 1] = rightOnlyPrefixCount[i] + (lmap.has(right.paragraphs[i].stableId) ? 0 : 1);
  }
  const leftOnlyPrefixCount: number[] = Array(left.paragraphs.length + 1).fill(0);
  for (let i = 0; i < left.paragraphs.length; i += 1) {
    leftOnlyPrefixCount[i + 1] = leftOnlyPrefixCount[i] + (rmap.has(left.paragraphs[i].stableId) ? 0 : 1);
  }

  return diffs.filter((d) => {
    if (!isParagraphMoveMeta(d)) return true;
    let l: CompareParaSnapshot | undefined;
    let r: CompareParaSnapshot | undefined;

    // identity 경로: id는 "paragraphMeta:id-moved:<stableId>"
    const sid = d.id.includes('id-moved:') ? d.id.split('id-moved:')[1] : '';
    if (sid) {
      l = lmap.get(sid);
      r = rmap.get(sid);
    } else {
      // alignment 경로: path가 좌측 기준으로 내려오는 moved:<sec>:<para>
      l = left.paragraphs.find((p) => p.section === d.path.section && p.paragraph === d.path.paragraph);
      r = l ? rmap.get(l.stableId) : undefined;
    }
    if (!l || !r) return true;

    const delta = r.globalIndex - l.globalIndex;
    if (delta === 0) return false;

    const sameRelativeOrder = rankLeft.get(l.stableId) === rankRight.get(l.stableId);
    if (!sameRelativeOrder) return true;

    if (delta > 0) {
      const addedBefore = rightOnlyPrefixCount[r.globalIndex];
      if (delta === addedBefore) return false;
    } else {
      const removedBefore = leftOnlyPrefixCount[l.globalIndex];
      if (-delta === removedBefore) return false;
    }
    return true;
  });
}

type AlignedPair = {
  left: CompareParaSnapshot | null;
  right: CompareParaSnapshot | null;
};

type ControlPair = {
  left: CompareControlSnapshot;
  right: CompareControlSnapshot;
};

function preferRightPath(
  left: { section: number; paragraph: number } | null,
  right: { section: number; paragraph: number } | null,
): { section: number; paragraph: number } {
  if (right) return { section: right.section, paragraph: right.paragraph };
  if (left) return { section: left.section, paragraph: left.paragraph };
  return { section: 0, paragraph: 0 };
}

/**
 * 한 쌍의 문단 배열 안에서만 시그니처 빈도를 세어, 양쪽 모두 유일한 문단끼리 단조 증가 쌍만 잡는다.
 * 전역 앵커가 없을 때 큰 구간을 쪼개 DP/그리디가 밀리지 않게 한다.
 */
function buildUniqueSigPairsInSlices(
  leftSeg: CompareParaSnapshot[],
  rightSeg: CompareParaSnapshot[],
  minTextLen: number,
): Array<{ li: number; ri: number }> {
  const countL = new Map<string, number>();
  const countR = new Map<string, number>();
  for (const p of leftSeg) countL.set(p.signature, (countL.get(p.signature) ?? 0) + 1);
  for (const p of rightSeg) countR.set(p.signature, (countR.get(p.signature) ?? 0) + 1);

  const rightBySig = new Map<string, number[]>();
  for (let ri = 0; ri < rightSeg.length; ri += 1) {
    const p = rightSeg[ri];
    if ((countR.get(p.signature) ?? 0) !== 1) continue;
    if (p.normalizedText.length < minTextLen) continue;
    if (!rightBySig.has(p.signature)) rightBySig.set(p.signature, []);
    rightBySig.get(p.signature)!.push(ri);
  }

  const pairs: Array<{ li: number; ri: number }> = [];
  let lastRi = -1;
  for (let li = 0; li < leftSeg.length; li += 1) {
    const lp = leftSeg[li];
    if ((countL.get(lp.signature) ?? 0) !== 1) continue;
    if (lp.normalizedText.length < minTextLen) continue;
    const candidates = rightBySig.get(lp.signature);
    if (!candidates || candidates.length !== 1) continue;
    const ri = candidates[0];
    if (ri <= lastRi) continue;
    pairs.push({ li, ri });
    lastRi = ri;
  }
  return pairs;
}

/** 전역 문단 배열에서 "길고 유일한" 동일 시그니처 쌍을 단조 ri로 잡아 alignment 구간 경계를 만든다 */
function buildAnchorPairs(left: CompareParaSnapshot[], right: CompareParaSnapshot[]): Array<{ li: number; ri: number }> {
  const rightBySig = new Map<string, number[]>();
  for (let i = 0; i < right.length; i += 1) {
    const p = right[i];
    if (!p.isAnchorCandidate) continue;
    if (!rightBySig.has(p.signature)) rightBySig.set(p.signature, []);
    rightBySig.get(p.signature)!.push(i);
  }

  const pairs: Array<{ li: number; ri: number }> = [];
  let lastRi = -1;
  for (let li = 0; li < left.length; li += 1) {
    const lp = left[li];
    if (!lp.isAnchorCandidate) continue;
    const candidates = rightBySig.get(lp.signature);
    if (!candidates || candidates.length !== 1) continue; // 앵커 오염 방지: 단일 매치만 앵커로 인정
    const ri = candidates[0];
    if (ri <= lastRi) continue;
    pairs.push({ li, ri });
    lastRi = ri;
  }
  return pairs;
}

// ─── 문단 정렬: 유사도·구조·비용 (DP / 그리디 공통) ─────────────────────────────
// textSimilarity: 스냅샷의 normalizedText 기준. 정렬 외 컨트롤 폴백 등에서도 호출될 수 있음.
// isNearStructure / getEffectiveSimilarity / matchCost / scorePairGreedy 는 문단 쌍 정렬 전용.

function charBigramSimilarity(a: string, b: string): number {
  const aa = Array.from(a);
  const bb = Array.from(b);
  if (aa.length < 2 || bb.length < 2) return 0;
  const gramsA = new Set<string>();
  const gramsB = new Set<string>();
  for (let i = 0; i < aa.length - 1; i += 1) gramsA.add(`${aa[i]}${aa[i + 1]}`);
  for (let i = 0; i < bb.length - 1; i += 1) gramsB.add(`${bb[i]}${bb[i + 1]}`);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let inter = 0;
  for (const g of gramsA) if (gramsB.has(g)) inter += 1;
  return (2 * inter) / (gramsA.size + gramsB.size);
}

/** 토큰+문자 바이그램 혼합 유사도 — 조사/접미 숫자 등 한국어 미세 변경에 둔감하게 매칭 */
function textSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const sa = new Set(a.split(/\s+/).filter(Boolean));
  const sb = new Set(b.split(/\s+/).filter(Boolean));
  const tokenSim =
    sa.size === 0 || sb.size === 0
      ? 0
      : (() => {
          let inter = 0;
          for (const t of sa) if (sb.has(t)) inter += 1;
          return (2 * inter) / (sa.size + sb.size);
        })();

  // 문자 유사도는 공백 변형 영향을 줄이기 위해 공백 제거본으로 계산한다.
  const aNoWs = a.replace(/\s+/g, '');
  const bNoWs = b.replace(/\s+/g, '');
  const charSim = charBigramSimilarity(aNoWs, bNoWs);

  // 한쪽이 다른 쪽을 거의 포함하면(예: "맛있다" -> "맛있다2") 동일 문단 가능성이 높다.
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const containsBoost = shorter.length >= 4 && longer.includes(shorter) ? 0.96 : 0;

  // 문단 정렬: 한국어는 조사·어미만 바뀌어도 공백 토큰이 크게 달라지므로 바이그램 쪽 비중을 둔다.
  const mixed = tokenSim * 0.2 + charSim * 0.8;
  return Math.max(mixed, containsBoost);
}

/**
 * 구역·문단 번호·globalIndex·컨트롤 수가 "같은 슬롯의 이웃"으로 볼 만한 쌍.
 * - globalIndex 는 문서 전체 순서라, 위쪽 삽입만으로도 좌·우 동일 문단이 ±3 이상 벌어질 수 있음
 *   → 이 경우 getEffectiveSimilarity 부스트·그리디 가산이 꺼지고, REMOVED_ADDED_* 병합이 다음 방어선.
 */
function isNearStructure(lp: CompareParaSnapshot, rp: CompareParaSnapshot): boolean {
  return (
    lp.section === rp.section &&
    Math.abs(lp.paragraph - rp.paragraph) <= 1 &&
    Math.abs(lp.globalIndex - rp.globalIndex) <= 2 &&
    lp.controlCount === rp.controlCount
  );
}

/** 공백 제거 기준 양쪽 문단이 충분히 길 때만 임계/부스트 완화(짧은 문단 노이즈 억제) */
function isNearStructureLongPair(lp: CompareParaSnapshot, rp: CompareParaSnapshot): boolean {
  const lenL = lp.normalizedText.replace(/\s+/g, '').length;
  const lenR = rp.normalizedText.replace(/\s+/g, '').length;
  return lenL > 15 && lenR > 15;
}

/**
 * textSimilarity 통과 하한: 전역은 엄격, 구조 근접 시만 완화(짧은 문단은 우연 일치 억제).
 * `textSimilarity` 자체는 수정하지 않고, DP/그리디의 `matchCost`·`scorePairGreedy`에서만 사용한다.
 */
function softSimilarityThresholdForPair(lp: CompareParaSnapshot, rp: CompareParaSnapshot): number {
  if (!isNearStructure(lp, rp)) return MATCH_SOFT_SIM_MIN;
  return isNearStructureLongPair(lp, rp) ? 0.25 : 0.45;
}

/**
 * DP/그리디 평가 전용 유사도. `textSimilarity`는 순수 값으로 두고, 구조 근접·긴 문단일 때만 보정한다.
 */
function getEffectiveSimilarity(lp: CompareParaSnapshot, rp: CompareParaSnapshot): number {
  const rawSim = textSimilarity(lp.normalizedText, rp.normalizedText);
  if (!isNearStructure(lp, rp)) return rawSim;
  if (!isNearStructureLongPair(lp, rp)) return rawSim;
  if (rawSim > NEAR_STRUCTURE_MIN_SIM) {
    return Math.max(rawSim, NEAR_STRUCTURE_SIM_BOOST);
  }
  return rawSim;
}

/** 매칭 비용: 낮을수록 좋음 (0 = 완전 일치). 서명 불일치 + 낮은 유사도는 치환 경로를 막아 이웃 문단 오매칭을 줄인다. */
function matchCost(lp: CompareParaSnapshot, rp: CompareParaSnapshot): number {
  if (lp.signature === rp.signature) return 0;
  const sim = getEffectiveSimilarity(lp, rp);
  const threshold = softSimilarityThresholdForPair(lp, rp);
  if (sim < threshold) return MATCH_COST_WEAK;
  let c = 1 - sim;
  if (lp.controlCount !== rp.controlCount) c += 0.35;
  if (isNearStructure(lp, rp)) c = Math.max(0, c - NEAR_STRUCTURE_COST_DISCOUNT);
  return c;
}

/** 구간 내부 유일 시그니처 앵커로 쪼개 각 조각에 matchSegment 재귀 */
function matchSegmentWithInternalAnchors(leftSeg: CompareParaSnapshot[], rightSeg: CompareParaSnapshot[]): AlignedPair[] {
  const intra = buildUniqueSigPairsInSlices(leftSeg, rightSeg, 10);
  if (intra.length === 0) return [];

  const boundaries = [{ li: -1, ri: -1 }, ...intra, { li: leftSeg.length, ri: rightSeg.length }];
  const out: AlignedPair[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    if (a.li >= 0 && a.ri >= 0) {
      out.push({ left: leftSeg[a.li], right: rightSeg[a.ri] });
    }
    const ls = leftSeg.slice(a.li + 1, b.li);
    const rs = rightSeg.slice(a.ri + 1, b.ri);
    if (ls.length === 0 && rs.length === 0) continue;
    out.push(...matchSegment(ls, rs));
  }
  return out;
}

/**
 * 앵커 사이 구간: (1) 구간 내 유일 시그니처로 분할 (2) 작은 조각은 DP (3) 크면 그리디.
 */
function matchSegment(leftSeg: CompareParaSnapshot[], rightSeg: CompareParaSnapshot[]): AlignedPair[] {
  const n = leftSeg.length;
  const m = rightSeg.length;
  const perf = resolvePerformanceTuning(activeCompareOptions ?? DEFAULT_COMPARE_OPTIONS);
  if (n === 0 && m === 0) return [];
  if (n === 0) return rightSeg.map((rp) => ({ left: null, right: rp }));
  if (m === 0) return leftSeg.map((lp) => ({ left: lp, right: null }));
  if (shouldBailToGreedy()) return matchWindowedGreedy(leftSeg, rightSeg);

  if (n * m > SEGMENT_DP_MAX * SEGMENT_DP_MAX || n * m > perf.hardSegmentCells) {
    // 큰 구간: 먼저 내부 유일 시그니처로 쪼개서 DP 폭발 방지
    const stitched = matchSegmentWithInternalAnchors(leftSeg, rightSeg);
    if (stitched.length > 0) return stitched;
  } else {
    const intra = buildUniqueSigPairsInSlices(leftSeg, rightSeg, 10);
    if (intra.length > 0 && (n > 48 || m > 48)) {
      return matchSegmentWithInternalAnchors(leftSeg, rightSeg);
    }
  }

  if (n * m <= SEGMENT_DP_MAX * SEGMENT_DP_MAX && n * m <= perf.hardSegmentCells) {
    return matchSegmentDp(leftSeg, rightSeg);
  }
  // 매우 큰 조각: 윈도 그리디(정확도는 DP보다 낮지만 O(n·m) 완화)
  return matchWindowedGreedy(leftSeg, rightSeg);
}

/**
 * dp[i][j] = 왼쪽 i개·오른쪽 j개 문단까지 정렬 최소 비용.
 * 백트래킹 시 동률이면 match > delete > insert 우선(시각적 밀림 완화).
 */
function matchSegmentDp(leftSeg: CompareParaSnapshot[], rightSeg: CompareParaSnapshot[]): AlignedPair[] {
  if (shouldBailToGreedy()) return matchWindowedGreedy(leftSeg, rightSeg);
  const n = leftSeg.length;
  const m = rightSeg.length;
  const inf = 1e9;
  const del = 1.05;
  const ins = 1.05;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(inf));
  dp[0][0] = 0;
  for (let i = 1; i <= n; i += 1) dp[i][0] = dp[i - 1][0] + del;
  for (let j = 1; j <= m; j += 1) dp[0][j] = dp[0][j - 1] + ins;

  for (let i = 1; i <= n; i += 1) {
    if (i % 12 === 0 && shouldBailToGreedy()) return matchWindowedGreedy(leftSeg, rightSeg);
    for (let j = 1; j <= m; j += 1) {
      const mc = matchCost(leftSeg[i - 1], rightSeg[j - 1]);
      dp[i][j] = Math.min(dp[i - 1][j - 1] + mc, dp[i - 1][j] + del, dp[i][j - 1] + ins);
    }
  }

  const eps = 1e-5;
  const out: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const candMatch =
      i > 0 && j > 0
        ? dp[i - 1][j - 1] + matchCost(leftSeg[i - 1], rightSeg[j - 1])
        : inf;
    const candDel = i > 0 ? dp[i - 1][j] + del : inf;
    const candIns = j > 0 ? dp[i][j - 1] + ins : inf;
    const target = dp[i][j];
    if (i > 0 && j > 0 && Math.abs(candMatch - target) < eps) {
      out.push({ left: leftSeg[i - 1], right: rightSeg[j - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && Math.abs(candDel - target) < eps) {
      out.push({ left: leftSeg[i - 1], right: null });
      i -= 1;
    } else if (j > 0 && Math.abs(candIns - target) < eps) {
      out.push({ left: null, right: rightSeg[j - 1] });
      j -= 1;
    } else {
      if (i > 0 && j > 0) {
        out.push({ left: leftSeg[i - 1], right: rightSeg[j - 1] });
        i -= 1;
        j -= 1;
      } else if (i > 0) {
        out.push({ left: leftSeg[i - 1], right: null });
        i -= 1;
      } else {
        out.push({ left: null, right: rightSeg[j - 1] });
        j -= 1;
      }
    }
  }
  out.reverse();
  return out;
}

function scorePairGreedy(lp: CompareParaSnapshot, rp: CompareParaSnapshot): number {
  const sim = getEffectiveSimilarity(lp, rp);
  if (lp.signature !== rp.signature && sim < softSimilarityThresholdForPair(lp, rp)) return -1;
  let score = 0;
  if (lp.signature === rp.signature) score += 5;
  if (lp.controlCount === rp.controlCount) score += 1;
  if (isNearStructure(lp, rp)) score += NEAR_STRUCTURE_GREEDY_BONUS;
  return score + sim * 3;
}

/**
 * 대구간 폴백: 오른쪽 문단 순서대로 왼쪽 후보를 윈도 안에서 고른 뒤, 점수로 매칭.
 * - `minScore`: 서명이 다른 의역 문단은 sim*3+보너스로도 낮게 나올 수 있어 NEAR_STRUCTURE_GREEDY_BONUS 로 보완.
 * - `ambiguous`: 1·2위 점수 차가 GREEDY_AMBIGUOUS_GAP 미만이면 매칭 포기. 단 1위가 `isNearStructure`이면
 *   동률 검사 생략(의역 쌍이 엉뚱한 2위와 0.2점 차로 동반 탈락하는 것 방지).
 */
function matchWindowedGreedy(leftSeg: CompareParaSnapshot[], rightSeg: CompareParaSnapshot[]): AlignedPair[] {
  const aligned: AlignedPair[] = [];
  const usedLeft = new Set<number>();
  let leftCursor = 0;
  /** 후보 거절 임계. 튜닝 시 `scorePairGreedy` 최솟값(서명 불일치·의역)과 함께 맞출 것 */
  const minScore = 3.45;

  const pickBestInRange = (rp: CompareParaSnapshot, start: number, end: number) => {
    let bestLi = -1;
    let bestScore = -1;
    let secondScore = -1;
    const lo = Math.max(0, start);
    const hi = Math.min(leftSeg.length - 1, end);
    for (let li = lo; li <= hi; li += 1) {
      if (usedLeft.has(li)) continue;
      const s = scorePairGreedy(leftSeg[li], rp);
      if (s < 0) continue;
      if (s > bestScore) {
        secondScore = bestScore;
        bestScore = s;
        bestLi = li;
      } else if (s > secondScore) {
        secondScore = s;
      }
    }
    return { bestLi, bestScore, secondScore };
  };

  for (let ri = 0; ri < rightSeg.length; ri += 1) {
    if (ri % 32 === 0 && shouldBailToGreedy()) {
      for (let rj = ri; rj < rightSeg.length; rj += 1) aligned.push({ left: null, right: rightSeg[rj] });
      for (let li = 0; li < leftSeg.length; li += 1) {
        if (!usedLeft.has(li)) aligned.push({ left: leftSeg[li], right: null });
      }
      return aligned;
    }
    const rp = rightSeg[ri];
    const start = Math.max(leftCursor, 0);
    const end = Math.min(leftSeg.length - 1, leftCursor + WINDOW_SIZE + WINDOW_SIZE);
    let { bestLi, bestScore, secondScore } = pickBestInRange(rp, start, end);

    if (bestLi < 0 || bestScore < minScore) {
      const full = pickBestInRange(rp, 0, leftSeg.length - 1);
      if (full.bestScore > bestScore) {
        bestLi = full.bestLi;
        bestScore = full.bestScore;
        secondScore = full.secondScore;
      }
    }

    const isBestNear = bestLi >= 0 && isNearStructure(leftSeg[bestLi], rp);
    const ambiguous =
      !isBestNear && bestLi >= 0 && secondScore >= 0 && bestScore - secondScore < GREEDY_AMBIGUOUS_GAP;
    if (bestLi >= 0 && bestScore >= minScore && !ambiguous) {
      usedLeft.add(bestLi);
      aligned.push({ left: leftSeg[bestLi], right: rp });
      leftCursor = bestLi;
    } else {
      aligned.push({ left: null, right: rp });
    }
  }

  for (let li = 0; li < leftSeg.length; li += 1) {
    if (!usedLeft.has(li)) aligned.push({ left: leftSeg[li], right: null });
  }
  return aligned;
}

/** 왼쪽 한 문단이 오른쪽 연속 두 문단으로만 쪼개진 경우(순서: 앞·뒤) */
function isLeftParagraphSplitIntoTwoRightParas(
  left: CompareParaSnapshot,
  rightHead: CompareParaSnapshot,
  rightTail: CompareParaSnapshot,
): boolean {
  const joined = `${rightHead.normalizedText} ${rightTail.normalizedText}`.trim();
  if (!joined) return false;
  const leftN = left.normalizedText.replace(/\s+/g, ' ').trim();
  const joinedN = joined.replace(/\s+/g, ' ').trim();
  if (!leftN) return false;
  // 중간 삽입으로 밀린 경우: R앞에 원문에 없던 긴 텍스트가 끼면 이어붙인 길이가 원문보다 커진다.
  // textSimilarity의 contains 부스트만으로는 이 경우도 '분할'로 오인할 수 있어 길이로 한 번 걸러낸다.
  const maxExtra = Math.max(2, Math.ceil(leftN.length * 0.06));
  if (joinedN.length > leftN.length + maxExtra) return false;
  return textSimilarity(left.normalizedText, joined) >= PARA_SPLIT_JOIN_SIM_MIN;
}

/**
 * 유사도만으로는 잡기 어려운 케이스 보정:
 * - 기존 빈 문단에 텍스트를 입력한 경우(sim=0에 가까움)도
 *   구조 신호(구역/문단 위치/컨트롤 수)가 일치하면 "텍스트 변경"으로 본다.
 */
function shouldPromoteEmptyTextEdit(
  left: CompareParaSnapshot,
  right: CompareParaSnapshot,
  leftParas: CompareParaSnapshot[],
  rightParas: CompareParaSnapshot[],
): boolean {
  if (left.section !== right.section) return false;
  // 문서 비교(alignment)에서는 앞쪽 삽입/삭제로 인덱스가 쉽게 밀리므로
  // 빈문단 편집 승격은 근접 허용폭을 약간 넓힌다.
  if (Math.abs(left.paragraph - right.paragraph) > 2) return false;
  if (Math.abs(left.globalIndex - right.globalIndex) > 4) return false;
  if (left.controlCount !== right.controlCount) return false;
  const lEmpty = left.normalizedText.length === 0;
  const rEmpty = right.normalizedText.length === 0;
  if (lEmpty === rEmpty) return false;
  const leftByGlobal = new Map<number, CompareParaSnapshot>(leftParas.map((p) => [p.globalIndex, p] as const));
  const rightByGlobal = new Map<number, CompareParaSnapshot>(rightParas.map((p) => [p.globalIndex, p] as const));

  const leftPrev = leftByGlobal.get(left.globalIndex - 1) ?? null;
  const leftNext = leftByGlobal.get(left.globalIndex + 1) ?? null;
  const rightPrev = rightByGlobal.get(right.globalIndex - 1) ?? null;
  const rightNext = rightByGlobal.get(right.globalIndex + 1) ?? null;

  const isEmptyPara = (p: CompareParaSnapshot | null) => !!p && p.normalizedText.length === 0;

  // 연속 빈 문단 구간은 원래 보수적으로 차단했지만,
  // 실제 문서에서는 "빈 문단 -> 텍스트 입력" 케이스가 여기에 걸려 added/removed로 남는 경우가 잦다.
  // 슬롯 근접(문단/전역 인덱스)일 때는 빈 이웃이 있어도 승격을 허용한다.
  const hasAdjacentEmpty =
    isEmptyPara(leftPrev) || isEmptyPara(leftNext) || isEmptyPara(rightPrev) || isEmptyPara(rightNext);
  if (hasAdjacentEmpty) {
    const nearSlot =
      Math.abs(left.paragraph - right.paragraph) <= 2 &&
      Math.abs(left.globalIndex - right.globalIndex) <= 4;
    if (!nearSlot) return false;
  }

  // 양옆 문맥 정합성: 바로 위/아래 문단 중 하나 이상은 시그니처가 유지되어야 한다.
  const prevStable =
    !!leftPrev &&
    !!rightPrev &&
    leftPrev.section === rightPrev.section &&
    leftPrev.signature === rightPrev.signature;
  const nextStable =
    !!leftNext &&
    !!rightNext &&
    leftNext.section === rightNext.section &&
    leftNext.signature === rightNext.signature;
  if (!prevStable && !nextStable) {
    // 양옆 시그니처가 모두 흔들린 케이스에서도,
    // 같은 슬롯 근처(문단/전역 인덱스가 충분히 가까운 경우)면 빈문단 편집으로 본다.
    const nearSlot =
      Math.abs(left.paragraph - right.paragraph) <= 2 &&
      Math.abs(left.globalIndex - right.globalIndex) <= 4;
    if (!nearSlot) return false;
  }

  return true;
}

/**
 * 정렬이 (삭제, 추가)로 쪼개졌지만 텍스트는 같은 문단의 수정에 가깝다고 볼 때(밀림·globalIndex 한계 보정).
 */
function shouldMergeRemovedAddedAsModify(lp: CompareParaSnapshot, rp: CompareParaSnapshot): boolean {
  if (lp.section !== rp.section) return false;
  if (lp.controlCount !== rp.controlCount) return false;
  if (Math.abs(lp.paragraph - rp.paragraph) > REMOVED_ADDED_MAX_PARA_GAP) return false;
  if (Math.abs(lp.globalIndex - rp.globalIndex) > REMOVED_ADDED_MAX_GLOBAL_GAP) return false;
  return textSimilarity(lp.normalizedText, rp.normalizedText) >= REMOVED_ADDED_MERGE_SIM_MIN;
}

/**
 * alignment 직후 `shouldPromoteEmptyTextEdit`로 빈 문단 편집만 (삭제+추가)→변경 승격한다.
 */
/**
 * alignment 본문 비교 — 단계별:
 * (1) `buildAnchorPairs` + 구간 슬라이스로 `aligned[]` 생성 (`matchSegment*`).
 * (2) 아래 for 루프는 **앞에서부터** 한 쌍씩 소비하며 DiffItem 을 쌓는다. 순서가 곧 우선순위(빈문단 승격 등).
 *     - 빈 문단 편집 → 단일 modified
 *     - (L,null)(null,R) / (null,R)(L,null) + 유사도·거리 → 삭제/추가 대신 modified-merged
 *     - (null,R1)(L,R2) + 쪼개기 유사도 → 라벨 순서 교정(변경+추가)
 *     - 단일 (null,R) / (L,null) → added / removed
 *     - (L,R) 둘 다 있으면 텍스트·이동·컨트롤 수 메타
 * (3) 정렬이 이미 잘못된 경우는 여기서 완전 복구 불가 → 상단 앵커·튜닝과 함께 봐야 함.
 */
function buildTextDiffs(left: CompareDocumentSnapshot, right: CompareDocumentSnapshot): DiffItem[] {
  const diffs: DiffItem[] = [];
  const lps = left.paragraphs;
  const rps = right.paragraphs;
  const anchorTuning = resolveAnchorTuning(activeCompareOptions ?? DEFAULT_COMPARE_OPTIONS);
  const anchors = buildAnchorPairs(lps, rps);
  if (isCompareDebugEnabled()) {
    compareDbg(
      '[③ 앵커] 시그니처 유일 + 품질필터(길이/공백비율/엔트로피). 빈 줄·패턴 문장이 많으면 구간이 어긋날 수 있음.',
      `앵커 ${anchors.length}쌍 (앞 20개)`,
      anchors.slice(0, 20).map(({ li, ri }) => ({
        li,
        ri,
        left: lps[li].text.slice(0, 44),
        right: rps[ri].text.slice(0, 44),
        normLenL: lps[li].normalizedText.length,
        normLenR: rps[ri].normalizedText.length,
        anchorMinLen: anchorTuning.minTextLen,
      })),
    );
  }
  const boundaries = [{ li: -1, ri: -1 }, ...anchors, { li: lps.length, ri: rps.length }];

  const aligned: AlignedPair[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const a = boundaries[i];
    const b = boundaries[i + 1];

    if (a.li >= 0 && a.ri >= 0) {
      aligned.push({ left: lps[a.li], right: rps[a.ri] });
    }

    const leftSeg = lps.slice(a.li + 1, b.li);
    const rightSeg = rps.slice(a.ri + 1, b.ri);
    if (leftSeg.length === 0 && rightSeg.length === 0) continue;
    aligned.push(...matchSegment(leftSeg, rightSeg));
  }

  for (let i = 0; i < aligned.length; i += 1) {
    const pair = aligned[i];
    const l = pair.left;
    const r = pair.right;
    const next = i + 1 < aligned.length ? aligned[i + 1] : null;

    // 구조 기반 보정: 빈 문단 편집(빈 -> 텍스트 / 텍스트 -> 빈)
    // DP가 (삭제+추가)로 갈라놓은 경우를 같은 문단 수정으로 재분류한다.
    if (
      l &&
      !r &&
      next &&
      !next.left &&
      next.right &&
      shouldPromoteEmptyTextEdit(l, next.right, lps, rps)
    ) {
      diffs.push({
        id: mkDiffId('text', `modified-empty-edit:${l.section}:${l.paragraph}`),
        kind: 'text',
        severity: 'modified',
        path: preferRightPath(l, next.right),
        title: `텍스트 변경 (${l.section}.${l.paragraph})`,
        leftPreview: l.text,
        rightPreview: next.right.text,
        leftAnchor: l.anchor,
        rightAnchor: next.right.anchor,
      });
      i += 1;
      continue;
    }
    if (
      !l &&
      r &&
      next &&
      next.left &&
      !next.right &&
      shouldPromoteEmptyTextEdit(next.left, r, lps, rps)
    ) {
      diffs.push({
        id: mkDiffId('text', `modified-empty-edit:${next.left.section}:${next.left.paragraph}`),
        kind: 'text',
        severity: 'modified',
        path: preferRightPath(next.left, r),
        title: `텍스트 변경 (${next.left.section}.${next.left.paragraph})`,
        leftPreview: next.left.text,
        rightPreview: r.text,
        leftAnchor: next.left.anchor,
        rightAnchor: r.anchor,
      });
      i += 1;
      continue;
    }

    // (L,null)(null,R): 정렬은 삭제+추가지만, 밀림 등으로 isNear가 깨져도 텍스트가 같으면 수정으로 승격
    if (l && !r && next && !next.left && next.right && shouldMergeRemovedAddedAsModify(l, next.right)) {
      const r2 = next.right;
      diffs.push({
        id: mkDiffId('text', `modified-merged:${l.section}:${l.paragraph}`),
        kind: 'text',
        severity: 'modified',
        path: preferRightPath(l, r2),
        title: `텍스트 변경 (${r2.section}.${r2.paragraph})`,
        leftPreview: l.text,
        rightPreview: r2.text,
        leftAnchor: l.anchor,
        rightAnchor: r2.anchor,
        leftSectionPage: l.sectionPage,
        rightSectionPage: r2.sectionPage,
      });
      i += 1;
      continue;
    }
    if (!l && r && next && next.left && !next.right && shouldMergeRemovedAddedAsModify(next.left, r)) {
      const l2 = next.left;
      diffs.push({
        id: mkDiffId('text', `modified-merged:${l2.section}:${l2.paragraph}`),
        kind: 'text',
        severity: 'modified',
        path: preferRightPath(l2, r),
        title: `텍스트 변경 (${r.section}.${r.paragraph})`,
        leftPreview: l2.text,
        rightPreview: r.text,
        leftAnchor: l2.anchor,
        rightAnchor: r.anchor,
        leftSectionPage: l2.sectionPage,
        rightSectionPage: r.sectionPage,
      });
      i += 1;
      continue;
    }

    // 정렬이 (null, R앞)(L, R뒤)로 나오면 기본은 R앞=추가·L↔R뒤=변경 순이 되어 라벨이 뒤집힌다.
    // 왼쪽 원문 L과 R앞+R뒤가 같으면: R앞은 기존 문단에 남은 부분→텍스트 변경, R뒤만 문단 추가.
    if (!l && r && next && next.left && next.right && isLeftParagraphSplitIntoTwoRightParas(next.left, r, next.right)) {
      const L = next.left;
      const rHead = r;
      const rTail = next.right;
      diffs.push(
        {
          id: mkDiffId('text', `modified:${L.section}:${L.paragraph}`),
          kind: 'text',
          severity: 'modified',
          path: preferRightPath(L, rHead),
          title: `텍스트 변경 (${rHead.section}.${rHead.paragraph})`,
          leftPreview: L.text,
          rightPreview: rHead.text,
          leftAnchor: L.anchor,
          rightAnchor: rHead.anchor,
          leftSectionPage: L.sectionPage,
          rightSectionPage: rHead.sectionPage,
        },
        {
          id: mkDiffId('text', `added:${rTail.section}:${rTail.paragraph}`),
          kind: 'text',
          severity: 'added',
          path: { section: rTail.section, paragraph: rTail.paragraph },
          title: `문단 추가 (${rTail.section}.${rTail.paragraph})`,
          leftPreview: '',
          rightPreview: rTail.text,
          rightAnchor: rTail.anchor,
          rightSectionPage: rTail.sectionPage,
        },
      );
      i += 1;
      continue;
    }

    if (!l && r) {
      diffs.push({
        id: mkDiffId('text', `added:${r.section}:${r.paragraph}`),
        kind: 'text',
        severity: 'added',
        path: { section: r.section, paragraph: r.paragraph },
        title: `문단 추가 (${r.section}.${r.paragraph})`,
        leftPreview: '',
        rightPreview: r.text,
        rightAnchor: r.anchor,
        rightSectionPage: r.sectionPage,
      });
      continue;
    }
    if (l && !r) {
      diffs.push({
        id: mkDiffId('text', `removed:${l.section}:${l.paragraph}`),
        kind: 'text',
        severity: 'removed',
        path: preferRightPath(l, r),
        title: `문단 삭제 (${l.section}.${l.paragraph})`,
        leftPreview: l.text,
        rightPreview: '',
        leftAnchor: l.anchor,
        leftSectionPage: l.sectionPage,
      });
      continue;
    }
    if (!l || !r) continue;

    if (l.normalizedText !== r.normalizedText) {
      diffs.push({
        id: mkDiffId('text', `modified:${l.section}:${l.paragraph}`),
        kind: 'text',
        severity: 'modified',
        path: preferRightPath(l, r),
        title: `텍스트 변경 (${l.section}.${l.paragraph})`,
        leftPreview: l.text,
        rightPreview: r.text,
        leftAnchor: l.anchor,
        rightAnchor: r.anchor,
      });
    }

    // 이동 감지: 텍스트/서명은 같지만 위치가 크게 달라진 경우
    if (
      l.signature === r.signature &&
      Math.abs(l.globalIndex - r.globalIndex) > MOVE_DISTANCE_THRESHOLD
    ) {
      diffs.push({
        id: mkDiffId('paragraphMeta', `moved:${l.section}:${l.paragraph}`),
        kind: 'paragraphMeta',
        severity: 'modified',
        path: { section: l.section, paragraph: l.paragraph },
        title: `문단 이동 감지 (${l.section}.${l.paragraph})`,
        leftPreview: `A idx=${l.globalIndex}`,
        rightPreview: `B idx=${r.globalIndex}`,
        leftAnchor: l.anchor,
        rightAnchor: r.anchor,
      });
    }

    if (l.controlCount !== r.controlCount) {
      diffs.push({
        id: mkDiffId('paragraphMeta', `ctrlcount:${l.section}:${l.paragraph}`),
        kind: 'paragraphMeta',
        severity: 'modified',
        path: { section: l.section, paragraph: l.paragraph },
        title: `문단 개체 수 변경 (${l.section}.${l.paragraph})`,
        leftPreview: `controls=${l.controlCount}`,
        rightPreview: `controls=${r.controlCount}`,
        leftAnchor: l.anchor,
        rightAnchor: r.anchor,
      });
    }
  }
  return diffs;
}

const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  caseSensitive: false,
  ignoreWhitespace: true,
  kinds: ['text', 'table', 'shape', 'image', 'chart', 'paragraphMeta'],
};

let activeCompareOptions: CompareOptions | null = null;

/**
 * 표/그림 등 컨트롤: kind+key로 1차 매칭 → 남은 것은 위치·요약 유사도로 폴백 매칭.
 * 폴백에서 내용이 동일하면(diff-engine 상단 정책) 사용자 혼동을 줄이기 위해 항목 생략 가능.
 */
function buildControlDiffs(left: CompareDocumentSnapshot, right: CompareDocumentSnapshot): DiffItem[] {
  const diffs: DiffItem[] = [];
  const lmap = new Map(left.controls.map((c) => [`${c.kind}::${c.key}`, c] as const));
  const rmap = new Map(right.controls.map((c) => [`${c.kind}::${c.key}`, c] as const));
  const unmatchedLeft: CompareControlSnapshot[] = [];
  const unmatchedRight: CompareControlSnapshot[] = [];

  // 1차: key 기반 정확 매칭
  const keys = new Set([...lmap.keys(), ...rmap.keys()]);
  for (const key of keys) {
    const l = lmap.get(key);
    const r = rmap.get(key);
    if (l && r) {
      if (l.summary !== r.summary || l.kind !== r.kind) {
        diffs.push(...buildGranularControlDiffs(l, r, `modified:${key}`));
      }
      continue;
    }
    if (l) unmatchedLeft.push(l);
    if (r) unmatchedRight.push(r);
  }

  // 2차: key가 달라진 컨트롤(특히 표/이미지)의 폴백 매칭
  const fallbackPairs = pairControlsFallback(unmatchedLeft, unmatchedRight);
  const pairedL = new Set(fallbackPairs.map((p) => p.left));
  const pairedR = new Set(fallbackPairs.map((p) => p.right));
  for (const { left: l, right: r } of fallbackPairs) {
    // 매칭 키만 달라지고 내용/속성이 동일하면 "밀림 보정" 성격의 재매칭이므로 결과에서 제외한다.
    if (l.summary === r.summary && l.type === r.type && l.kind === r.kind) continue;
    diffs.push(...buildGranularControlDiffs(l, r, `fallback-modified:${l.key}=>${r.key}`));
  }

  for (const r of unmatchedRight) {
    if (pairedR.has(r)) continue;
    const key = `${r.kind}::${r.key}`;
    diffs.push({
      id: mkDiffId(r.kind, `added:${key}`),
      kind: r.kind,
      severity: 'added',
      path: { section: r.section, paragraph: r.paragraph, controlKey: key },
      title: `${kindLabel(r.kind)} 추가`,
      leftPreview: '',
      rightPreview: r.summary,
      rightAnchor: r.anchor,
    });
  }
  for (const l of unmatchedLeft) {
    if (pairedL.has(l)) continue;
    const key = `${l.kind}::${l.key}`;
    diffs.push({
      id: mkDiffId(l.kind, `removed:${key}`),
      kind: l.kind,
      severity: 'removed',
      path: { section: l.section, paragraph: l.paragraph, controlKey: key },
      title: `${kindLabel(l.kind)} 삭제`,
      leftPreview: l.summary,
      rightPreview: '',
      leftAnchor: l.anchor,
    });
  }
  return diffs;
}

function pairControlsFallback(
  left: CompareControlSnapshot[],
  right: CompareControlSnapshot[],
): ControlPair[] {
  const pairs: ControlPair[] = [];
  const usedL = new Set<number>();
  for (let ri = 0; ri < right.length; ri += 1) {
    const r = right[ri];
    let bestLi = -1;
    let bestScore = -1;
    for (let li = 0; li < left.length; li += 1) {
      if (usedL.has(li)) continue;
      const l = left[li];
      const score = scoreControlFallback(l, r);
      if (score > bestScore) {
        bestScore = score;
        bestLi = li;
      }
    }
    if (bestLi >= 0 && bestScore >= 2.75) {
      usedL.add(bestLi);
      pairs.push({ left: left[bestLi], right: r });
    }
  }
  return pairs;
}

/** 폴백 매칭 점수: 종류 일치, 요약 일치, 페이지/y 근접에 가산 */
function scoreControlFallback(l: CompareControlSnapshot, r: CompareControlSnapshot): number {
  if (l.kind !== r.kind) return -1;
  let score = 0;
  if (l.type === r.type) score += 1.2;
  if (l.summary === r.summary) score += 2.6;
  else {
    const ld = l.summary.toLowerCase();
    const rd = r.summary.toLowerCase();
    if (ld.includes('table') && rd.includes('table')) score += 1.0;
    if (ld.includes('shape') && rd.includes('shape')) score += 0.8;
  }
  const lci = extractControlIndexFromKey(l.key);
  const rci = extractControlIndexFromKey(r.key);
  if (lci != null && rci != null && lci === rci) score += 1.15;
  if (l.section === r.section) score += 0.45;
  const pageGap = Math.abs(l.anchor.pageIndex - r.anchor.pageIndex);
  if (pageGap === 0) score += 0.9;
  else if (pageGap === 1) score += 0.45;
  const xGap = Math.abs(l.anchor.x - r.anchor.x);
  const yGap = Math.abs(l.anchor.y - r.anchor.y);
  const wGap = Math.abs(l.anchor.width - r.anchor.width);
  const hGap = Math.abs(l.anchor.height - r.anchor.height);
  if (xGap < 120) score += 0.35;
  else if (xGap < 260) score += 0.18;
  if (yGap < 80) score += 0.6;
  else if (yGap < 180) score += 0.3;
  if (wGap < 45 && hGap < 45) score += 0.45;
  else if (wGap < 120 && hGap < 120) score += 0.22;
  return score;
}

/** 각 DiffItem에 구역 내 표시 쪽번호(leftSectionPage/rightSectionPage)를 붙인다 */
function annotateDiffSectionPages(
  diffs: DiffItem[],
  left: CompareDocumentSnapshot,
  right: CompareDocumentSnapshot,
): void {
  const lByPos = new Map<string, CompareParaSnapshot>();
  const rByPos = new Map<string, CompareParaSnapshot>();
  const lByStable = new Map<string, CompareParaSnapshot>();
  const rByStable = new Map<string, CompareParaSnapshot>();
  for (const p of left.paragraphs) {
    lByPos.set(`${p.section}:${p.paragraph}`, p);
    lByStable.set(p.stableId, p);
  }
  for (const p of right.paragraphs) {
    rByPos.set(`${p.section}:${p.paragraph}`, p);
    rByStable.set(p.stableId, p);
  }

  for (const d of diffs) {
    let lp: CompareParaSnapshot | undefined;
    let rp: CompareParaSnapshot | undefined;

    const sidMatch = d.id.match(/id-(?:added|removed|modified|moved|ctrlcount):(.+)$/);
    if (sidMatch) {
      const sid = sidMatch[1];
      lp = lByStable.get(sid);
      rp = rByStable.get(sid);
    } else {
      const key = `${d.path.section}:${d.path.paragraph ?? -1}`;
      if (d.severity === 'removed') {
        lp = lByPos.get(key);
      } else if (d.severity === 'added') {
        rp = rByPos.get(key);
      } else {
        lp = lByPos.get(key);
        rp = rByPos.get(key);
      }
    }

    // 컨트롤 diff는 controlKey에 부모 문단 stable_id가 포함될 수 있다.
    // path 기반 문단 매핑이 어긋난 경우 sid로 좌/우 문단을 재식별해 쪽번호를 고정한다.
    if ((!lp || !rp) && d.path.controlKey) {
      const sidMatch = d.path.controlKey.match(/sid:([^:]+):\d+:/);
      if (sidMatch) {
        const sid = sidMatch[1];
        if (!lp) lp = lByStable.get(sid);
        if (!rp) rp = rByStable.get(sid);
      }
    }

    if (lp) d.leftSectionPage = lp.sectionPage;
    if (rp) d.rightSectionPage = rp.sectionPage;

    // 문단 매핑 실패(특히 컨트롤/일부 메타) 시에도 렌더 엔진이 계산한 표시 쪽번호를 사용.
    if (!d.leftSectionPage && d.leftAnchor) {
      const pn = left.meta.pageDisplayNumbers?.[d.leftAnchor.pageIndex];
      if (pn && pn > 0) d.leftSectionPage = pn;
    }
    if (!d.rightSectionPage && d.rightAnchor) {
      const pn = right.meta.pageDisplayNumbers?.[d.rightAnchor.pageIndex];
      if (pn && pn > 0) d.rightSectionPage = pn;
    }
  }
}

/** 이미 파싱된 스냅샷 두 개 비교 — 동일 WASM 세션 이력 등에서 stable_id 유지 */
export function compareSnapshots(
  left: CompareDocumentSnapshot,
  right: CompareDocumentSnapshot,
  options: CompareOptions,
): CompareSession {
  activeCompareOptions = options;
  const strategy: CompareStrategy = options.strategy ?? 'alignment';
  const perf = resolvePerformanceTuning(options);
  activeRuntimeGuard = {
    deadline: Date.now() + perf.maxComputeMs,
    bailedOut: false,
  };
  const textMode = resolveTextCompareStrategy(strategy, left, right);

  // compare-debug 켜진 빌드에서만: stable_id 품질(①) → 전략(②) → alignment는 ③ 앵커 로그 참고
  if (isCompareDebugEnabled()) {
    const lmap = buildStableIdMap(left);
    const rmap = buildStableIdMap(right);
    let sharedStable = 0;
    if (lmap && rmap) {
      for (const id of lmap.keys()) {
        if (rmap.has(id)) sharedStable += 1;
      }
    }
    compareDbg('[① stable_id] 스냅샷 요약', {
      left: left.meta.name,
      right: right.meta.name,
      leftParas: left.paragraphs.length,
      rightParas: right.paragraphs.length,
      leftHead: left.paragraphs.slice(0, 10).map((p) => ({
        sec: p.section,
        para: p.paragraph,
        id: p.stableId ? `${p.stableId.slice(0, 14)}…` : '(빈)',
        t: p.text.slice(0, 32),
      })),
      rightHead: right.paragraphs.slice(0, 10).map((p) => ({
        sec: p.section,
        para: p.paragraph,
        id: p.stableId ? `${p.stableId.slice(0, 14)}…` : '(빈)',
        t: p.text.slice(0, 32),
      })),
    });
    compareDbg('[② 전략·폴백]', {
      optionsStrategy: strategy,
      textMode,
      mapsBuildOk: Boolean(lmap && rmap),
      sharedStableIdCount: lmap && rmap ? sharedStable : null,
      path:
        textMode === 'identity'
          ? 'buildIdentityTextDiffs (Map<stableId>, 인덱스 1:1 아님)'
          : 'buildTextDiffs (앵커 + 구간 DP/Myers — ③ 로그 참고)',
    });
  }

  // 1) 본문: identity면 sid 집합 비교, 아니면 앵커+구간 정렬
  const textDiffs =
    textMode === 'identity'
      ? buildIdentityTextDiffs(left, right, options.kinds)
      : buildTextDiffs(left, right);

  // 2) 개체(표/도형 등) 병합
  const all = [...textDiffs, ...buildControlDiffs(left, right)];

  // 3) kinds 필터 + 순수 리플로우 이동 노이즈 제거 후, UI용 쪽번호 주석
  const filtered = suppressPureReflowMoves(
    all.filter((d) => options.kinds.includes(d.kind)),
    left,
    right,
  );
  annotateDiffSectionPages(filtered, left, right);
  if (isCompareDebugEnabled() && activeRuntimeGuard?.bailedOut) {
    compareDbg('[성능 가드레일] 타임버짓 초과로 일부 구간을 greedy/fallback으로 처리했습니다.');
  }
  // 목록 정렬: 구역 → 문단 순으로 탐색하기 쉽게
  filtered.sort((a, b) => {
    const sa = a.path.section ?? 0;
    const sb = b.path.section ?? 0;
    if (sa !== sb) return sa - sb;
    const pa = a.path.paragraph ?? 0;
    const pb = b.path.paragraph ?? 0;
    return pa - pb;
  });

  try {
    return {
      left: left.meta,
      right: right.meta,
      options,
      diffItems: filtered,
      currentDiffIndex: filtered.length > 0 ? 0 : -1,
      generatedAt: Date.now(),
      textCompareStrategyUsed: textMode,
    };
  } finally {
    activeRuntimeGuard = null;
    activeCompareOptions = null;
  }
}

/** 외부 두 파일(bytes): 각각 별도 WASM으로 스냅샷 → 공통 `compareSnapshots` 파이프라인 */
export async function compareDocuments(
  leftBytes: Uint8Array,
  leftName: string,
  rightBytes: Uint8Array,
  rightName: string,
  options: CompareOptions,
): Promise<CompareSession> {
  const left = await buildSnapshotFromBytes(leftBytes, leftName, options);
  const right = await buildSnapshotFromBytes(rightBytes, rightName, options);
  return compareSnapshots(left, right, options);
}
