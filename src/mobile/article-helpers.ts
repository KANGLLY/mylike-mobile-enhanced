import type { ArticleData } from '../douyin';

export function formatRelativeTime(publishedAt?: number, now = Date.now()): string {
  if (!publishedAt || !Number.isFinite(publishedAt) || publishedAt <= 0) return '';
  const diffSec = Math.max(0, Math.floor((now - publishedAt) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}小时前`;
  const days = Math.floor(diffSec / 86_400);
  if (days <= 30) return `${days}天前`;
  const d = new Date(publishedAt);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year === new Date(now).getFullYear() ? `${month}-${day}` : `${year}-${month}-${day}`;
}

export function estimateReadMinutes(article: Pick<ArticleData, 'body' | 'readTimeMinutes'>): number {
  if (article.readTimeMinutes && article.readTimeMinutes > 0) return article.readTimeMinutes;
  const chars = article.body.replace(/\s+/g, '').length;
  return Math.max(1, Math.ceil(chars / 400));
}

export type ArticleBlock = { kind: 'heading' | 'paragraph'; text: string };

export function parseArticleBlocks(body: string): ArticleBlock[] {
  const raw = body.trim();
  if (!raw) return [];
  return raw
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const heading = chunk.match(/^#{1,4}\s+(.+)$/);
      if (heading) return { kind: 'heading' as const, text: stripInlineMarkdown(heading[1]) };
      return { kind: 'paragraph' as const, text: stripInlineMarkdown(chunk) };
    });
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}
