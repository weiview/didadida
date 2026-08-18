'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './lightbox.module.css';
import { useAdmin } from '@/lib/useAdmin';
import {
  MentionableUser, PhotoComment,
  deleteComment, fetchComments, fetchMentionableUsers, postComment, renderCommentBody,
} from '@/lib/api';

/**
 * 燈箱右側那塊黑色區域裡的留言區。
 *
 * 三層身分在這裡的差別（跟後端一致，前端只是不端出按了會失敗的東西）：
 *   站長／成員  照自己的 can_view_comments / can_comment
 *   訪客        看得到與否由站長的全站開關決定；**永遠寫不了**
 *
 * 看不到的人這個元件直接回 null —— 整塊不出現，而不是端出來再說「你沒權限」。
 */

/** 相對時間。留言區只需要「多久以前」，精確到分鐘就夠 */
function timeAgo(iso: string): string {
  // 後端給的是 'YYYY-MM-DD HH:MM:SS' 的 UTC 牆上時間（datetime('now')），
  // 沒有時區標記。補上 Z 才不會被瀏覽器當成本地時間而少算八小時
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} 天前`;
  return new Date(t).toLocaleDateString('zh-TW');
}

function Avatar({ name, color }: { name: string | null; color: string }) {
  return (
    <span className={styles.avatar} style={{ background: color }} aria-hidden>
      {(name ?? '?').trim().charAt(0) || '?'}
    </span>
  );
}

export default function PhotoComments({ photoId }: { photoId: number }) {
  const { canViewComments, canComment, isAdmin, user } = useAdmin();

  const [comments, setComments] = useState<PhotoComment[]>([]);
  const [loading, setLoading] = useState(true);
  /** 可以 @ 的人（挑人選單用）。訪客拿不到，那支 API 是成員限定 */
  const [people, setPeople] = useState<MentionableUser[]>([]);
  /** 這串留言裡已經被 @ 到的人（顯示用）。跟著留言一起回來，訪客也有 */
  const [mentionedPeople, setMentionedPeople] = useState<MentionableUser[]>([]);

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<PhotoComment | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  /*
   * 從選單挑過的人：顯示名稱 → uid。
   *
   * 輸入框裡放的是**看得懂的 `@名字`**，送出前才用這份對照換成後端要的 `@[uid]`。
   * 直接把 `@[3]` 放進輸入框最單純，但使用者打字打到一半會看到自己寫的東西變成
   * 一串編號，那太怪了。
   *
   * ⚠️ 已知的邊界：**兩個人的顯示名稱一模一樣時，後挑的那個會蓋掉前一個**
   *    （這份對照是以名字為鍵）。白名單的名字由站長掌握，重名本來就會讓人分不清，
   *    不值得為此把輸入框做成 contenteditable 的晶片。
   */
  const mentionMap = useRef<Map<string, number>>(new Map());

  // @ 選單：null = 沒開；有值 = 使用者正在打 `@` 後面那串字
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const thread = await fetchComments(photoId);
    setComments(thread.comments);
    setMentionedPeople(thread.people);
    setLoading(false);
  }, [photoId]);

  useEffect(() => {
    if (!canViewComments) return;
    // 換一張照片就換一串留言，草稿也一起清掉（回覆對象已經不存在了）
    setDraft('');
    setReplyTo(null);
    setError(null);
    mentionMap.current = new Map();
    load();
  }, [photoId, canViewComments, load]);

  // 可以 @ 的人。訪客打這支會 401，所以只有成員去拿。整站不變，載一次就好
  useEffect(() => {
    if (!isAdmin) return;
    fetchMentionableUsers().then(setPeople);
  }, [isAdmin]);

  /*
   * 顯示 @ 名字用的對照表。兩份來源疊起來：
   *   mentionedPeople  跟留言一起回來的（**訪客只有這份**）
   *   people           挑人選單那份，只有成員拿得到
   * 後者放後面 —— 它是現在式，名字比較新
   */
  const peopleById = useMemo(() => {
    const map = new Map<number, MentionableUser>();
    for (const p of mentionedPeople) map.set(p.id, p);
    for (const p of people) map.set(p.id, p);
    return map;
  }, [mentionedPeople, people]);

  /** 主留言在前，回覆掛在自己的主留言底下（後端保證只有一層） */
  const threads = useMemo(() => {
    const roots = comments.filter((c) => c.parent_id == null);
    const byParent = new Map<number, PhotoComment[]>();
    for (const c of comments) {
      if (c.parent_id == null) continue;
      const list = byParent.get(c.parent_id) ?? [];
      list.push(c);
      byParent.set(c.parent_id, list);
    }
    return roots.map((root) => ({ root, replies: byParent.get(root.id) ?? [] }));
  }, [comments]);

  const insertMention = (person: MentionableUser) => {
    const name = person.name ?? `#${person.id}`;
    mentionMap.current.set(name, person.id);
    // 把使用者正在打的 `@xxx` 整段換掉，而不是往後面追加
    setDraft((prev) => prev.replace(/@[^@\s]*$/, '') + `@${name} `);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    // 游標所在的那個字尾如果是 `@` 開頭且還沒遇到空白，就是正在挑人
    const m = value.match(/@([^@\s]*)$/);
    setMentionQuery(m ? m[1] : null);
  };

  const mentionCandidates = useMemo(() => {
    if (mentionQuery == null || !people.length) return [];
    const q = mentionQuery.toLowerCase();
    return people
      .filter((p) => p.id !== user?.id && (p.name ?? '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, people, user?.id]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);

    /*
     * 把 `@名字` 換回 `@[uid]`。**長的名字先換** —— 「小明」與「小明媽」同時
     * 存在時，先換短的會把「小明媽」啃掉半個名字，剩下一個孤零零的「媽」。
     */
    let payload = text;
    // Array.from 而不是展開運算子：前端 tsconfig 的 target 是 ES5，
    // 直接展開 Map 的迭代器會被 TS2802 擋下來
    const names = Array.from(mentionMap.current.keys()).sort((a, b) => b.length - a.length);
    for (const name of names) {
      const uid = mentionMap.current.get(name)!;
      payload = payload.split(`@${name}`).join(`@[${uid}]`);
    }

    const result = await postComment(photoId, payload, replyTo ? (replyTo.parent_id ?? replyTo.id) : null);
    if (result.success && result.comment) {
      setComments((prev) => [...prev, result.comment!]);
      setDraft('');
      setReplyTo(null);
      mentionMap.current = new Map();
    } else {
      setError(result.message ?? '留言失敗');
    }
    setSending(false);
  };

  const remove = async (c: PhotoComment) => {
    if (!window.confirm('刪掉這則留言？底下的回覆會一起消失。')) return;
    if (await deleteComment(c.id)) {
      // 回覆是後端 CASCADE 刪掉的，前端也要照著把它們拿掉
      setComments((prev) => prev.filter((x) => x.id !== c.id && x.parent_id !== c.id));
    }
  };

  const beginReply = (target: PhotoComment) => {
    setReplyTo(target);
    // FB 的行為：按回覆就先幫你 @ 好對方。回覆自己的話不必 @
    if (target.user_id !== user?.id && target.user_name) {
      mentionMap.current.set(target.user_name, target.user_id);
      setDraft((prev) => (prev.includes(`@${target.user_name}`) ? prev : `@${target.user_name} ${prev}`));
    }
    inputRef.current?.focus();
  };

  const renderBody = (body: string) => (
    <>
      {renderCommentBody(body, peopleById).map((part, i) =>
        part.type === 'mention'
          ? <span key={i} className={styles.mention}>{part.value}</span>
          : <React.Fragment key={i}>{part.value}</React.Fragment>,
      )}
    </>
  );

  const Row = ({ c, isReply }: { c: PhotoComment; isReply: boolean }) => (
    <div className={isReply ? styles.commentReply : styles.commentRow}>
      <Avatar name={c.user_name} color={c.color} />
      <div className={styles.commentBubbleWrap}>
        <div className={styles.commentBubble}>
          <span className={styles.commentAuthor}>{c.user_name ?? '（已離開）'}</span>
          <span className={styles.commentBody}>{renderBody(c.body)}</span>
        </div>
        <div className={styles.commentMeta}>
          <span>{timeAgo(c.created_at)}</span>
          {canComment && <button type="button" onClick={() => beginReply(c)}>回覆</button>}
          {c.can_delete && <button type="button" onClick={() => remove(c)}>刪除</button>}
        </div>
      </div>
    </div>
  );

  if (!canViewComments) return null;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>留言{comments.length > 0 ? `（${comments.length}）` : ''}</h3>
      </div>

      {loading ? (
        <span className={styles.commentHint}>載入中…</span>
      ) : threads.length === 0 ? (
        <span className={styles.commentHint}>還沒有人留言</span>
      ) : (
        <div className={styles.commentList}>
          {threads.map(({ root, replies }) => (
            <div key={root.id}>
              <Row c={root} isReply={false} />
              {replies.map((r) => <Row key={r.id} c={r} isReply />)}
            </div>
          ))}
        </div>
      )}

      {canComment ? (
        <div className={styles.commentComposer}>
          {replyTo && (
            <div className={styles.replyBanner}>
              <span>回覆 {replyTo.user_name ?? '這則留言'}</span>
              <button type="button" onClick={() => setReplyTo(null)}>取消</button>
            </div>
          )}
          <div className={styles.composerRow}>
            <textarea
              ref={inputRef}
              className={styles.commentInput}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                // Enter 送出、Shift+Enter 換行。@ 選單開著時 Enter 是要選人，不能送出
                if (e.key === 'Enter' && !e.shiftKey && !mentionCandidates.length) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="留個言…　打 @ 可以提到某個人"
              rows={2}
              maxLength={1000}
            />
            <button
              type="button"
              className={styles.btn}
              onClick={submit}
              disabled={sending || !draft.trim()}
            >
              送出
            </button>
          </div>

          {mentionCandidates.length > 0 && (
            <div className={styles.mentionMenu}>
              {mentionCandidates.map((p) => (
                <button key={p.id} type="button" onClick={() => insertMention(p)}>
                  <Avatar name={p.name} color={p.color} />
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          )}

          {error && <span className={styles.commentError}>{error}</span>}
        </div>
      ) : (
        <span className={styles.commentHint}>
          {isAdmin ? '站長關閉了你的留言權限' : '訪客只能看留言。想留言請用 Google 登入'}
        </span>
      )}
    </div>
  );
}
