import { WasmBridge } from '@/core/wasm-bridge';
import type { DocumentInfo } from '@/core/types';
import { EventBus } from '@/core/event-bus';
import { CanvasView } from '@/view/canvas-view';
import { InputHandler } from '@/engine/input-handler';
import { Toolbar } from '@/ui/toolbar';
import { MenuBar } from '@/ui/menu-bar';
import { getDetectedOSFonts, loadWebFonts, REGISTERED_FONTS } from '@/core/font-loader';
import { resolveFont } from '@/core/font-substitution';
import { CommandRegistry } from '@/command/registry';
import { CommandDispatcher } from '@/command/dispatcher';
import type { EditorContext, CommandServices } from '@/command/types';
import { fileCommands } from '@/command/commands/file';
import { editCommands } from '@/command/commands/edit';
import { viewCommands } from '@/command/commands/view';
import { formatCommands } from '@/command/commands/format';
import { insertCommands } from '@/command/commands/insert';
import { tableCommands } from '@/command/commands/table';
import { pageCommands } from '@/command/commands/page';
import { toolCommands } from '@/command/commands/tool';
import { ContextMenu } from '@/ui/context-menu';
import { CommandPalette } from '@/ui/command-palette';
import { showToast } from '@/ui/toast';
import { CellSelectionRenderer } from '@/engine/cell-selection-renderer';
import { TableObjectRenderer } from '@/engine/table-object-renderer';
import { TableResizeRenderer } from '@/engine/table-resize-renderer';
import { Ruler } from '@/view/ruler';

const wasm = new WasmBridge();
const eventBus = new EventBus();

// E2E 테스트용 전역 노출 (개발 모드 전용)
if (import.meta.env.DEV) {
  (window as any).__wasm = wasm;
  (window as any).__eventBus = eventBus;
}
let canvasView: CanvasView | null = null;
let inputHandler: InputHandler | null = null;
let toolbar: Toolbar | null = null;
let ruler: Ruler | null = null;


// ─── 커맨드 시스템 ─────────────────────────────
const registry = new CommandRegistry();

function getContext(): EditorContext {
  const hasDoc = wasm.pageCount > 0;
  return {
    hasDocument: hasDoc,
    hasSelection: inputHandler?.hasSelection() ?? false,
    inTable: inputHandler?.isInTable() ?? false,
    inCellSelectionMode: inputHandler?.isInCellSelectionMode() ?? false,
    inTableObjectSelection: inputHandler?.isInTableObjectSelection() ?? false,
    inPictureObjectSelection: inputHandler?.isInPictureObjectSelection() ?? false,
    inField: inputHandler?.isInField() ?? false,
    isEditable: true,
    canUndo: inputHandler?.canUndo() ?? false,
    canRedo: inputHandler?.canRedo() ?? false,
    zoom: canvasView?.getViewportManager().getZoom() ?? 1.0,
    showControlCodes: wasm.getShowControlCodes(),
    sourceFormat: hasDoc ? (wasm.getSourceFormat() as 'hwp' | 'hwpx') : undefined,
  };
}

const commandServices: CommandServices = {
  eventBus,
  wasm,
  getContext,
  getInputHandler: () => inputHandler,
  getViewportManager: () => canvasView?.getViewportManager() ?? null,
};

const dispatcher = new CommandDispatcher(registry, commandServices, eventBus);

// 모든 내장 커맨드 등록
registry.registerAll(fileCommands);
registry.registerAll(editCommands);
registry.registerAll(viewCommands);
registry.registerAll(formatCommands);
registry.registerAll(insertCommands);
registry.registerAll(tableCommands);
registry.registerAll(pageCommands);
registry.registerAll(toolCommands);

// 상태 바 요소
const sbMessage = () => document.getElementById('sb-message')!;
const sbPage = () => document.getElementById('sb-page')!;
const sbSection = () => document.getElementById('sb-section')!;
const sbZoomVal = () => document.getElementById('sb-zoom-val')!;

function debugFontResolution(docInfo: DocumentInfo): void {
  const used = [...new Set(docInfo.fontsUsed ?? [])].filter(Boolean);
  if (used.length === 0) return;
  const rows = used.map((name) => {
    const resolved = resolveFont(name, 0, 0);
    let localInstalled = false;
    try {
      localInstalled = document.fonts.check(`16px "${name}"`);
    } catch {
      localInstalled = false;
    }
    return {
      source: name,
      resolved,
      localInstalled,
      registeredSource: REGISTERED_FONTS.has(name),
      registeredResolved: REGISTERED_FONTS.has(resolved),
      changed: resolved !== name,
    };
  });
  const unresolved = rows.filter((r) => !r.localInstalled && !r.registeredSource && !r.registeredResolved);
  console.groupCollapsed(`[font-debug] used=${rows.length}, unresolved=${unresolved.length}`);
  console.log('[font-debug] detectedOSFonts=', Array.from(getDetectedOSFonts()));
  console.table(rows);
  if (unresolved.length > 0) {
    console.warn('[font-debug] unresolved fonts:', unresolved.map((r) => r.source));
  }
  console.groupEnd();
}

async function initialize(): Promise<void> {
  const msg = sbMessage();
  try {
    msg.textContent = '웹폰트 로딩 중...';
    await loadWebFonts([]);  // CSS @font-face 등록 + CRITICAL 폰트만 로드
    msg.textContent = 'WASM 로딩 중...';
    await wasm.initialize();
    msg.textContent = 'HWP 파일을 선택해주세요.';

    const container = document.getElementById('scroll-container')!;
    canvasView = new CanvasView(container, wasm, eventBus);

    // 눈금자 초기화
    ruler = new Ruler(
      document.getElementById('h-ruler') as HTMLCanvasElement,
      document.getElementById('v-ruler') as HTMLCanvasElement,
      container,
      eventBus,
      wasm,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
    );

    inputHandler = new InputHandler(
      container, wasm, eventBus,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
    );

    toolbar = new Toolbar(document.getElementById('style-bar')!, wasm, eventBus, dispatcher);
    toolbar.setEnabled(false);

    // InputHandler에 커맨드 디스패처 및 컨텍스트 메뉴 주입
    inputHandler.setDispatcher(dispatcher);
    inputHandler.setContextMenu(new ContextMenu(dispatcher, registry));
    inputHandler.setCommandPalette(new CommandPalette(registry, dispatcher));
    inputHandler.setCellSelectionRenderer(
      new CellSelectionRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableResizeRenderer(
      new TableResizeRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setPictureObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll(), true),
    );

    new MenuBar(document.getElementById('menu-bar')!, eventBus, dispatcher);

    // 툴바 내 data-cmd 버튼 클릭 → 커맨드 디스패치
    document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const cmd = (btn as HTMLElement).dataset.cmd;
        if (cmd) dispatcher.dispatch(cmd, { anchorEl: btn as HTMLElement });
      });
    });

    // 스플릿 버튼 드롭다운 메뉴
    document.querySelectorAll('.tb-split').forEach(split => {
      const arrow = split.querySelector('.tb-split-arrow');
      if (arrow) {
        arrow.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // 다른 열린 메뉴 닫기
          document.querySelectorAll('.tb-split.open').forEach(s => {
            if (s !== split) s.classList.remove('open');
          });
          split.classList.toggle('open');
        });
      }
      split.querySelectorAll('.tb-split-item[data-cmd]').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          split.classList.remove('open');
          const cmd = (item as HTMLElement).dataset.cmd;
          if (cmd) dispatcher.dispatch(cmd, { anchorEl: item as HTMLElement });
        });
      });
    });
    // 외부 클릭 시 스플릿 메뉴 닫기
    document.addEventListener('mousedown', () => {
      document.querySelectorAll('.tb-split.open').forEach(s => s.classList.remove('open'));
    });

    setupFileInput();
    setupZoomControls();
    setupEventListeners();
    setupGlobalShortcuts();
    loadFromUrlParam();

    // E2E 테스트용 전역 노출 (개발 모드 전용)
    if (import.meta.env.DEV) {
      (window as any).__inputHandler = inputHandler;
      (window as any).__canvasView = canvasView;
    }
  } catch (error) {
    msg.textContent = `WASM 초기화 실패: ${error}`;
    console.error('[main] WASM 초기화 실패:', error);
  }
}

/**
 * 전역 단축키 핸들러 — InputHandler.active 여부와 무관하게 동작해야 하는 단축키.
 * 예: 문서 미로드 상태에서도 Alt+N(새 문서), Ctrl+O(열기) 등.
 */
function setupGlobalShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    // input/textarea 등 편집 가능 요소 내부에서는 무시
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    // InputHandler가 활성 상태이면 자체 처리에 맡김
    if (inputHandler?.isActive()) return;

    const ctrlOrMeta = e.ctrlKey || e.metaKey;

    // Alt+N / Alt+ㅜ → 새 문서 (문서 미로드 상태에서도 동작)
    if (e.altKey && !ctrlOrMeta && !e.shiftKey) {
      if (e.key === 'n' || e.key === 'N' || e.key === 'ㅜ') {
        e.preventDefault();
        dispatcher.dispatch('file:new-doc');
        return;
      }
    }
  }, false);
}

function setupFileInput(): void {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;

  fileInput.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.hwp') && !name.endsWith('.hwpx')) {
      alert('HWP/HWPX 파일만 지원합니다.');
      return;
    }
    await loadFile(file);
  });

  // 문서 전체에서 브라우저 기본 드롭 동작 방지 (파일 열기/다운로드 방지)
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // 드래그 앤 드롭 지원 (scroll-container 영역)
  const container = document.getElementById('scroll-container')!;
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('drag-over');
  });
  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const dropName = file.name.toLowerCase();
    if (!dropName.endsWith('.hwp') && !dropName.endsWith('.hwpx')) {
      alert('HWP/HWPX 파일만 지원합니다.');
      return;
    }
    await loadFile(file);
  });
}

function setupZoomControls(): void {
  if (!canvasView) return;
  const vm = canvasView.getViewportManager();

  document.getElementById('sb-zoom-in')!.addEventListener('click', () => {
    vm.setZoom(vm.getZoom() + 0.1);
  });
  document.getElementById('sb-zoom-out')!.addEventListener('click', () => {
    vm.setZoom(vm.getZoom() - 0.1);
  });

  // 폭 맞춤: 용지 폭에 맞게 줌 조절
  document.getElementById('sb-zoom-fit-width')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const containerWidth = container.clientWidth - 40; // 좌우 여백 제외
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width는 이미 px 단위 (96dpi 기준)
    const zoom = containerWidth / pageInfo.width;
    console.log(`[zoom-fit-width] container=${containerWidth} page=${pageInfo.width} zoom=${zoom.toFixed(3)}`);
    vm.setZoom(Math.max(0.1, Math.min(zoom, 4.0)));
  });

  // 쪽 맞춤: 한 페이지 전체가 보이도록 줌 조절
  document.getElementById('sb-zoom-fit')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const containerWidth = container.clientWidth - 40;
    const containerHeight = container.clientHeight - 40;
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width/height는 이미 px 단위 (96dpi 기준)
    const zoomW = containerWidth / pageInfo.width;
    const zoomH = containerHeight / pageInfo.height;
    console.log(`[zoom-fit-page] containerW=${containerWidth} containerH=${containerHeight} pageW=${pageInfo.width} pageH=${pageInfo.height} zoomW=${zoomW.toFixed(3)} zoomH=${zoomH.toFixed(3)}`);
    vm.setZoom(Math.max(0.1, Math.min(zoomW, zoomH, 4.0)));
  });

  // 모바일: 줌 값 클릭 → 100% 토글
  document.getElementById('sb-zoom-val')!.addEventListener('click', () => {
    const currentZoom = vm.getZoom();
    if (Math.abs(currentZoom - 1.0) < 0.05) {
      // 현재 100% → 쪽 맞춤으로 전환
      document.getElementById('sb-zoom-fit')!.click();
    } else {
      // 현재 쪽 맞춤/기타 → 100%로 전환
      vm.setZoom(1.0);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      vm.setZoom(vm.getZoom() + 0.1);
    } else if (e.key === '-') {
      e.preventDefault();
      vm.setZoom(vm.getZoom() - 0.1);
    } else if (e.key === '0') {
      e.preventDefault();
      vm.setZoom(1.0);
    }
  });
}

let totalSections = 1;
let sectionPageCache: {
  pageCount: number;
  localPageByIndex: number[];
  totalPagesByIndex: number[];
} | null = null;

function ensureSectionPageCache(): void {
  const pageCount = wasm.pageCount;
  if (pageCount <= 0) {
    sectionPageCache = null;
    return;
  }
  if (sectionPageCache && sectionPageCache.pageCount === pageCount) return;

  const sectionByPage: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    sectionByPage.push(wasm.getPageInfo(i).sectionIndex);
  }

  const localPageByIndex = new Array<number>(pageCount).fill(1);
  const totalPagesByIndex = new Array<number>(pageCount).fill(1);

  let runStart = 0;
  while (runStart < pageCount) {
    const sectionIndex = sectionByPage[runStart];
    let runEnd = runStart + 1;
    while (runEnd < pageCount && sectionByPage[runEnd] === sectionIndex) {
      runEnd += 1;
    }
    const runTotal = runEnd - runStart;
    for (let i = runStart; i < runEnd; i += 1) {
      localPageByIndex[i] = (i - runStart) + 1;
      totalPagesByIndex[i] = runTotal;
    }
    runStart = runEnd;
  }

  sectionPageCache = { pageCount, localPageByIndex, totalPagesByIndex };
}

function setupEventListeners(): void {
  eventBus.on('current-page-changed', (page, _total) => {
    const pageIdx = page as number;
    try {
      const pageInfo = wasm.getPageInfo(pageIdx);
      const sectionPageNum = pageInfo.pageNumber;
      if (typeof sectionPageNum === 'number' && Number.isFinite(sectionPageNum) && sectionPageNum > 0) {
        sbPage().textContent = `쪽: ${sectionPageNum}`;
      } else {
        ensureSectionPageCache();
        const local = sectionPageCache?.localPageByIndex[pageIdx] ?? (pageIdx + 1);
        const sectionTotal = sectionPageCache?.totalPagesByIndex[pageIdx] ?? _total;
        sbPage().textContent = `쪽: ${local} / ${sectionTotal}`;
      }
    } catch {
      sbPage().textContent = `${pageIdx + 1} / ${_total} 쪽`;
    }

    // 구역 정보: 현재 페이지의 sectionIndex로 갱신
    if (wasm.pageCount > 0) {
      try {
        const pageInfo = wasm.getPageInfo(pageIdx);
        sbSection().textContent = `구역: ${pageInfo.sectionIndex + 1} / ${totalSections}`;
      } catch { /* 무시 */ }
    }
  });

  eventBus.on('zoom-level-display', (zoom) => {
    sbZoomVal().textContent = `${Math.round((zoom as number) * 100)}%`;
  });

  // 삽입/수정 모드 토글
  eventBus.on('insert-mode-changed', (insertMode) => {
    document.getElementById('sb-mode')!.textContent = (insertMode as boolean) ? '삽입' : '수정';
  });

  // 필드 정보 표시
  const sbField = document.getElementById('sb-field');
  eventBus.on('field-info-changed', (info) => {
    if (!sbField) return;
    const fi = info as { fieldId: number; fieldType: string; guideName?: string } | null;
    if (fi) {
      const label = fi.guideName || `#${fi.fieldId}`;
      sbField.textContent = `[누름틀] ${label}`;
      sbField.style.display = '';
    } else {
      sbField.textContent = '';
      sbField.style.display = 'none';
    }
  });

  // 개체 선택 시 회전/대칭 버튼 그룹 표시/숨김
  const rotateGroup = document.querySelector('.tb-rotate-group') as HTMLElement | null;
  if (rotateGroup) {
    eventBus.on('picture-object-selection-changed', (selected) => {
      rotateGroup.style.display = (selected as boolean) ? '' : 'none';
    });
  }

  // 머리말/꼬리말 편집 모드 시 도구상자 전환 + 본문 dimming
  const hfGroup = document.querySelector('.tb-headerfooter-group') as HTMLElement | null;
  const hfLabel = hfGroup?.querySelector('.tb-hf-label') as HTMLElement | null;
  const defaultTbGroups = document.querySelectorAll('#icon-toolbar > .tb-group:not(.tb-headerfooter-group):not(.tb-rotate-group), #icon-toolbar > .tb-sep');
  const scrollContainer = document.getElementById('scroll-container');
  const styleBar = document.getElementById('style-bar');

  eventBus.on('headerFooterModeChanged', (mode) => {
    const isActive = (mode as string) !== 'none';
    // 도구상자 전환
    if (hfGroup) {
      hfGroup.style.display = isActive ? '' : 'none';
    }
    if (hfLabel) {
      hfLabel.textContent = (mode as string) === 'header' ? '머리말' : (mode as string) === 'footer' ? '꼬리말' : '';
    }
    defaultTbGroups.forEach((el) => {
      (el as HTMLElement).style.display = isActive ? 'none' : '';
    });
    // 서식 도구 모음은 머리말/꼬리말 편집 시에도 유지 (문단/글자 모양 설정 필요)
    // 본문 dimming
    if (scrollContainer) {
      if (isActive) {
        scrollContainer.classList.add('hf-editing');
      } else {
        scrollContainer.classList.remove('hf-editing');
      }
    }
  });

  // 문서 비교/이력관리 결과 탐색: 선택한 차이의 문단 위치로 커서/뷰를 이동한다.
  eventBus.on('compare:navigate-diff', (payload) => {
    if (!inputHandler) return;
    if (!wasm.hasLoadedDocument()) return;
    try {
      const item = payload as {
        severity?: 'added' | 'removed' | 'modified';
        path?: { section?: number; paragraph?: number };
        leftAnchor?: { pageIndex: number; x: number; y: number; width: number; height: number };
        rightAnchor?: { pageIndex: number; x: number; y: number; width: number; height: number };
      };

      // 현재 문서(오른쪽) 기준 탐색: rightAnchor 우선, 없으면 leftAnchor 사용.
      // 렌더 결과 좌표를 hitTest로 다시 문단 위치로 역매핑하면 "한 칸 밀림"을 크게 줄일 수 있다.
      const preferredAnchor = item.rightAnchor ?? item.leftAnchor;
      if (preferredAnchor) {
        const padX = Math.max(2, Math.floor(preferredAnchor.width * 0.15));
        const padY = Math.max(2, Math.floor(preferredAnchor.height * 0.35));
        const hit = wasm.hitTest(
          preferredAnchor.pageIndex,
          preferredAnchor.x + padX,
          preferredAnchor.y + padY,
        );
        if (hit && hit.sectionIndex >= 0 && hit.paragraphIndex >= 0) {
          inputHandler.moveCursorTo({
            sectionIndex: hit.sectionIndex,
            paragraphIndex: hit.paragraphIndex,
            charOffset: Math.max(0, hit.charOffset ?? 0),
          });
          (inputHandler as any).updateCaret?.();
          return;
        }
      }

      const section = item.path?.section;
      const paragraph = item.path?.paragraph;
      if (section == null || paragraph == null) return;
      inputHandler.moveCursorTo({
        sectionIndex: section,
        paragraphIndex: paragraph,
        charOffset: 0,
      });
      (inputHandler as any).updateCaret?.();
    } catch {
      // 비교 대상이 현재 문서 범위를 벗어나면 무시
    }
  });
}

/** 문서 초기화 공통 시퀀스 (loadFile, createNewDocument 양쪽에서 사용) */
async function initializeDocument(
  docInfo: DocumentInfo,
  displayName: string,
): Promise<{ warningCount: number; reflowedCount: number }> {
  sectionPageCache = null;
  const msg = sbMessage();
  let warningCount = 0;
  let reflowedCount = 0;
  try {
    debugFontResolution(docInfo);
    console.log('[initDoc] 1. 폰트 로딩 시작');
    let fontReport:
      | {
          loaded: number;
          failed: number;
          total: number;
          missingCriticalFonts: string[];
        }
      | undefined;
    if (docInfo.fontsUsed?.length) {
      fontReport = await loadWebFonts(docInfo.fontsUsed, (loaded, total) => {
        msg.textContent = `폰트 로딩 중... (${loaded}/${total})`;
      });
    }
    console.log('[initDoc] 2. 폰트 로딩 완료');
    // 폰트 로딩 완료 직후 조판을 재실행해 개체(표/그림/도형)의 페이지 이동 오차를 줄인다.
    try {
      wasm.refreshLayout();
    } catch (e) {
      console.warn('[initDoc] refreshLayout(초기) 실패:', e);
    }
    msg.textContent = displayName;
    totalSections = docInfo.sectionCount ?? 1;
    sbSection().textContent = `구역: 1 / ${totalSections}`;
    console.log('[initDoc] 3. inputHandler deactivate');
    inputHandler?.deactivate();
    console.log('[initDoc] 4. canvasView loadDocument');
    canvasView?.loadDocument();
    console.log('[initDoc] 5. toolbar setEnabled');
    toolbar?.setEnabled(true);
    console.log('[initDoc] 6. toolbar initStyleDropdown');
    toolbar?.initStyleDropdown();
    console.log('[initDoc] 7. inputHandler activateWithCaretPosition');
    inputHandler?.activateWithCaretPosition();
    console.log('[initDoc] 8. 완료');

    // FontFace 등록이 비동기로 안정화되는 동안 한 번 더 재조판/재렌더링해
    // 로드 직후 "다음 페이지로 밀림" 현상을 완화한다.
    try {
      await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
      await new Promise((resolve) => setTimeout(resolve, 60));
      wasm.refreshLayout();
      canvasView?.loadDocument();
    } catch (e) {
      console.warn('[initDoc] refreshLayout(지연) 실패:', e);
    }

    if (fontReport && fontReport.missingCriticalFonts.length > 0) {
      msg.textContent = `${displayName} (주의: 핵심 글꼴 누락 - 조판 오차 가능)`;
      console.warn('[FontLoader] 핵심 글꼴 누락:', fontReport.missingCriticalFonts);
    }

    // #177: lineseg 비표준/불완전 데이터는 도형/표 밀림의 직접 원인이 되므로
    // 사용자 선택 없이 자동 보정(reflow)한다.
    try {
      const report = wasm.getValidationWarnings();
      warningCount = report.count;
      console.log(`[validation] ${report.count} warnings`, report.summary);
      if (report.count > 0) {
        // 정책: lineseg 경고가 있는 문서는 "쪽 안정성 우선"으로 보수적 페이지네이션 강제.
        // 폰트 메트릭 미세 오차보다 쪽 밀림이 더 치명적이므로, vpos reset + legacy paginator를 함께 적용.
        wasm.setRespectVposReset(true);
        wasm.setUseLegacyPaginator(true);
        const n = wasm.reflowLinesegs();
        reflowedCount = n;
        console.log(`[validation] auto-reflowed ${n} paragraphs`);
        // 보정 후 즉시 재조판/재렌더링하여 페이지 밀림을 최소화
        wasm.refreshLayout();
        canvasView?.loadDocument();
        msg.textContent = `${displayName} (비표준 lineseg ${n}건 자동 보정됨)`;
      }
    } catch (e) {
      console.warn('[validation] 감지/보정 실패 (치명적이지 않음):', e);
    }
  } catch (error) {
    console.error('[initDoc] 오류:', error);
    if (window.innerWidth < 768) alert(`초기화 오류: ${error}`);
  }
  return { warningCount, reflowedCount };
}

async function loadFile(file: File): Promise<void> {
  const msg = sbMessage();
  try {
    msg.textContent = '파일 로딩 중...';
    const startTime = performance.now();
    const data = new Uint8Array(await file.arrayBuffer());
    await loadBytes(data, file.name, null, startTime);
  } catch (error) {
    showLoadError(error);
  }
}

async function loadBytes(
  data: Uint8Array,
  fileName: string,
  fileHandle: typeof wasm.currentFileHandle,
  startTime = performance.now(),
): Promise<void> {
  const docInfo = wasm.loadDocument(data, fileName);
  wasm.currentFileHandle = fileHandle;
  const elapsed = performance.now() - startTime;
  // initializeDocument 안에서 #177 validation 모달이 표시될 수 있음.
  // HWPX 토스트는 모달과의 이벤트 충돌을 피하기 위해 모달 닫힌 후 표시.
  const initResult = await initializeDocument(
    docInfo,
    `${fileName} — ${docInfo.pageCount}페이지 (${elapsed.toFixed(1)}ms)`,
  );

  // 구형 문서에서 lineseg 보정이 많이 발생하면 내부 저장 포맷으로 1회 정규화 재로드를 수행한다.
  // 사용자가 "다시 저장하면 맞아지는" 현상을 로드 단계에서 자동 적용해 조판 흔들림을 줄인다.
  if (initResult.reflowedCount > 0) {
    try {
      const normalizedBytes = wasm.exportHwp();
      const normalizedInfo = wasm.loadDocument(normalizedBytes, fileName);
      wasm.currentFileHandle = fileHandle;
      await initializeDocument(
        normalizedInfo,
        `${fileName} — 정규화 재로딩 (${normalizedInfo.pageCount}페이지)`,
      );
      console.log(`[initDoc] normalize round-trip applied (${initResult.reflowedCount} lineseg fixes)`);
    } catch (e) {
      console.warn('[initDoc] normalize round-trip skipped:', e);
    }
  }
  notifyHwpxBetaIfNeeded();
}

/**
 * #196: HWPX 출처 문서 로드 시 베타 안내 (저장 비활성화).
 * - 우상단 토스트 1회
 * - 상태 표시줄 메시지
 *
 * #197 (HWPX→HWP 완전 변환기) 완료 시 본 함수 제거.
 */
function notifyHwpxBetaIfNeeded(): void {
  if (wasm.getSourceFormat() !== 'hwpx') return;

  showToast({
    message: 'HWPX 형식은 현재 베타 단계라 직접 저장이 비활성화되어 있습니다.\n다음 업데이트에서 지원 예정입니다.',
    durationMs: 0, // 자동 페이드 없음 — 사용자가 확인 버튼으로 닫음
    action: {
      label: '자세히',
      onClick: () => {
        window.open('https://github.com/edwardkim/rhwp/issues/197', '_blank');
      },
    },
    confirmLabel: '확인',
  });

  const sb = sbMessage();
  if (sb) sb.textContent = 'HWPX 베타 모드 — 저장은 다음 업데이트에서 지원됩니다';
}

type DocumentByteKind = 'hwp' | 'hwpx' | 'html' | 'unknown';

const HWP_CFB_SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] as const;
const ZIP_SIGNATURES = [
  [0x50, 0x4B, 0x03, 0x04],
  [0x50, 0x4B, 0x05, 0x06],
  [0x50, 0x4B, 0x07, 0x08],
] as const;

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function detectDocumentByteKind(bytes: Uint8Array, contentType?: string | null): DocumentByteKind {
  if (startsWithBytes(bytes, HWP_CFB_SIGNATURE)) return 'hwp';
  if (ZIP_SIGNATURES.some(signature => startsWithBytes(bytes, signature))) return 'hwpx';

  const declaredContentType = contentType?.toLowerCase() ?? '';
  if (declaredContentType.includes('text/html')) return 'html';

  const prefix = new TextDecoder('utf-8')
    .decode(bytes.subarray(0, Math.min(bytes.length, 256)))
    .trimStart()
    .toLowerCase();

  if (prefix.startsWith('<!doctype') || prefix.startsWith('<html') || prefix.startsWith('<?xml')) {
    return 'html';
  }

  return 'unknown';
}

function assertRemoteDocumentBytes(bytes: Uint8Array, contentType?: string | null): void {
  const kind = detectDocumentByteKind(bytes, contentType);
  if (kind === 'hwp' || kind === 'hwpx') return;

  if (kind === 'html') {
    throw new Error('실제 HWP/HWPX 파일이 아닙니다. 파일 미리보기/오류 페이지가 반환되었습니다.');
  }

  throw new Error('실제 HWP/HWPX 파일이 아닙니다. 파일 시그니처를 확인할 수 없습니다.');
}

async function createNewDocument(): Promise<void> {
  const msg = sbMessage();
  try {
    msg.textContent = '새 문서 생성 중...';
    const docInfo = wasm.createNewDocument();
    await initializeDocument(docInfo, `새 문서.hwp — ${docInfo.pageCount}페이지`);
  } catch (error) {
    msg.textContent = `새 문서 생성 실패: ${error}`;
    console.error('[main] 새 문서 생성 실패:', error);
  }
}

// 커맨드에서 새 문서 생성 호출
eventBus.on('create-new-document', () => { createNewDocument(); });
eventBus.on('open-document-bytes', async (payload) => {
  const data = payload as {
    bytes: Uint8Array;
    fileName: string;
    fileHandle: typeof wasm.currentFileHandle;
    requestId?: string;
  };
  try {
    await loadBytes(data.bytes, data.fileName, data.fileHandle);
    eventBus.emit('open-document-bytes:done', { requestId: data.requestId, ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    eventBus.emit('open-document-bytes:done', { requestId: data.requestId, ok: false, error: msg });
    // #265: WASM 파서 에러 (예: HWP 3.0 미지원) 를 사용자에게 전파
    showLoadError(error);
  }
});

// 수식 더블클릭 → 수식 편집 대화상자
eventBus.on('equation-edit-request', () => {
  dispatcher.dispatch('insert:equation-edit');
});

/**
 * URL 파라미터(?url=)로 전달된 HWP 파일을 자동 로드한다.
 * Chrome 확장 프로그램에서 뷰어 탭을 열 때 사용.
 */
async function loadFromUrlParam(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const fileUrl = params.get('url');
  if (!fileUrl) return;

  const fileName = params.get('filename') || fileUrl.split('/').pop()?.split('?')[0] || 'document.hwp';
  const msg = sbMessage();

  try {
    msg.textContent = '파일 로딩 중...';
    console.log(`[loadFromUrlParam] ${fileUrl}`);

    let response: Response;

    // Chrome 확장 환경: Service Worker를 통한 CORS 우회 fetch
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        response = await fetch(fileUrl);
      } catch {
        // 직접 fetch 실패 시 Service Worker 프록시
        const result = await chrome.runtime.sendMessage({ type: 'fetch-file', url: fileUrl });
        if (result.error) throw new Error(result.error);
        const data = new Uint8Array(result.data);
        assertRemoteDocumentBytes(data);
        const docInfo = wasm.loadDocument(data, fileName);
        await initializeDocument(docInfo, `${fileName} — ${docInfo.pageCount}페이지`);
        return;
      }
    } else {
      response = await fetch(fileUrl);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const contentType = response.headers.get('content-type');
    const buffer = await response.arrayBuffer();
    const data = new Uint8Array(buffer);
    assertRemoteDocumentBytes(data, contentType);
    const docInfo = wasm.loadDocument(data, fileName);
    await initializeDocument(docInfo, `${fileName} — ${docInfo.pageCount}페이지`);
  } catch (error) {
    showLoadError(error);
  }
}

/**
 * 파일 로드 실패 시 사용자에게 에러를 명확히 알린다 (#265).
 *
 * 상태 표시줄은 22px 한 줄로 긴 에러 메시지가 ellipsis 로 잘리므로,
 * 우상단 토스트 (긴 메시지 줄바꿈 지원 · 사용자 닫기 · action 링크) 를
 * 병행 사용한다.
 */
function showLoadError(error: unknown): void {
  const raw = String(error).replace(/^Error:\s*/, '');
  const errMsg = `파일 로드 실패: ${raw}`;
  const sb = sbMessage();
  if (sb) sb.textContent = errMsg;
  console.error('[main] 파일 로드 실패:', error);
  showToast({
    message: errMsg,
    durationMs: 0, // 에러는 자동 페이드 없음 — 사용자가 읽고 닫기
    confirmLabel: '확인',
  });
}

initialize();

// ── iframe 연동 API (postMessage) ──
// 부모 페이지에서 postMessage로 에디터를 제어할 수 있다.
// 요청: { type: 'rhwp-request', id, method, params }
// 응답: { type: 'rhwp-response', id, result?, error? }
window.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  // 기존 hwpctl-load 호환
  if (msg.type === 'hwpctl-load' && msg.data) {
    try {
      const bytes = new Uint8Array(msg.data);
      const docInfo = wasm.loadDocument(bytes, msg.fileName || 'document.hwp');
      await initializeDocument(docInfo, `${msg.fileName || 'document'} — ${docInfo.pageCount}페이지`);
      e.source?.postMessage({ type: 'rhwp-response', id: msg.id, result: { pageCount: docInfo.pageCount } }, { targetOrigin: '*' });
    } catch (err: any) {
      e.source?.postMessage({ type: 'rhwp-response', id: msg.id, error: err.message || String(err) }, { targetOrigin: '*' });
    }
    return;
  }

  // rhwp-request: 범용 API
  if (msg.type !== 'rhwp-request' || !msg.method) return;
  const { id, method, params } = msg;
  const reply = (result?: any, error?: string) => {
    e.source?.postMessage({ type: 'rhwp-response', id, result, error }, { targetOrigin: '*' });
  };

  try {
    switch (method) {
      case 'loadFile': {
        const bytes = new Uint8Array(params.data);
        const docInfo = wasm.loadDocument(bytes, params.fileName || 'document.hwp');
        await initializeDocument(docInfo, `${params.fileName || 'document'} — ${docInfo.pageCount}페이지`);
        reply({ pageCount: docInfo.pageCount });
        break;
      }
      case 'pageCount':
        reply(wasm.pageCount);
        break;
      case 'getPageSvg':
        reply(wasm.renderPageSvg(params.page ?? 0));
        break;
      case 'exportHwp':
        reply(Array.from(wasm.exportHwp()));
        break;
      case 'ready':
        reply(true);
        break;
      default:
        reply(undefined, `Unknown method: ${method}`);
    }
  } catch (err: any) {
    reply(undefined, err.message || String(err));
  }
});
