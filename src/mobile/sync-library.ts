import { parseVideoItems, parseVideoList, CommentReadError, type VideoItem } from '../douyin-bridge.ts';
import type { LibraryImport, LibraryWork } from '../library-format.ts';
import { appendSyncLog, clearSyncLog } from './sync-log.ts';

// The likes / favourites lists are Argus-protected private endpoints: their
// requests must be signed by Douyin's own page SDK. We load the logged-in
// Douyin page, capture its signed request template, then prefer in-page direct
// cursor pagination (zero DOM growth, instant cursor resume) and fall back to
// DOM-slimming scroll capture whenever direct requests are rejected.
export type SyncStopReason =
  | 'completed'
  | 'top_done'
  | 'idle_timeout'
  | 'total_timeout'
  | 'scroll_limit'
  | 'rate_limit'
  | 'captcha'
  | 'auth'
  | 'restricted'
  | 'cancelled'
  | 'error';

export type SyncEngine = 'direct' | 'scroll' | 'mixed';

export type CapturePage = {
  status: number;
  body: string;
  cursor?: string;
  engine?: 'direct' | 'scroll';
};

export type CaptureDiagnostic = {
  reason: SyncStopReason;
  engine: SyncEngine;
  pages: number;
  hasMore: boolean | null;
  nextCursor: string | null;
  lastStatus: number | null;
  lastStatusCode: string;
  elapsedMs: number;
  detail: string;
};

export type CaptureBatchResult = {
  pages: CapturePage[];
  diagnostic?: Partial<CaptureDiagnostic>;
};

export type CaptureMode = 'top' | 'down' | 'full' | 'resume';
export type SyncTarget = 'likes' | 'favorites' | 'both';
export type CaptureOptions = {
  onPage?: (page: CapturePage) => void;
  maxScrolls?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  resumeCursor?: string | null;
  mode?: CaptureMode;
};
export type CaptureCollection = (
  kind: 'likes' | 'favorites',
  options?: CaptureOptions,
) => Promise<CapturePage[] | CaptureBatchResult>;

export type SyncProgress = {
  stage: 'likes' | 'favorites';
  received: number;
  pages: number;
  engine?: 'direct' | 'scroll';
  cursor?: string | null;
};

export type SyncDiagnostic = {
  kind: 'likes' | 'favorites';
  engine: SyncEngine;
  reason: SyncStopReason;
  pages: number;
  items: number;
  hasMore: boolean | null;
  nextCursor: string | null;
  lastStatus: number | null;
  lastStatusCode: string;
  elapsedMs: number;
  avgPageMs: number;
  detail: string;
  at: number;
};

export type SyncCheckpoint = {
  kind: 'likes' | 'favorites';
  resumeCursor: string | null;
  receivedCount: number;
  diagnostic: SyncDiagnostic;
  updatedAt: number;
};

export type SyncExtras = {
  resumeCursor?: { likes?: string | null; favorites?: string | null };
  onCheckpoint?: (checkpoint: SyncCheckpoint) => void | Promise<void>;
  previousCheckpoint?: { likes?: SyncCheckpoint | null; favorites?: SyncCheckpoint | null };
};

const FLUSH_EVERY_PAGES = 10;

function toLibraryWork(item: VideoItem, index: number): LibraryWork {
  return {
    id: item.id,
    title: item.title,
    author: item.author,
    publishedAt: item.publishedAt,
    kind: item.kind,
    coverUrl: item.coverUrl,
    sourceOrder: index,
  };
}

function makeLibraryImport(
  kind: 'likes' | 'favorites',
  items: readonly VideoItem[],
  exportedAt: number,
  orderBase = 0,
): LibraryImport {
  return {
    version: 3,
    exportedAt,
    source: kind,
    sourceLabel: kind === 'likes' ? '抖音点赞' : '抖音收藏',
    works: items.map((item, idx) => toLibraryWork(item, orderBase + idx)),
    folders: [],
    duplicateRows: 0,
  };
}

function classifyFailure(failure: unknown): { reason: SyncStopReason; statusCode: string; detail: string } {
  if (failure instanceof CommentReadError) {
    const codeMatch = failure.message.match(/status_code=([^，,\s）)]+)/);
    const statusCode = codeMatch ? codeMatch[1] : '';
    if (failure.code === 'auth') return { reason: 'auth', statusCode, detail: failure.message };
    if (failure.code === 'restricted') {
      const isRate = failure.message.includes('429') || failure.message.includes('过于频繁');
      return { reason: isRate ? 'rate_limit' : 'restricted', statusCode, detail: failure.message };
    }
    if (failure.code === 'timeout') return { reason: 'idle_timeout', statusCode, detail: failure.message };
    return { reason: 'error', statusCode, detail: failure.message };
  }
  const msg = failure instanceof Error ? failure.message : String(failure ?? '未知错误');
  if (/取消/.test(msg)) return { reason: 'cancelled', statusCode: '', detail: msg };
  return { reason: 'error', statusCode: '', detail: msg };
}

export function formatSyncReason(reason: SyncStopReason, diagnostic?: Partial<SyncDiagnostic>): string {
  switch (reason) {
    case 'completed':
      if (diagnostic?.items && diagnostic.items >= 2500 && diagnostic.hasMore === false) {
        return '接口返回 has_more=0（已到底或平台列表在该数量处截断）';
      }
      return '接口返回 has_more=0（已完整扫到底）';
    case 'top_done':
      return '已完成顶部最新页扫描';
    case 'idle_timeout':
      return '等待下一页超时（页面卡顿或响应过慢），可从断点继续';
    case 'total_timeout':
      return '达到单次同步最大时长上限，可从断点继续';
    case 'scroll_limit':
      return '达到单次最大翻页次数上限，可从断点继续';
    case 'rate_limit':
      return '触发抖音限频（429 / 请求过快），可稍后从断点继续';
    case 'captcha':
      return '触发抖音安全验证/滑块，请在弹出的验证页完成后重试';
    case 'auth':
      return '抖音登录状态失效，重新登录后可继续';
    case 'restricted':
      return '抖音接口风控拦截（返回非 0 状态或 403）';
    case 'cancelled':
      return '已手动取消，已抓数据已保留';
    case 'error':
      return '同步过程中发生网络或解析异常';
  }
}

export function formatSyncDiagnostic(diag: SyncDiagnostic): string {
  const engineLabel = diag.engine === 'direct' ? '直连分页' : diag.engine === 'mixed' ? '直连+滚动' : '页面滚动';
  const secs = Math.max(1, Math.round(diag.elapsedMs / 1000));
  const cursorText = diag.nextCursor ? `，断点游标 ${diag.nextCursor}` : '';
  const statusText = diag.lastStatus ? `，HTTP ${diag.lastStatus}${diag.lastStatusCode ? `/code=${diag.lastStatusCode}` : ''}` : '';
  const reasonText = formatSyncReason(diag.reason, diag);
  const rawDetail = (diag.detail || '').trim();
  const detailText = rawDetail && rawDetail !== reasonText && !reasonText.includes(rawDetail)
    ? ` | ${rawDetail.slice(0, 140)}`
    : '';
  return `${engineLabel} · ${diag.pages} 页 / ${diag.items} 条 · ${secs}s${statusText}${cursorText} · ${reasonText}${detailText}`;
}

async function collectFromCapture(
  capture: CaptureCollection,
  importCollection: (file: LibraryImport) => Promise<unknown>,
  kind: 'likes' | 'favorites',
  onProgress?: (value: SyncProgress) => void,
  mode: CaptureMode = 'down',
  resumeCursor: string | null = null,
  previousCheckpoint: SyncCheckpoint | null = null,
  onCheckpoint?: (checkpoint: SyncCheckpoint) => void | Promise<void>,
): Promise<{ items: VideoItem[]; alreadyFlushed: number; checkpoint: SyncCheckpoint }> {
  const startedAt = Date.now();
  const exportedAt = startedAt;
  let pages = 0;
  let flushedCount = 0;
  let lastValidCursor: string | null = resumeCursor;
  let lastHasMore: boolean | null = null;
  let lastStatus: number | null = null;
  let lastStatusCode = '';
  let lastError: unknown = null;
  let usedDirect = false;
  let usedScroll = false;

  const liveSeen = new Set<string>();
  const allItems: VideoItem[] = [];
  let pendingBatch: VideoItem[] = [];
  let importChain = Promise.resolve();

  const enqueueFlush = (force = false) => {
    if (!pendingBatch.length) return;
    if (!force && pendingBatch.length < FLUSH_EVERY_PAGES * 15) return;
    const batch = pendingBatch;
    pendingBatch = [];
    const orderBase = flushedCount;
    flushedCount += batch.length;
    importChain = importChain.then(async () => { await importCollection(makeLibraryImport(kind, batch, exportedAt, orderBase)); });
  };

  const maxScrolls = mode === 'top' ? 4 : (mode === 'full' || mode === 'resume') ? 1500 : 70;
  const timeoutMs = mode === 'top' ? 55_000 : (mode === 'full' || mode === 'resume') ? 900_000 : 120_000;
  const idleTimeoutMs = mode === 'top' ? 9_000 : (mode === 'full' || mode === 'resume') ? 25_000 : 14_000;

  let rawResult: CapturePage[] | CaptureBatchResult;
  let captureFailure: unknown = null;

  try {
    rawResult = await capture(kind, {
      maxScrolls,
      timeoutMs,
      idleTimeoutMs,
      resumeCursor,
      mode,
      onPage: (page) => {
        pages += 1;
        lastStatus = page.status;
        if (page.engine === 'direct') usedDirect = true;
        else usedScroll = true;
        try {
          const parsed = parseVideoList(page.body, page.cursor ?? '', page.status);
          lastStatusCode = '0';
          lastHasMore = parsed.hasMore;
          if (parsed.nextCursor) lastValidCursor = parsed.nextCursor;
          for (const item of parsed.items) {
            if (!liveSeen.has(item.id)) {
              liveSeen.add(item.id);
              allItems.push(item);
              pendingBatch.push(item);
            }
          }
          if (pages % FLUSH_EVERY_PAGES === 0) enqueueFlush(true);
        } catch (err) {
          // If pagination check failed (e.g. missing has_more on a partial mock) fall back to parseVideoItems.
          try {
            const fallbackItems = parseVideoItems(page.body, page.status);
            for (const item of fallbackItems) {
              if (!liveSeen.has(item.id)) {
                liveSeen.add(item.id);
                allItems.push(item);
                pendingBatch.push(item);
              }
            }
            if (pages % FLUSH_EVERY_PAGES === 0) enqueueFlush(true);
          } catch (itemErr) {
            lastError = itemErr ?? err;
            const classified = classifyFailure(lastError);
            if (classified.statusCode) lastStatusCode = classified.statusCode;
          }
        }
        onProgress?.({
          stage: kind,
          received: liveSeen.size,
          pages,
          engine: page.engine,
          cursor: lastValidCursor,
        });
      },
    });
  } catch (err) {
    captureFailure = err;
    rawResult = { pages: [] };
  }

  const captured = Array.isArray(rawResult) ? rawResult : rawResult.pages;
  const externalDiag = Array.isArray(rawResult) ? undefined : rawResult.diagnostic;

  // Authoritative pass over returned pages in case onPage wasn't called by a mock or skipped rows.
  if (captured.length && !allItems.length) {
    for (const page of captured) {
      pages = Math.max(pages, captured.length);
      lastStatus = page.status;
      if (page.engine === 'direct') usedDirect = true;
      else usedScroll = true;
      try {
        const parsed = parseVideoList(page.body, page.cursor ?? '', page.status);
        lastStatusCode = '0';
        lastHasMore = parsed.hasMore;
        if (parsed.nextCursor) lastValidCursor = parsed.nextCursor;
        for (const item of parsed.items) {
          if (!liveSeen.has(item.id)) {
            liveSeen.add(item.id);
            allItems.push(item);
            pendingBatch.push(item);
          }
        }
      } catch (err) {
        try {
          const list = parseVideoItems(page.body, page.status);
          for (const item of list) {
            if (!liveSeen.has(item.id)) {
              liveSeen.add(item.id);
              allItems.push(item);
              pendingBatch.push(item);
            }
          }
        } catch (itemErr) {
          lastError = itemErr ?? err;
        }
      }
    }
  }

  // Always flush any already-captured pages before throwing or returning.
  enqueueFlush(true);
  await importChain;

  const elapsedMs = Math.max(1, externalDiag?.elapsedMs ?? (Date.now() - startedAt));
  const totalPages = Math.max(pages, externalDiag?.pages ?? 0);
  const engine: SyncEngine = externalDiag?.engine ?? (usedDirect && usedScroll ? 'mixed' : usedDirect ? 'direct' : 'scroll');

  let reason: SyncStopReason = externalDiag?.reason ?? 'completed';
  let detail = externalDiag?.detail ?? '';
  if (captureFailure) {
    const classified = classifyFailure(captureFailure);
    reason = classified.reason;
    if (classified.statusCode) lastStatusCode = classified.statusCode;
    detail = classified.detail;
  } else if (!externalDiag?.reason) {
    if (mode === 'top' && totalPages >= 4 && lastHasMore !== false) reason = 'top_done';
    else if (lastError && !allItems.length) {
      const classified = classifyFailure(lastError);
      reason = classified.reason;
      detail = classified.detail;
    } else if (lastHasMore === false) {
      reason = 'completed';
    } else if (lastHasMore === true) {
      reason = mode === 'top' ? 'top_done' : 'idle_timeout';
    }
  }

  const finalHasMore = externalDiag?.hasMore ?? lastHasMore;
  const finalCursor = externalDiag?.nextCursor ?? (finalHasMore === false ? null : lastValidCursor);

  const diagnostic: SyncDiagnostic = {
    kind,
    engine,
    reason,
    pages: totalPages,
    items: allItems.length,
    hasMore: finalHasMore,
    nextCursor: finalCursor,
    lastStatus: externalDiag?.lastStatus ?? lastStatus,
    lastStatusCode: externalDiag?.lastStatusCode || lastStatusCode,
    elapsedMs,
    avgPageMs: totalPages > 0 ? Math.round(elapsedMs / totalPages) : 0,
    detail: detail || formatSyncReason(reason, { items: allItems.length, hasMore: finalHasMore }),
    at: Date.now(),
  };

  // Preserve deeper cursor when running 'top'; clear cursor only when a non-top run truly finished (has_more=0).
  const nextResumeCursor = mode === 'top'
    ? (previousCheckpoint?.resumeCursor ?? null)
    : finalHasMore === false
      ? null
      : finalCursor;

  const checkpoint: SyncCheckpoint = {
    kind,
    resumeCursor: nextResumeCursor,
    receivedCount: mode === 'resume' ? (previousCheckpoint?.receivedCount ?? 0) + allItems.length : allItems.length,
    diagnostic,
    updatedAt: Date.now(),
  };
  await onCheckpoint?.(checkpoint);
  appendSyncLog(`checkpoint kind=${kind} ${formatSyncDiagnostic(diagnostic)}`);

  if (captureFailure) throw captureFailure;

  if (!captured.length) {
    if (externalDiag?.reason === 'cancelled') throw new Error('已取消更新。');
    if (externalDiag?.reason === 'captcha') {
      throw new CommentReadError('restricted', diagnostic.detail || '抖音触发了安全验证，请完成验证后重试。');
    }
    if (externalDiag?.reason === 'auth') {
      throw new CommentReadError('auth', diagnostic.detail || '登录状态已失效，请重新登录抖音。');
    }
    if (externalDiag?.detail) {
      throw new CommentReadError('empty', externalDiag.detail);
    }
    throw new CommentReadError('empty', kind === 'likes'
      ? '没有捕获到“我的喜欢”数据，请确认已登录抖音后重试。'
      : '没有捕获到“我的收藏”数据，请确认已登录抖音后重试。');
  }
  if (!allItems.length && lastError) throw lastError;

  return { items: allItems, alreadyFlushed: flushedCount, checkpoint };
}

export type SyncResult = { liked: number; saved: number };

export async function syncDouyinLibrary(
  captureCollection: CaptureCollection,
  importCollection: (file: LibraryImport) => Promise<unknown>,
  onProgress?: (value: SyncProgress) => void,
  shouldStop?: () => boolean,
  mode: CaptureMode = 'down',
  target: SyncTarget = 'both',
  extras?: SyncExtras,
): Promise<SyncResult> {
  clearSyncLog();
  appendSyncLog(`syncDouyinLibrary start mode=${mode} target=${target} resumeLikes=${extras?.resumeCursor?.likes ?? '-'} resumeFavs=${extras?.resumeCursor?.favorites ?? '-'}`);
  let liked = 0;
  let saved = 0;

  if (target !== 'favorites') {
    const res = await collectFromCapture(
      captureCollection,
      importCollection,
      'likes',
      onProgress,
      mode,
      extras?.resumeCursor?.likes ?? null,
      extras?.previousCheckpoint?.likes ?? null,
      extras?.onCheckpoint,
    );
    liked = res.items.length;
  }
  if (shouldStop?.()) throw new Error('已取消更新。');

  if (target !== 'likes') {
    const res = await collectFromCapture(
      captureCollection,
      importCollection,
      'favorites',
      onProgress,
      mode,
      extras?.resumeCursor?.favorites ?? null,
      extras?.previousCheckpoint?.favorites ?? null,
      extras?.onCheckpoint,
    );
    saved = res.items.length;
  }
  if (shouldStop?.()) throw new Error('已取消更新。');

  return { liked, saved };
}
