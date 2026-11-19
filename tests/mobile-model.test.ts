import { deepEqual, equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { mobileSchema, parsePreferences, parseSession, queueQuery, restoreSession, shuffled, swipeStep, whereScope, workSelect } from '../src/mobile/model.ts';
import { compactRangeSelection, expandRangeSelection, formatRangeSummary, recentMonthTokens } from '../src/mobile/range-helpers.ts';

test('local overrides survive reimport, remain independent, and do not remove all works', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE library_works(id TEXT PRIMARY KEY,title TEXT,author TEXT,published_at INTEGER,kind TEXT,cover_url TEXT,source_order INTEGER);
      CREATE TABLE library_memberships(source TEXT,work_id TEXT,PRIMARY KEY(source,work_id));CREATE TABLE library_folder_works(folder_id TEXT,work_id TEXT);${mobileSchema}`);
    db.exec("INSERT INTO library_works VALUES('7637322941528689935','a','user',0,'video',NULL,NULL);INSERT INTO library_memberships VALUES('likes','7637322941528689935');");
    const result = (source: 'all' | 'likes' | 'favorites') => { const q = whereScope({ source }); return db.prepare(`${workSelect} ${q.where}`).all(...q.values); };
    equal(result('likes').length, 1); equal(result('favorites').length, 0);
    db.exec("INSERT INTO mobile_marks VALUES('7637322941528689935',0,1);INSERT OR IGNORE INTO library_memberships VALUES('likes','7637322941528689935');");
    equal(result('likes').length, 0); equal(result('favorites').length, 1); equal(result('all').length, 1);
    equal(db.prepare('SELECT count(*) n FROM library_memberships').get()?.n, 1);
  } finally { db.close(); }
});
test('queue restore keeps the snapshot, ignores new imports, and repairs a missing current work', () => {
  const saved = JSON.stringify({ ids: ['1','2','3'], index: 1, mode: 'shuffle', point: { kind: 'video', value: 12 } });
  deepEqual(restoreSession(saved, ['1','2','3','4'], 'shuffle'), { ids: ['1','2','3'], index: 1, mode: 'shuffle', point: { kind: 'video', value: 12 } });
  deepEqual(restoreSession(saved, ['1','3','4'], 'shuffle'), { ids: ['1','3'], index: 0, mode: 'shuffle', point: null });
  equal(parseSession('{"ids":["1","1"],"index":0,"mode":"shuffle"}'), null);
});
test('shuffling does not repeat within a round or at the round boundary', () => {
  const ids = ['1','2','3','2']; const result = shuffled(ids, '1', () => 0.999);
  equal(result.length, 3); equal(new Set(result).size, 3); equal(result[0] === '1', false);
  deepEqual(shuffled(['1'], '1'), ['1']);
});
test('date filtering binds Beijing month bounds and treats search as literal text', () => {
  const q = whereScope({ source: 'all', search: "%' OR 1=1", period: { year: 2024, month: 2 }, filter: 'gallery' });
  equal(q.where.includes("%' OR"), false);
  deepEqual(q.values, ["%' OR 1=1", "%' OR 1=1", Date.parse('2024-01-31T16:00:00Z'), Date.parse('2024-02-29T16:00:00Z')]);
  equal(whereScope({ source: 'all', period: 'unknown' }).where.includes('IS NULL'), true);
});
test('cancelled short drags and opposite flicks do not advance; malformed preferences recover', () => {
  equal(swipeStep(0, 0, 0), 0);
  equal(swipeStep(20, 1200, 800), 0); equal(swipeStep(-50, 900, 800), 0); equal(swipeStep(-50, -900, 800), 1); equal(swipeStep(300, 0, 800), -1);
  deepEqual(parsePreferences('{"rate":100,"auto":true,"clear":false}'), {
    rate: 1, auto: true, clear: false,
    danmaku: false, danmakuOpacity: 80, danmakuFontSize: 16, danmakuSpeed: 1, danmakuLines: 6,
    commentTheme: 'dark', bottomOffset: 0, meBottomOffset: 0,
    seekOffset: 0, captionOffset: 0, toolbarOffset: 0,
    detailSeekOffset: 28, detailCaptionOffset: 28, detailToolbarOffset: 28,
    homeRanges: {},
  });
  deepEqual(parsePreferences('{"seekOffset":-99,"detailSeekOffset":999,"detailCaptionOffset":42,"toolbarOffset":18,"homeRanges":{"all":["2025","2024-02","bad","unknown"],"likes":["2026-13"]}}'), {
    rate: 1, auto: false, clear: false,
    danmaku: false, danmakuOpacity: 80, danmakuFontSize: 16, danmakuSpeed: 1, danmakuLines: 6,
    commentTheme: 'dark', bottomOffset: 0, meBottomOffset: 0,
    seekOffset: -20, captionOffset: 0, toolbarOffset: 18,
    detailSeekOffset: 120, detailCaptionOffset: 42, detailToolbarOffset: 28,
    homeRanges: { all: ['2025', '2024-02', 'unknown'] },
  });
});

test('multi-year/month home range filtering and compact selection helpers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE library_works(id TEXT PRIMARY KEY,title TEXT,author TEXT,published_at INTEGER,kind TEXT,cover_url TEXT,source_order INTEGER);
      CREATE TABLE library_memberships(source TEXT,work_id TEXT,PRIMARY KEY(source,work_id));CREATE TABLE library_folder_works(folder_id TEXT,work_id TEXT);${mobileSchema}`);
    const insert = db.prepare('INSERT INTO library_works VALUES(?,?,?,?,?,?,?)');
    insert.run('1', 'w2023', 'a', Date.parse('2023-06-15T10:00:00Z'), 'video', null, null);
    insert.run('2', 'w2024-02', 'a', Date.parse('2024-02-10T10:00:00Z'), 'video', null, null);
    insert.run('3', 'w2024-05', 'a', Date.parse('2024-05-10T10:00:00Z'), 'video', null, null);
    insert.run('4', 'w2025-11', 'a', Date.parse('2025-11-10T10:00:00Z'), 'video', null, null);
    insert.run('5', 'w-unknown', 'a', null, 'video', null, null);

    const q = queueQuery({ source: 'all', periods: ['2025', '2024-02', 'unknown'] });
    const ids = db.prepare(q.sql).all(...q.values).map((r) => String(r.id)).sort();
    deepEqual(ids, ['2', '4', '5']);
  } finally {
    db.close();
  }

  const available = { years: [{ year: 2025, months: [1, 2] }, { year: 2024, months: [12] }], unknown: true };
  deepEqual([...expandRangeSelection(available, ['2025'])].sort(), ['2025-01', '2025-02']);
  equal(compactRangeSelection(available, expandRangeSelection(available, undefined)), undefined);
  deepEqual(compactRangeSelection(available, new Set(['2025-01', '2025-02', 'unknown'])), ['2025', 'unknown']);
  deepEqual(recentMonthTokens(available, 2), ['2025-02', '2025-01']);
  equal(formatRangeSummary(undefined), '全部日期');
  equal(formatRangeSummary(['2025-11']), '2025.11');
  equal(formatRangeSummary(['2025', '2024-12']), '已选 2 项');
});

test('the native queue query reads all 10000 works, deduplicates sources, and honors local overrides', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE library_works(id TEXT PRIMARY KEY,title TEXT,author TEXT,published_at INTEGER,kind TEXT,cover_url TEXT,source_order INTEGER);
      CREATE TABLE library_memberships(source TEXT,work_id TEXT,PRIMARY KEY(source,work_id)); CREATE TABLE library_folder_works(folder_id TEXT,work_id TEXT); ${mobileSchema} BEGIN;`);
    const insert = db.prepare('INSERT INTO library_works VALUES(?,?,?,?,?,?,?)');
    const membership = db.prepare('INSERT INTO library_memberships VALUES(?,?)');
    for (let i = 0; i < 10000; i++) {
      const id = String(7637322941528689935n + BigInt(i)); insert.run(id, '作品', '作者', i, 'video', null, null);
      if (i % 2 === 0) membership.run('likes', id); if (i % 3 === 0) membership.run('favorites', id);
    }
    db.exec("INSERT INTO mobile_marks VALUES('7637322941528689935',0,NULL); COMMIT;");
    const read = (source: 'all' | 'likes' | 'favorites') => { const q = queueQuery({ source }); return db.prepare(q.sql).all(...q.values).map(row => String(row.id)); };
    const all = read('all'); equal(all.length, 10000); equal(new Set(all).size, 10000); equal(read('likes').length, 4999); equal(read('favorites').length, 3334);
    const shuffledAll = shuffled(all); equal(shuffledAll.length, 10000); equal(new Set(shuffledAll).size, 10000);
  } finally { db.close(); }
});
