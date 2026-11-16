import { parseCommentList, type CommentPage } from '../douyin-bridge';

// Replies to a comment are read through the public mobile endpoint on
// iesdouyin.com. On the phone this runs as a React Native fetch (no browser
// origin, so no CORS) and needs no request signature — which is exactly why we
// route it here instead of the web `/comment/list/reply/` endpoint that hangs
// when it is called unsigned from inside the douyin.com page.
const REPLY_ENDPOINT = 'https://www.iesdouyin.com/aweme/v1/comment/list/reply/';
const REPLY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  Referer: 'https://www.douyin.com/',
  Accept: 'application/json, text/plain, */*',
};

export async function fetchGuestReplies(
  workId: string,
  commentId: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<CommentPage> {
  const query = new URLSearchParams({
    item_id: workId,
    comment_id: commentId,
    cursor: cursor || '0',
    count: '20',
    aid: '1128',
  });
  const response = await fetch(`${REPLY_ENDPOINT}?${query.toString()}`, {
    credentials: 'omit',
    headers: REPLY_HEADERS,
    signal,
  });
  const body = await response.text();
  return parseCommentList(body, workId, cursor, response.status);
}
