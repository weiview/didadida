'use client';

import { useCallback, useEffect, useState } from 'react';
import { diagnoseDriveAccess, refreshDriveConfig, type DriveCheck } from '@/lib/drive';
import { driveWriterLoginUrl, type DriveConfig } from '@/lib/api';

interface Props {
  isOpen: boolean;
  /** 帶著才測得到「相簿子資料夾」那幾項，也就是真正的上傳目的地 */
  albumId?: number;
  onClose: () => void;
}

/**
 * 「Drive 寫入帳號」的連結與診斷。
 *
 * 為什麼寫入帳號只有一個：scope 是 `drive.file`＝per-file 授權，誰建的檔才只有
 * 誰碰得到。每位管理員各自用自己的身分寫的話，「A 建的相簿、B 要上傳」一定 404，
 * 而且**根目錄的授權不會往下涵蓋別人建的子資料夾**（2026-08-10 實測）。
 * 所以改成後端存一個帳號的長期授權，所有人上傳時都跟後端換那個帳號的短效 token。
 *
 * 這裡做兩件事：連結／重新連結那個帳號，以及逐項回答「現在到底卡在哪」——
 * 靠上傳照片去試只會看到「照片有了但沒備份」，分不出是沒連結、過期還是編碼失敗。
 */
export default function DriveAccessModal({ isOpen, albumId, onClose }: Props) {
  const [checks, setChecks] = useState<DriveCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<DriveConfig | null>(null);

  const runChecks = useCallback(async () => {
    setRunning(true);
    try {
      // 設定要重抓：剛連結完的話，快取裡的 writer_email 還是舊的
      setConfig(await refreshDriveConfig());
      setChecks(await diagnoseDriveAccess(albumId));
    } catch (e) {
      setChecks([{ label: '檢查中斷', ok: false, detail: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setRunning(false);
    }
  }, [albumId]);

  useEffect(() => {
    if (!isOpen) return;
    setChecks(null);
    runChecks();
  }, [isOpen, runChecks]);

  if (!isOpen) return null;

  const busy = running;
  const btn = (enabled: boolean, primary = false) => ({
    padding: '9px 16px',
    borderRadius: 8,
    border: primary ? 'none' : '1px solid #cbd5e1',
    background: primary ? (enabled ? '#2563eb' : '#93c5fd') : '#fff',
    color: primary ? '#fff' : '#334155',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: 14,
    opacity: enabled ? 1 : 0.7,
    display: 'inline-block',
    textDecoration: 'none',
  } as const);

  const note = { fontSize: 12.5, color: '#64748b', lineHeight: 1.7 } as const;
  const mark = (ok: boolean | null) => (ok === null ? '—' : ok ? '✓' : '✗');
  const markColor = (ok: boolean | null) => (ok === null ? '#94a3b8' : ok ? '#15803d' : '#b91c1c');

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, width: '100%', maxWidth: 620,
          maxHeight: '88vh', display: 'flex', flexDirection: 'column', color: '#0f172a',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9' }}>
          <strong style={{ fontSize: 16 }}>Drive 寫入帳號</strong>
          <div style={{ ...note, marginTop: 4 }}>
            照片備份到 Drive 時，不管是誰上傳，寫進去的都是這一個帳號。
          </div>
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.9, marginBottom: 14 }}>
            {config?.writer_email ? (
              <>
                目前連結的是 <strong>{config.writer_email}</strong>
                {config.writer_linked_at && (
                  <span style={note}>（{new Date(config.writer_linked_at).toLocaleString('zh-TW')}）</span>
                )}
                。<strong>備份都會存進這個帳號的 Drive</strong>，其他管理員上傳的照片也一樣。
              </>
            ) : (
              <>
                還沒連結。<strong>在這之前所有人都傳不上 Drive 備份</strong>（照片本身照樣存得進 R2）。
                用要當備份倉庫的那個 Google 帳號按下面的按鈕登入一次即可。
              </>
            )}
          </div>

          <a href={driveWriterLoginUrl(albumId)} style={btn(true, true)}>
            {config?.writer_email ? '重新連結（可換帳號）' : '連結 Drive 寫入帳號'}
          </a>

          <div style={{ ...note, marginTop: 10 }}>
            Google 的同意畫面若還在「測試中」，這份授權<strong>只有 7 天</strong>，
            過期後上傳會開始抱怨要重新連結；發布到「正式版」就不會過期。
          </div>

          <div style={{ marginTop: 20, borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: 14 }}>存取檢查</strong>
              <button type="button" onClick={runChecks} disabled={busy} style={btn(!busy)}>
                {running ? '檢查中...' : '重新檢查'}
              </button>
            </div>

            {checks === null && <div style={{ ...note, marginTop: 10 }}>檢查中...</div>}

            {checks && (
              <div style={{ marginTop: 10 }}>
                {checks.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid #f8fafc' }}>
                    <span style={{ color: markColor(c.ok), fontWeight: 700, width: 14, flexShrink: 0 }}>
                      {mark(c.ok)}
                    </span>
                    <span style={{ fontSize: 13.5, lineHeight: 1.65 }}>
                      {c.label}
                      <span style={{ ...note, display: 'block' }}>{c.detail}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ ...note, marginTop: 12 }}>
              最後一項會真的在 Drive 上建一個測試檔再丟進垃圾桶，那是唯一能確定
              「寫得進去」的辦法 —— 權限欄位在 per-file 授權底下不一定說實話。
            </div>
          </div>
        </div>

        <div style={{
          padding: '12px 20px', borderTop: '1px solid #f1f5f9',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button type="button" onClick={onClose} disabled={busy} style={btn(!busy)}>關閉</button>
        </div>
      </div>
    </div>
  );
}
