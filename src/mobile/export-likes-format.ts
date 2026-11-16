// Build a JSON file in the exact "mylike.library" schema the desktop MyLike
// app imports (likes = version 2, order desktop-liked, source douyin.likes).
// Pure module (no React Native imports) so it can be unit-tested with node:test.
export type ExportWork = {
  id: string;
  title: string;
  author: string;
  publishedAt: number | null;
  kind: string;
  coverUrl: string | null;
};

type ExportItem = {
  id: string;
  title: string;
  author: string;
  kind: string;
  publishedAt: string | null;
  coverUrl: string | null;
};

export function buildLikesLibrary(works: ExportWork[], now: number = Date.now()): string {
  const seen = new Set<string>();
  const items: ExportItem[] = [];
  for (const work of works) {
    if (!/^\d{1,30}$/.test(work.id) || seen.has(work.id)) continue;
    seen.add(work.id);
    const kind = work.kind === 'gallery' || work.kind === 'live-gallery' ? work.kind : 'video';
    items.push({
      id: work.id,
      title: typeof work.title === 'string' ? work.title : '',
      author: typeof work.author === 'string' ? work.author : '',
      kind,
      publishedAt: work.publishedAt && Number.isFinite(work.publishedAt) ? new Date(work.publishedAt).toISOString() : null,
      coverUrl: work.coverUrl ?? null,
    });
  }
  const payload = {
    format: 'mylike.library',
    version: 2,
    exportedAt: new Date(now).toISOString(),
    source: { label: '抖音点赞', kind: 'douyin.likes' },
    order: 'desktop-liked',
    items,
    folders: [],
  };
  return JSON.stringify(payload, null, 2);
}
