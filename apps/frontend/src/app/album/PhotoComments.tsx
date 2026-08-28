'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './lightbox.module.css';
import { useAdmin } from '@/lib/useAdmin';
import { isOnline, usePresence } from '@/lib/presence';
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

/**
 * 留言人的小圓頭。有自訂頭像就畫圖，沒有就是「名字首字 ＋ 他的軌跡色」。
 *
 * 去背 PNG 底下墊一層很淡的同色 —— 透明的圖直接貼在深色留言區上會像浮在半空中。
 * （這裡不共用 components/Avatar.tsx：那支是行內樣式的通用版，
 * 燈箱裡的尺寸與陰影跟著 lightbox.module.css 走。）
 */
function Avatar({ name, color, src, uid }: {
  name: string | null; color: string; src?: string | null;
  /**
   * 給誰畫上線燈。**傳了才畫** —— 這支 Avatar 只在留言區用，兩個呼叫端都有 uid，
   * 但保持選填是為了跟 components/Avatar.tsx 同一個約定（不知道就不要畫灰燈）。
   */
  uid?: number | null;
}) {
  /*
   * 燈跟著全站那份快照走（lib/presence.ts），這裡不開任何計時器 ——
   * 一串留言可能有幾十顆頭像，各自輪詢會把免費額度吃光。
   */
  const snap = usePresence();
  const dot = uid == null || !snap.ready ? null : isOnline(uid, snap);

  const circle = (
    <span className={styles.avatar} style={{ background: src ? `${color}33` : color }} aria-hidden>
      {src
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className={styles.avatarImg} src={src} alt="" />
        : (name ?? '?').trim().charAt(0) || '?'}
    </span>
  );

  // 還沒抓到名單之前不畫燈：先畫成灰的再跳成綠的，看起來像每個人都剛上線
  if (dot === null) return circle;

  return (
    <span className={styles.avatarWrap} title={`${name ?? ''}${dot ? '（上線中）' : '（離線）'}`}>
      {circle}
      <span className={`${styles.presenceDot}${dot ? ` ${styles.presenceOn}` : ''}`} />
    </span>
  );
}

/*
 * ── 輸入框是 contenteditable，不是 textarea ───────────────────────────────
 *
 * @ 到的人在輸入框裡是一顆**不可分割的晶片**（粗體、重音色、看不到 @），
 * 純文字的 textarea 做不到這件事。代價是底下這幾個 DOM 手術函式。
 *
 * 為什麼晶片非做不可：`@` 原本身兼二職 —— 給人看的記號，以及送出時
 * 「這段是 mention」的唯一標記。把 @ 拿掉之後就得靠 DOM 節點來記，
 * 否則內文裡剛好打到同名的字會被誤判成提到某個人。
 */

/** 一顆人。contentEditable=false → 游標跳過它，退格一次整顆消失 */
function makeChip(id: number, name: string | null): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = styles.mentionChip;
  chip.setAttribute('data-uid', String(id));
  chip.contentEditable = 'false';
  chip.textContent = name ?? `#${id}`;
  return chip;
}

/**
 * 插晶片時墊在後面的空白。用**不斷行空白**：一般空白排在結尾會被瀏覽器摺疊掉，
 * 游標就黏在晶片右邊出不來。
 *
 * 用 fromCharCode 而不是直接在字串裡打一個 —— 原始碼裡看不出它跟一般空白的差別，
 * 被誰順手「清掉怪空白」就整個壞了。（附帶一提 JS 的 `\s` 本來就含 U+00A0，
 * 底下比對「@ 查詢字」的字元類別不必特別把它列出來。）
 */
const NBSP = String.fromCharCode(0xa0);

/** 把游標移到某個節點後面 */
function caretAfter(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 把輸入框的 DOM 讀成後端要的字串：晶片變 `@[uid]`，其餘照抄 */
function serializeEditor(root: HTMLElement | null): string {
  if (!root) return '';
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const uid = el.getAttribute('data-uid');
    if (uid) {
      out += `@[${uid}]`;
      return;
    }
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    // 貼上時瀏覽器可能塞 div/p 進來，當成換行處理
    if ((el.tagName === 'DIV' || el.tagName === 'P') && out && !out.endsWith('\n')) out += '\n';
    for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]);
  };
  for (let i = 0; i < root.childNodes.length; i++) walk(root.childNodes[i]);
  return out.split(NBSP).join(' ');
}

/** 游標前面那段還沒結束的 `@查詢字`。不在輸入框裡、或選取了一段字就回 null */
function mentionAtCaret(
  root: HTMLElement | null,
): { node: Text; start: number; end: number; query: string } | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const end = sel.anchorOffset;
  const m = (node.textContent ?? '').slice(0, end).match(/@([^@\s]*)$/);
  if (!m) return null;
  return { node: node as Text, start: end - m[0].length, end, query: m[1] };
}

export default function PhotoComments({ photoId }: { photoId: number }) {
  const { canViewComments, canComment, isAdmin, user } = useAdmin();

  const [comments, setComments] = useState<PhotoComment[]>([]);
  const [loading, setLoading] = useState(true);
  /** 可以 @ 的人（挑人選單用）。訪客拿不到，那支 API 是成員限定 */
  const [people, setPeople] = useState<MentionableUser[]>([]);
  /** 這串留言裡已經被 @ 到的人（顯示用）。跟著留言一起回來，訪客也有 */
  const [mentionedPeople, setMentionedPeople] = useState<MentionableUser[]>([]);

  /**
   * 輸入框內容的**副本**（已經序列化成 `@[uid]` 的形式）。
   * 真正的內容在 DOM 裡，這份只拿來判斷「空不空」——placeholder 要不要出現、
   * 送出鈕要不要變灰。所以每次動 DOM 之後都要 syncDraft() 補一下。
   */
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<PhotoComment | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * 輸入框。**它的內容由 DOM 自己管，不是 React 的受控元件** ——
   * 每次打字都重畫子節點的話游標會被打回開頭。React 只負責掛上這個 div，
   * 裡面的文字與晶片一律用原生 API 動。
   */
  const editorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // @ 選單：null = 沒開；有值 = 使用者正在打 `@` 後面那串字
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** 鍵盤上下鍵選到第幾個 */
  const [mentionIndex, setMentionIndex] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const thread = await fetchComments(photoId);
    setComments(thread.comments);
    setMentionedPeople(thread.people);
    setLoading(false);
  }, [photoId]);

  /** DOM 是真相，把它讀進 draft。動完輸入框的 DOM 就要叫一次 */
  const syncDraft = useCallback(() => {
    setDraft(serializeEditor(editorRef.current));
  }, []);

  /** 清空輸入框（送出成功、換照片）。innerHTML 直接歸零，晶片也一起沒了 */
  const clearEditor = useCallback(() => {
    if (editorRef.current) editorRef.current.innerHTML = '';
    setDraft('');
    setMentionQuery(null);
  }, []);

  useEffect(() => {
    if (!canViewComments) return;
    // 換一張照片就換一串留言，草稿也一起清掉（回覆對象已經不存在了）
    clearEditor();
    setReplyTo(null);
    setError(null);
    load();
  }, [photoId, canViewComments, load, clearEditor]);

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

  const mentionCandidates = useMemo(() => {
    if (mentionQuery == null || !people.length) return [];
    const q = mentionQuery.toLowerCase();
    return people
      .filter((p) => p.id !== user?.id && (p.name ?? '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, people, user?.id]);

  // 換一批候選人就回到第一個。不重設的話上一輪停在第 5 個、這一輪只有 2 個人，
  // 就會選到不存在的那一格
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  // 選到的那一列要留在看得到的地方（選單有 max-height，六個人就會超出去）
  useEffect(() => {
    const el = menuRef.current?.children[mentionIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [mentionIndex]);

  /** 游標所在位置有沒有正在打的 `@查詢字`，有就開選單 */
  const refreshMentionQuery = useCallback(() => {
    const hit = mentionAtCaret(editorRef.current);
    setMentionQuery(hit ? hit.query : null);
  }, []);

  /**
   * 把游標前面那段 `@查詢字` 換成一顆晶片。
   *
   * 刻意不用 execCommand 之類的整段替換 —— 要精準地只吃掉那幾個字，
   * 不能碰到使用者已經打好的其他內容。
   */
  const insertMention = (person: MentionableUser) => {
    const editor = editorRef.current;
    const hit = mentionAtCaret(editor);
    if (!editor || !hit) return;

    const range = document.createRange();
    range.setStart(hit.node, hit.start);
    range.setEnd(hit.node, hit.end);
    range.deleteContents();

    // 晶片後面墊一個不斷行空白，游標才停得進去、下一個字也不會黏在晶片上
    const tail = document.createTextNode(NBSP);
    const frag = document.createDocumentFragment();
    frag.appendChild(makeChip(person.id, person.name));
    frag.appendChild(tail);
    range.insertNode(frag);

    caretAfter(tail);
    setMentionQuery(null);
    syncDraft();
    editor.focus();
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    /*
     * 注音／拼音組字中間按 Enter 是「選這個字」，不是送出留言。
     * 沒有這一行，中文使用者每打一個詞就會不小心送出一則半截的留言。
     */
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;

    if (mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      // Enter 與 Tab 都是「就選這個」。選單開著時 Enter 不送出留言
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        // 先關選單就好，別讓 Esc 冒泡上去被燈箱當成「關閉」
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  /** 貼上一律轉成純文字。不擋的話會把來源網站的樣式與標籤整包搬進來 */
  const onEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    syncDraft();
    refreshMentionQuery();
  };

  const submit = async () => {
    // 直接讀 DOM 而不是讀 draft —— draft 是 state，剛插完晶片那一瞬間可能還沒更新
    const text = serializeEditor(editorRef.current).trim();
    if (!text || sending) return;
    if (text.length > 1000) {
      setError('留言太長了，上限 1000 字');
      return;
    }
    setSending(true);
    setError(null);

    // 不必再換算什麼 —— 晶片序列化出來就已經是後端要的 `@[uid]`
    const result = await postComment(photoId, text, replyTo ? (replyTo.parent_id ?? replyTo.id) : null);
    if (result.success && result.comment) {
      setComments((prev) => [...prev, result.comment!]);
      clearEditor();
      setReplyTo(null);
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
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();

    // FB 的行為：按回覆就先幫你 @ 好對方。回覆自己的話不必 @，已經 @ 過也不再插一次
    const already = editor.querySelector(`[data-uid="${target.user_id}"]`);
    if (target.user_id !== user?.id && !already) {
      const tail = document.createTextNode(NBSP);
      editor.insertBefore(tail, editor.firstChild);
      editor.insertBefore(makeChip(target.user_id, target.user_name), tail);
      caretAfter(tail);
      syncDraft();
    }
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
      <Avatar name={c.user_name} color={c.color} src={c.avatar} uid={c.user_id} />
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
            {/*
              * ⚠️ 這個 div **永遠不要給它 React 子節點**。裡面的東西是原生 DOM 在動，
              *    React 一旦重畫子節點，游標會被打回開頭、打到一半的字也會亂跳。
              *    className 之類的屬性可以隨便換，那不會碰到子節點。
              */}
            <div
              ref={editorRef}
              className={`${styles.commentInput} ${draft.trim() ? '' : styles.commentInputEmpty}`}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="留言"
              data-placeholder="留個言…　打 @ 可以提到某個人"
              onInput={() => { syncDraft(); refreshMentionQuery(); }}
              onKeyDown={onEditorKeyDown}
              // 游標被鍵盤或滑鼠移走時，@ 選單也該跟著關掉／重算
              onKeyUp={refreshMentionQuery}
              onMouseUp={refreshMentionQuery}
              onCompositionEnd={() => { syncDraft(); refreshMentionQuery(); }}
              onPaste={onEditorPaste}
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
            <div className={styles.mentionMenu} ref={menuRef} role="listbox">
              {mentionCandidates.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={i === mentionIndex}
                  className={i === mentionIndex ? styles.mentionItemActive : undefined}
                  // 滑鼠移過去就當作選到它，鍵盤與滑鼠共用同一個「現在選誰」
                  onMouseEnter={() => setMentionIndex(i)}
                  /*
                   * 用 mouseDown 而不是 click：click 之前輸入框會先失焦，
                   * 游標位置一沒了就找不到要換掉的那段 `@查詢字`，晶片插不進去。
                   */
                  onMouseDown={(e) => { e.preventDefault(); insertMention(p); }}
                >
                  <Avatar name={p.name} color={p.color} src={p.avatar} uid={p.id} />
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
