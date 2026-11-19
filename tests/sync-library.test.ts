import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSyncDiagnostic,
  syncDouyinLibrary,
  type CaptureBatchResult,
  type CapturePage,
  type SyncCheckpoint,
} from '../src/mobile/sync-library.ts';
import type { LibraryImport } from '../src/library-format.ts';
import {
  appendSyncLog,
  clearSyncLog,
  hydrateSyncLog,
  readSyncLogLines,
  readSyncLogText,
  sanitizeBodyPreview,
  subscribeSyncLog,
} from '../src/mobile/sync-log.ts';

function page(ids: string[], opts?: { hasMore?: number; cursor?: string }): string {
  return JSON.stringify({
    status_code: 0,
    has_more: opts?.hasMore ?? 0,
    max_cursor: opts?.cursor ?? '0',
    aweme_list: ids.map((id) => ({
      aweme_id: id,
      desc: `video ${id}`,
      create_time: 1690000000,
      author: { nickname: 'a' },
      video: { cover: { url_list: ['https://p3.douyinpic.com/c.jpeg'] } },
    })),
  });
}

test('syncDouyinLibrary captures likes/favourites pages, dedupes and merges them', async () => {
  const captured: string[] = [];
  const capture = async (kind: 'likes' | 'favorites'): Promise<CapturePage[]> => {
    captured.push(kind);
    if (kind === 'likes') {
      return [
        { status: 200, body: page(['7300000000000000001', '7300000000000000002']) },
        { status: 200, body: page(['7300000000000000002', '7300000000000000003']) },
      ];
    }
    return [{ status: 200, body: page(['7400000000000000001']) }];
  };

  const imports: LibraryImport[] = [];
  const result = await syncDouyinLibrary(capture, async (file) => { imports.push(file); });

  assert.deepEqual(result, { liked: 3, saved: 1 });
  assert.deepEqual(captured, ['likes', 'favorites']);
  assert.equal(imports.length, 2);
  assert.equal(imports[0].source, 'likes');
  assert.equal(imports[0].works.length, 3);
  assert.equal(imports[1].source, 'favorites');
  assert.equal(imports[1].works.length, 1);
});

test('syncDouyinLibrary surfaces a 403 Sign Invalid body as a rejection', async () => {
  const capture = async (kind: 'likes' | 'favorites'): Promise<CapturePage[]> => {
    if (kind === 'likes') return [{ status: 403, body: JSON.stringify({ status_code: 0, status_msg: 'Blocked by ArgusSecurityPlugin Sign Invalid' }) }];
    return [{ status: 200, body: page(['1']) }];
  };
  await assert.rejects(() => syncDouyinLibrary(capture, async () => {}), /被拒绝/);
});

test('syncDouyinLibrary refuses when nothing was captured', async () => {
  const capture = async (): Promise<CapturePage[]> => [];
  await assert.rejects(() => syncDouyinLibrary(capture, async () => {}), /没有捕获到/);
});

test('syncDouyinLibrary supports separate likes/favorites sync and full end-to-end scan', async () => {
  const calls: Array<{ kind: 'likes' | 'favorites'; maxScrolls?: number; timeoutMs?: number }> = [];
  const capture = async (kind: 'likes' | 'favorites', options?: { maxScrolls?: number; timeoutMs?: number }): Promise<CapturePage[]> => {
    calls.push({ kind, maxScrolls: options?.maxScrolls, timeoutMs: options?.timeoutMs });
    return [{ status: 200, body: page([kind === 'likes' ? '7300000000000000010' : '7400000000000000020']) }];
  };
  const imports: LibraryImport[] = [];

  const likesOnly = await syncDouyinLibrary(capture, async (file) => { imports.push(file); }, undefined, undefined, 'full', 'likes');
  assert.deepEqual(likesOnly, { liked: 1, saved: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'likes');
  assert.equal(calls[0].maxScrolls, 1500);
  assert.equal(calls[0].timeoutMs, 900_000);

  const favOnly = await syncDouyinLibrary(capture, async (file) => { imports.push(file); }, undefined, undefined, 'top', 'favorites');
  assert.deepEqual(favOnly, { liked: 0, saved: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].kind, 'favorites');
  assert.equal(calls[1].maxScrolls, 4);
});

test('syncDouyinLibrary flushes batches incrementally and saves resumable checkpoint + diagnostic', async () => {
  const checkpoints: SyncCheckpoint[] = [];
  const imports: LibraryImport[] = [];

  // 12 pages interrupted at page 12 with rate_limit while has_more=1 and cursor=1700000000999
  const capture = async (kind: 'likes' | 'favorites', options?: { onPage?: (p: CapturePage) => void; resumeCursor?: string | null; mode?: string }): Promise<CaptureBatchResult> => {
    const pages: CapturePage[] = [];
    for (let i = 1; i <= 12; i++) {
      const p: CapturePage = {
        status: 200,
        engine: 'direct',
        cursor: i === 1 ? '0' : `17000000000${i - 1}`,
        body: page([`7300000000000000${String(i).padStart(3, '0')}`], { hasMore: 1, cursor: `1700000000${String(i).padStart(3, '0')}` }),
      };
      pages.push(p);
      options?.onPage?.(p);
    }
    return {
      pages,
      diagnostic: {
        reason: 'rate_limit',
        engine: 'direct',
        pages: 12,
        hasMore: true,
        nextCursor: '1700000000012',
        lastStatus: 429,
        elapsedMs: 4200,
      },
    };
  };

  const firstRun = await syncDouyinLibrary(
    capture,
    async (file) => { imports.push(file); },
    undefined,
    undefined,
    'full',
    'likes',
    { onCheckpoint: (cp) => { checkpoints.push(cp); } },
  );

  assert.equal(firstRun.liked, 12);
  // Flushed at page 10 (10 items) + final flush (2 items)
  assert.equal(imports.length, 2);
  assert.equal(imports[0].works.length, 10);
  assert.equal(imports[1].works.length, 2);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].resumeCursor, '1700000000012');
  assert.equal(checkpoints[0].receivedCount, 12);
  assert.equal(checkpoints[0].diagnostic.reason, 'rate_limit');
  assert.ok(formatSyncDiagnostic(checkpoints[0].diagnostic).includes('直连分页'));

  // 'top' mode must preserve existing deeper resumeCursor while updating diagnostic
  let seenResumeInTop: string | null | undefined;
  await syncDouyinLibrary(
    async (_k, opts) => {
      seenResumeInTop = opts?.resumeCursor;
      const p: CapturePage = { status: 200, engine: 'scroll', body: page(['7300000000000000999'], { hasMore: 1, cursor: '1700000000900' }) };
      opts?.onPage?.(p);
      return { pages: [p], diagnostic: { reason: 'top_done', engine: 'scroll', hasMore: true, nextCursor: '1700000000900' } };
    },
    async () => {},
    undefined,
    undefined,
    'top',
    'likes',
    { previousCheckpoint: { likes: checkpoints[0] }, onCheckpoint: (cp) => { checkpoints.push(cp); } },
  );
  assert.equal(seenResumeInTop ?? null, null);
  assert.equal(checkpoints[1].resumeCursor, '1700000000012');

  // 'resume' mode forwards resumeCursor and clears it once has_more=0 completes
  let seenResumeCursor: string | null | undefined;
  await syncDouyinLibrary(
    async (_k, opts) => {
      seenResumeCursor = opts?.resumeCursor;
      const p: CapturePage = { status: 200, engine: 'direct', cursor: opts?.resumeCursor ?? '', body: page(['7300000000000000013'], { hasMore: 0, cursor: '0' }) };
      opts?.onPage?.(p);
      return { pages: [p], diagnostic: { reason: 'completed', engine: 'direct', hasMore: false, nextCursor: null } };
    },
    async () => {},
    undefined,
    undefined,
    'resume',
    'likes',
    {
      resumeCursor: { likes: checkpoints[0].resumeCursor },
      previousCheckpoint: { likes: checkpoints[0] },
      onCheckpoint: (cp) => { checkpoints.push(cp); },
    },
  );
  assert.equal(seenResumeCursor, '1700000000012');
  assert.equal(checkpoints[2].resumeCursor, null);
  assert.equal(checkpoints[2].receivedCount, 13);
  assert.equal(checkpoints[2].diagnostic.reason, 'completed');
});

test('syncDouyinLibrary preserves captcha/detail diagnostics on empty capture and surfaces detail text', async () => {
  const checkpoints: SyncCheckpoint[] = [];
  await assert.rejects(
    () => syncDouyinLibrary(
      async () => ({
        pages: [],
        diagnostic: {
          reason: 'captcha',
          engine: 'scroll',
          pages: 0,
          hasMore: null,
          nextCursor: '1612187334000',
          elapsedMs: 18_000,
          detail: '触发安全验证(验证码)',
        },
      }),
      async () => {},
      undefined,
      undefined,
      'resume',
      'likes',
      {
        resumeCursor: { likes: '1612187334000' },
        onCheckpoint: (cp) => { checkpoints.push(cp); },
      },
    ),
    /触发安全验证/,
  );
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].resumeCursor, '1612187334000');
  assert.equal(checkpoints[0].diagnostic.reason, 'captcha');
  const formatted = formatSyncDiagnostic(checkpoints[0].diagnostic);
  assert.ok(formatted.includes('触发安全验证(验证码)'));
});

test('sync-log ring buffer caps at 150 lines, hydrates persisted state, and notifies subscribers', () => {
  clearSyncLog();
  let notifications = 0;
  const unsub = subscribeSyncLog(() => { notifications += 1; });

  for (let i = 1; i <= 165; i += 1) {
    appendSyncLog(`line ${i}`);
  }
  const lines = readSyncLogLines();
  assert.equal(lines.length, 150);
  assert.ok(lines[0].endsWith('line 16'));
  assert.ok(lines[149].endsWith('line 165'));
  assert.equal(notifications, 165);

  unsub();
  clearSyncLog();
  assert.equal(readSyncLogLines().length, 0);

  hydrateSyncLog(JSON.stringify('[10:00:00.000] first\n[10:00:01.000] second'));
  assert.deepEqual(readSyncLogLines(), ['[10:00:00.000] first', '[10:00:01.000] second']);
  // Does not overwrite non-empty in-memory logs
  hydrateSyncLog('ignored');
  assert.equal(readSyncLogLines().length, 2);
  assert.ok(readSyncLogText().includes('second'));

  clearSyncLog();
  assert.equal(sanitizeBodyPreview('  hello\n\tworld   test  ', 12), 'hello world');
});
