'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapLibreMap, NavigationControl, LngLatBounds,
  type GeoJSONSource, type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Album, FootprintPoint, TrackPoint, TrackPointEdit } from '@/lib/api';
import { CONVOY_PCT_DEFAULT } from '@/lib/api';
import { MOVER_EMOJI, metersBetween, segmentKey } from '@/lib/vehicles';
import {
  buildAvatarHead, createAlienHead, createCarImage,
  CAR_NEUTRAL, CAR_PIXEL_RATIO, CAR_SEAT_Y, HEAD_PIXEL_RATIO,
} from '@/lib/car';
import { DEFAULT_TRACK_COLOR } from '@/lib/trackColors';

// OpenFreeMap：免費、免 API key、無流量上限的向量圖磚。
// 不用 Google Maps 是因為它強制要求綁定信用卡的帳單帳戶。
const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/positron';

interface Props {
  points: FootprintPoint[];
  /**
   * 要不要在地圖上畫照片（圓點、聚合、縮圖）。
   *
   * 關掉時是把 photos 這個 source 餵空，而不是只切圖層可見性 ——
   * 縮圖採「畫到才載」（見 styleimagemissing），source 空了就不會有人來要圖，
   * 也就順便省掉那一整批 R2 讀取與頻寬。
   *
   * points 仍然照傳：關掉只是不畫，鏡頭框景與播放列的統計都還算它們。
   */
  showPhotos?: boolean;
  /**
   * 相簿清單。只為了一件事：整叢照片都屬於同一本相簿時，用那本的封面照當代表。
   *
   * 沒傳、或那本沒設封面，就退回「從這本相簿的照片裡隨機挑一張」——
   * 所以這個 prop 是加分項，缺了地圖照樣完整。
   */
  albums?: Album[];
  /** GPS 軌跡點。有軌跡時，動畫就是沿著它跑 */
  tracks?: TrackPoint[];
  /**
   * 把照片位置也串進動畫路徑。
   * 預設關閉：照片之間拉直線是憑空捏造的路徑，兩張照片就會變成一條穿牆而過的直線。
   * 沒有軌跡的舊相簿才需要打開它。
   */
  connectPhotos?: boolean;
  height?: number | string;
  styleUrl?: string;
  onSelectPhoto?: (point: FootprintPoint) => void;
  /** 管理者才給編輯軌跡點的入口 */
  editable?: boolean;
  /**
   * 送出軌跡點編修。一次可能有多天（跨日的選取要分開送，因為後端是逐日改的），
   * 回傳 false 代表沒改成功，畫面上的選取會保留讓使用者重試。
   */
  onEditPoints?: (edits: TrackPointEdit[]) => Promise<boolean>;
  /**
   * 把照片搬到指定座標（geo_source 會變成 'manual'）。
   * 跟 onEditPoints 分開是因為改的是不同資料表，後端也是兩條路由。
   */
  onMovePhoto?: (photoId: number, lat: number, lng: number) => Promise<boolean>;
  /**
   * 未經濃縮／抽稀的原始軌跡點（由頁面解析 GPX 而來，這裡只負責畫與跑動畫）。
   *
   * 刻意跟 tracks 分開而不是合併：這些點不在 D1 裡，沒有真的 id，
   * 不可以進編輯模式 —— 選了也刪不掉、合併不了。
   *
   * 純檢視用，不寫進 D1 —— 完整軌跡動輒好幾萬點，寫進去會吃掉免費方案
   * 每日 10 萬列的寫入額度，而且編輯模式的段內點號會變成五位數而不能用。
   */
  rawTracks?: TrackPoint[];
  /** 要不要把原始軌跡畫成橘色虛線。跟 animateOn 分開：可以只跑動畫不畫線，反之亦然 */
  showRawLine?: boolean;
  /**
   * 貼路（map matching）後的軌跡點。幾何來自 OSM 路網，時間是從原本的點內插回來的，
   * 所以跟 rawTracks 一樣可以直接畫、直接跑動畫。
   *
   * 同樣不在 D1 裡（存 R2），不可編輯 —— 這是衍生資料，改它沒有意義，
   * 真要修的是原本的軌跡點。
   */
  matchedTracks?: TrackPoint[];
  /** 要不要把貼路軌跡畫成紫色實線 */
  showMatchedLine?: boolean;
  /**
   * 要不要畫 D1 濃縮軌跡（綠線）與停留圈。
   *
   * 平常看的是貼路軌跡，這一層只是它的原料 —— 兩條疊在一起反而看不出貼路
   * 有沒有貼準。關掉只影響「畫不畫」，編輯模式的軌跡點另有一層，不受影響。
   */
  showTrackLine?: boolean;
  /** 動畫沿著哪一份軌跡跑。選到的那份沒資料時自動退回 'track' */
  animateOn?: 'track' | 'raw' | 'matched';
  /**
   * 一起出遊的判定門檻（%）：兩個人的一趟移動重疊到這個比例就算同遊，動畫預設合體。
   *
   * 站長在 /admin 調，跟著 `GET /api/auth/me` 回來。**判定與繪製都在瀏覽器裡算**，
   * 改這個數字不會多打任何一次 API。
   */
  convoyOverlapPct?: number;
  /**
   * Google 時間軸的紀念層，已經切好可以連的線段（[lng, lat][][]）。
   *
   * 傳的是線而不是點，因為這一層跟其他三層的本質不同：它唯讀 —— 不編輯、
   * 不貼路、不跑動畫、不參與照片位置推論。頁面那邊算完就定案，
   * 這裡只負責畫。跟著傳點進來只會讓人以為它能做跟 tracks 一樣的事。
   */
  timelineLines?: [number, number][][];
  /**
   * 每個家人在地圖上的顏色（`{ [user_id]: '#rrggbb' }`，由 `/api/track-members` 而來）。
   *
   * 軌跡點只帶 user_id，顏色是後端算好的 —— 這裡不做任何退讓邏輯，
   * 沒對應到的線一律畫成 DEFAULT_TRACK_COLOR。
   */
  trackColors?: Record<number, string>;
  /**
   * 每個家人的頭像網址（`{ [user_id]: url | null }`，同樣來自 `/api/track-members`）。
   *
   * 播放時坐在車上的那顆大頭就是它。沒設頭像（或這張表裡沒有他）的人坐外星人，
   * 不是不畫 —— 車上空著看起來像資料掉了。
   */
  trackAvatars?: Record<number, string | null>;
  /**
   * Google 紀念層要用的顏色。那一層的線是頁面切好的座標陣列，帶不了 user_id，
   * 而它的內容永遠是**當下這個人自己的**時間軸（R2 key 依 uid 分開），
   * 所以直接給一個色就夠了。
   */
  timelineColor?: string;
  /**
   * 鏡頭要直接停在這個點（[lng, lat]），而不是把所有東西框進畫面。
   *
   * 只看一天的時候用：框住一整天的範圍會把鏡頭拉到看不出細節的高度，
   * 而人在看某一天時想從那天的起點看起（通常接著就按播放）。
   * 給 null 就恢復成「全部框進來」。
   */
  focusPoint?: [number, number] | null;
}

/** 動畫路徑上的一個節點 */
interface PathNode {
  /** UTC 毫秒。照片與軌跡唯一的共同時間軸 */
  t: number;
  lng: number;
  lat: number;
  /** 與前一個節點之間不可以連線 */
  breakBefore: boolean;
  /** 'day_key#seg'。照片節點為 null —— 它不屬於任何一段軌跡 */
  segKey: string | null;
  /** 這一點是誰的。照片沿用它時間上落在的那一段軌跡的主人 */
  userId: number | null;
}

/** 一次停留。匯入時已把亂跳的點收成質心，這裡只是把它的時間區間還原回來 */
interface Stay {
  /** 進入與離開的 UTC 毫秒 */
  t0: number;
  t1: number;
  lng: number;
  lat: number;
  sec: number;
  /** 誰在這裡停的。停留圈跟著那個人的顏色走，多身分同框時才分得出是誰待在那 */
  userId: number | null;
}

// 超過這個間隔就斷開。跨夜（10 幾小時）仍然連著，隔好幾個月的兩趟旅行則不會被
// 一條橫跨地圖的假直線接起來。
const MAX_GAP_MS = 24 * 60 * 60 * 1000;

/*
 * 兩趟貼路軌跡之間，最遠隔多少公尺還願意用虛線接起來。
 *
 * 火車、飛機、船那些段落是整趟跳過的（costingFor 回 null），拉一條幾百公里的
 * 直線橫過地圖比讓它斷著還糟，所以一定要有上限。實測十天的空隙是 15–154m
 * （人停下來的地方：進賣場、回公司、停車），500m 有三倍餘裕又離「換城市」很遠。
 */
const MATCHED_BRIDGE_MAX_M = 500;

// 照片離停留質心多近才算「在同一個地方」。停留半徑是 60m，這裡放寬到兩倍，
// 因為照片本身的 EXIF 座標也有誤差，而且大樓的另一側仍然是同一棟樓。
const STAY_SNAP_M = 120;

// 1x 播完整條路徑要幾秒。長度差幾百倍的日子都套同一個總時長，
// 使用者才不用為了看完一趟長途旅行等上好幾分鐘
const PLAY_SECONDS = 25;

/*
 * 同行判定的三個參數。跟 collapseStays 的 60m / 300s 同一個量級，不是憑空的數字：
 *
 *   半徑 80m —— GPS 誤差的量級。同車的兩支手機通常差不到 50m，
 *               室內抖動收斂後的散布約 23m，兩者都進得來。
 *   進入 120s —— 短於此的接近是擦身而過（在路口等紅燈遇到）。
 *   解散 180s —— 比進入寬。**遲滯不可省**：沒有它，兩個人在門檻附近走一段路，
 *               畫面上的隊形就會瘋狂閃爍。過馬路分開半分鐘不該散隊。
 */
const CONVOY_RADIUS_M = 80;
const CONVOY_JOIN_MS = 120 * 1000;
const CONVOY_PART_MS = 180 * 1000;

/*
 * ── 同遊判定（趟層）────────────────────────────────────────────────────────
 *
 * 上面那三個參數判的是「此刻兩顆頭離多近」，它有個治不好的毛病：80 公尺在時速 60
 * 只有 4.8 秒。兩個人的 GPSLogger 取樣間隔不一樣（1 秒 vs 60 秒），貼路之後的時間
 * 是沿線內插出來的 —— 同一台車上的兩支手機，內插位置沿著路差兩三百公尺很正常，
 * 於是明明同車卻判成沒同行。要靠放大半徑救就得放到 300m 以上，那在夜市、園區、
 * 住宅區又會把根本沒同行的人硬湊成一台。
 *
 * 所以改成兩層：**先用「兩條路重疊多少」判定整趟是不是一起出遊**（這一組參數），
 * 判定成立的區間裡「合體是預設」，只有真的分頭走一段才拆開（下一組參數）。
 * 沒被判成同遊的時候，仍然走上面那套逐時刻的近距離規則 —— 那一套管的是停留、
 * 在家、在餐廳這些「不是一趟移動」的靠近，拿掉會退步。
 *
 * 為什麼用貼路軌跡：貼完路的線落在道路中心線上，「同一條路」變成幾何上的重合，
 * 比兩點直線距離乾淨得多。而且貼路結果本來就照速度切成一趟一趟的移動
 * （見 map/page.tsx 的 extractTrips），停留的雜訊已經被剃掉，那正是「有效軌跡」。
 */

/** 每一趟重新等距取樣的步長。比對是逐樣本做的，等距才等於「距離加權」 */
const TRIP_SAMPLE_M = 25;
/** 兩條貼路線多近算「走在同一條路上」。道路寬度 ＋ 貼路誤差的量級 */
const TRIP_MATCH_M = 50;
/**
 * 時間容差。**沒有它，每天同一條路上下班就會被判成天天一起出遊**，
 * 去程回程走同一條路也會。5 分鐘夠寬，吸收得掉取樣密度造成的沿路偏移。
 */
const TRIP_TIME_TOL_MS = 5 * 60 * 1000;
/** 比這短的趟不判定 —— 幾百公尺的路誰都會重疊，比例沒有意義 */
const TRIP_MIN_LEN_M = 300;
/** 兩趟的時間至少要交疊這麼久才拿來比。擦身而過不算 */
const TRIP_MIN_OVERLAP_MS = 120 * 1000;
/** 保險絲：再長的一趟也不會取樣超過這個數量（步長自動放大） */
const TRIP_MAX_SAMPLES = 20000;
/**
 * 格網邊長。**刻意等於下面的分開距離**，這樣「找 50 公尺內」與「找 150 公尺內」
 * 兩種查詢都只要掃 3×3 個格子就保證不漏。
 */
const TRIP_CELL_M = 150;
/**
 * 相鄰兩次相遇之間隔多久還算**同一次出遊**。
 *
 * 判定單位是「一條路程」而不是「一趟」：去賣場的去程與回程中間隔著一個多小時的停留，
 * 是同一次出遊的兩段，不該各自獨立判定 —— 只要其中一段的重疊率掉到門檻以下
 * （繞去加油、走了替代道路），那一段就會退回逐時刻規則而閃爍，那正是使用者抱怨的。
 * 整串合起來算重疊率，成立就整條路程鎖定合體。
 *
 * 3 小時：吃得下賣場、吃飯、景點的停留，但早上一起上班與晚上各自出門會斷成兩次出遊，
 * 不會互相拖累 ——「整天算一次」那個做法的退步之處就在這裡（晚上各自跑的大量里程
 * 會把整天的比例拉到門檻以下，連早上一起上班那段都不合體了）。
 */
const OUTING_GAP_MS = 3 * 60 * 60 * 1000;

/*
 * 同遊區間**裡面**的分開判定。門檻比上面那套鬆很多，因為「這一趟是一起出遊」
 * 已經成立了 —— 這裡問的只是「他現在是不是真的岔開走了另一條路」。
 *
 * 距離量的是「離對方那條貼路線多遠」而不是兩人的直線距離：同一條路上一前一後
 * 差 200 公尺不是分開，繞去隔壁巷子買東西才是。距離本身也做遲滯（150 出、100 進），
 * 不然在門檻附近走一段路，隊形會一直閃。
 */
const CONVOY_SPLIT_M = 150;
const CONVOY_REJOIN_M = 100;
/**
 * 離開對方那條路要持續這麼久才拆開。
 *
 * 只要 2 分鐘，比上面那套的 180 秒還短 —— 因為量的是「離對方那條**路線**多遠」
 * 而不是兩顆頭的直線距離：一前一後差一公里、在同一條路上停下來加油、
 * 等紅燈落後一個路口，距離都還是 0，本來就不會誤判成分開。
 * 會超過 150 公尺的只剩「他真的轉進了另一條街」，那撐兩分鐘就該讓動畫分開走 ——
 * 使用者要的正是「中間短暫分開的那一段要看得到分開」。
 */
const CONVOY_SPLIT_MS = 120 * 1000;
/**
 * 前後兩個節點差超過這麼久，中間那一段就**不是真的在移動**，而是資料空隙。
 *
 * 頭的位置是沿著節點內插出來的，跨過空隙的內插等於一路瞬間位移；換軌跡段
 * （`breakBefore`）更直接 —— 頭會凍結在原地然後跳到下一段的起點。那段期間算出來的
 * 距離不是「他離對方多遠」而是「資料斷在哪裡」，拿去判分開會把同車的人硬拆開。
 * 所以這種時刻**整個跳過**：不累積拆隊、也不累積復合，隊形維持原狀，
 * 等兩邊都重新有真實取樣點再繼續算。
 */
const HEAD_SOLID_GAP_MS = 3 * 60 * 1000;

/** 彩虹漸層的取樣段數。maplibre 是在 sRGB 裡內插，段數太少中間會發灰 */
const CONVOY_HUE_STOPS = 18;
/** 流動一輪的時間。太快像跑馬燈，太慢看不出在動 */
const CONVOY_FLOW_MS = 3000;
/** 流動的更新間隔（≈20fps）。這是常駐的迴圈，沒必要每一幀都重算一次漸層 */
const CONVOY_FLOW_STEP_MS = 50;

/*
 * 落在中斷裡多久就讓這個人的頭消失。
 *
 * 中斷有兩種：換軌跡段（手機停止錄製再開始）與超過 MAX_GAP_MS。短的那種
 * 停在原地就好，讓頭消失半分鐘只會變成閃爍；長的那種代表「這段時間他根本沒出門」，
 * 照計畫那個頭不該出現，而不是卡在他上次的位置上。
 *
 * 停留不受影響 —— 停留是同座標的兩個點，中間沒有 breakBefore，人確實在那裡。
 */
const HEAD_HIDE_GAP_MS = 30 * 60 * 1000;

/*
 * 車上那幾顆頭怎麼排。
 *
 * 合體（同行）時是**同一台車上冒出好幾顆頭**，不是好幾台車 —— 一起出門的人
 * 本來就在同一台車上，畫成三台各走各的反而看不出他們在一起。人多車就寬一點，
 * 頭則往兩邊排開、高低錯開，免得後面的人被前面的人整顆擋住。
 *
 * 下面全是**螢幕像素**，所以每一幀都要 map.project／unproject 換算回經緯度 ——
 * 縮放地圖時頭才會一直好好坐在車上，而不是隨著比例尺飛走。
 */
/** 兩顆頭的水平間距。比頭本身窄，讓他們稍微擠在一起，像擠在同一排座位上 */
const HEAD_STEP = 30;
/** 錯開的高度。奇數位的人坐低一點（後座），才不會兩顆頭完全重疊 */
const HEAD_TIER = 6;
/** 人多的時候頭縮小一點，不然四個人的頭會比整台車還寬 */
const HEAD_CROWD_SCALE = 0.85;
/** 車至少要有多寬（CSS px）才裝得下這幾顆頭。算車身縮放用 */
const CAR_BASE_W = 100;
/** 頭在車上的上下浮動幅度。每個人相位錯開，看起來就是各自在晃 */
const HEAD_BOB = 2.5;

/**
 * 判斷車頭朝哪邊時，往回看多久（毫秒的軌跡時間）。
 *
 * 太短會在停等紅燈時抖成一片（位移是零，方向由雜訊決定），
 * 太長則轉彎之後車頭要等很久才轉過來。
 */
const FACING_LOOKBACK_MS = 60 * 1000;
/** 螢幕上位移超過這麼多像素才改變朝向。低於它就維持上一次的決定 */
const FACING_HYSTERESIS_PX = 6;

// 地圖上最多同時保留幾張縮圖。超過就退回圓點 ——
// 每張都是一塊要留在 GPU 上的貼圖，不設上限的話大相簿會把記憶體吃光。
const MAX_THUMBS = 200;

// 照片在地圖上畫成「對話框泡泡」：圓角白框裝著照片，底下一根尾巴指著座標。
// 下面全是 CSS px，實際貼圖以 BUBBLE_PR 倍解析度畫，再靠 pixelRatio 交還給 maplibre
// （直接畫成 CSS 尺寸的話，放大到 icon-size 1.5 會糊掉）。
const BUBBLE_PR = 2;
const BUBBLE_W = 84;
const BUBBLE_H = 84;
/** 尾巴高度。泡泡本體離座標多遠就是靠它 */
const BUBBLE_TAIL = 14;
/** 四周留白，純粹是給陰影用的；畫圖時要扣掉，錨點也要補回來（見 icon-offset） */
const BUBBLE_PAD = 8;
/** 白框粗細與圓角。圓角刻意放很大 —— 泡泡「可愛」的主要來源就是這個 */
const BUBBLE_BORDER = 5;
const BUBBLE_RADIUS = 24;

// 泡泡外圈的糖果色。依 id 取模挑一個，讓一整片泡泡看起來熱鬧而不是一片白。
// 不帶任何語意（不代表座標來源、不代表相簿），純裝飾
const BUBBLE_RINGS = ['#f472b6', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#fb7185'];

/**
 * 代表照的挑法：把「這次載入抽的亂數」放高位、照片 id 放低位打包成一個數字，
 * 交給 maplibre 的 clusterProperties 用 max 累加 —— 累加完的最大值，
 * 就等於這一叢裡隨機抽中的那一張。
 *
 * 拿 max 而不是別的：clusterProperties 只吃 min/max/sum 這類可結合的累加器，
 * 沒有「隨便給我一個」可用。低位留 1e9 給 id，高位亂數上限 1e5，
 * 乘起來 1e14 還在 double 的精確整數範圍（2^53）內。
 */
const REP_ID_MOD = 1e9;
const REP_RAND_MAX = 1e5;

/**
 * 「一坨」的判定半徑。同一本相簿、彼此在這個距離內的照片會被釘到同一個點上，
 * 攤成撲克牌那樣的扇形。
 *
 * 為什麼不是整本相簿取平均：一本相簿常常是一整趟旅行，橫跨好幾公里，
 * 取平均會把所有照片釘在一片什麼都沒有的空地上。要的是「同一個地方」而不是「同一本」。
 *
 * 40m 是照著泡泡的實際大小回推的 —— z19 時 1px ≈ 0.3m，泡泡約 126px 寬 ≈ 38m，
 * 也就是「在這個距離內就一定會疊在一起」的門檻。
 */
const PILE_RADIUS_M = 40;
/** 一坨最多攤開幾張。剩下的不畫，張數由徽章交代 */
const PILE_MAX_CARDS = 5;
/**
 * 扇形的總張角（度）。泡泡以尾巴尖端為旋轉中心（icon-rotate 是繞著 icon-anchor 轉的），
 * 所以這個角度直接就是牌面攤開的幅度：泡泡本體的中心約在支點上方 56px，
 * ±32° 換算過去大約是半個泡泡寬的間距，看得出是五張不同的照片又還疊著。
 */
const PILE_FAN_DEG = 64;

/** 每張照片畫在哪、怎麼擺。由 usePiles 算出來，只給 photos 這個 source 用 */
interface PileSlot {
  /** 釘住的座標（同一坨共用；單張就是它自己） */
  lng: number;
  lat: number;
  /** 這一坨總共幾張 */
  pile: number;
  /** 扇形裡的第幾張（0 起算）。-1 = 這張不畫 */
  fan: number;
  /** 旋轉角度（度） */
  angle: number;
}

// 跳到某一天的起點時用的縮放。街廓看得清楚，又不至於窄到看不出接下來往哪走。
// 固定值而不是「保留使用者目前的縮放」—— 從全球視野點進某一天，
// 沿用當下的縮放等於停在一片什麼都看不到的地方。
const FOCUS_ZOOM = 14;

/* ══ 多身分播放 ═══════════════════════════════════════════════════════════
 *
 * 播放頭從「路徑上的浮點索引」改成「UTC 時間游標」。
 *
 * 為什麼非改不可：多身分同框時每個人的取樣密度不一樣（一個 60 秒一點、一個
 * 10 秒一點，停留還被收成兩點），索引根本對不起來 —— 「第 300 點」在兩個人身上
 * 是完全不同的時刻。改成真實時間之後，每個人各自在自己的點陣列上依時間內插，
 * 畫面上看到的才是「同一個瞬間，大家分別在哪」。
 */

/** 一個成員自己的那條路徑。節點已依時間排好，breakBefore 是在**這個人自己**的序列上算的 */
interface MemberPath {
  userId: number | null;
  nodes: PathNode[];
}

/**
 * 某個成員在 UTC 時刻 t 的位置。回 null＝這個時候他的頭不該出現。
 *
 * 三種 null：時間游標早於他的第一點、晚於他的最後一點、或落在一段夠長的中斷裡
 * （見 HEAD_HIDE_GAP_MS）。前兩種就是「這段範圍他沒有資料」，第三種是「這段時間
 * 他沒出門」—— 都不該把他卡在上一個點上，那會讓人以為他真的待在那裡。
 */
function posAt(nodes: PathNode[], t: number): [number, number] | null {
  return sampleAt(nodes, t).pos;
}

/** `posAt` 的完整版：位置 ＋ 這一刻是不是踩在真實取樣上（見 HEAD_SOLID_GAP_MS） */
interface HeadSample {
  pos: [number, number] | null;
  /** false＝凍結或跨空隙內插出來的，位置可信但「移動」是假的，不可拿去判分開 */
  solid: boolean;
}

function sampleAt(nodes: PathNode[], t: number): HeadSample {
  const n = nodes.length;
  if (n === 0 || !Number.isFinite(t)) return { pos: null, solid: false };
  if (t < nodes[0].t || t > nodes[n - 1].t) return { pos: null, solid: false };

  // 最後一個時間 <= t 的節點
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  const a = nodes[lo];
  const b = lo + 1 < n ? nodes[lo + 1] : null;
  if (!b || b.t <= a.t) return { pos: [a.lng, a.lat], solid: true };
  if (b.breakBefore) {
    // 換軌跡段：短的凍結在原地（頭會突然跳到下一段起點），長的整顆消失
    return b.t - a.t > HEAD_HIDE_GAP_MS
      ? { pos: null, solid: false }
      : { pos: [a.lng, a.lat], solid: false };
  }
  const f = (t - a.t) / (b.t - a.t);
  return {
    pos: [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f],
    solid: b.t - a.t <= HEAD_SOLID_GAP_MS,
  };
}

/**
 * 時間 ↔ 播放進度的換算表。
 *
 * **播放進度不是時間，是「大家一共移動了多少公尺」。** 這是把原本那套
 * 弧長等速（依節點數前進的話，塞車時慢吞吞、高速公路上用瞬移的 —— GPS 是按時間
 * 取樣的，同樣的節點速率畫出來的畫面速度差好幾個數量級）
 * 搬到多身分之後的樣子 —— 只是「弧長」現在是所有成員位移的總和。
 *
 * 直接讓游標照真實時間等速跑是不行的：睡覺那八小時會佔掉三分之一的播放時間。
 * 改成依總位移前進之後，沒人在動的時段（半夜、停留、錄製中斷）位移是 0，
 * 游標一瞬間就跨過去；有人在動的時候才慢下來。
 *
 * `times` 是所有成員節點時間的**聯集**，所以任何一個人的線段都剛好落在整數個
 * 區間上，位移可以按時間比例攤進去，不必再找交點。
 */
interface TimeWarp {
  times: Float64Array;
  /** cum[i] = times[0] 到 times[i] 之間累積的位移量 */
  cum: Float64Array;
  total: number;
}

function buildWarp(members: MemberPath[]): TimeWarp {
  const set = new Set<number>();
  for (const m of members) for (const nd of m.nodes) set.add(nd.t);
  const times = Float64Array.from(Array.from(set).sort((a, b) => a - b));
  const k = times.length;
  const cum = new Float64Array(k);
  if (k < 2) return { times, cum, total: 0 };

  const idx = new Map<number, number>();
  for (let i = 0; i < k; i++) idx.set(times[i], i);

  const motion = new Float64Array(k - 1);
  for (const m of members) {
    for (let i = 1; i < m.nodes.length; i++) {
      const a = m.nodes[i - 1];
      const b = m.nodes[i];
      // 中斷那一段沒有走過，不該分到任何播放時間
      if (b.breakBefore) continue;
      const d = metersBetween(a.lat, a.lng, b.lat, b.lng);
      if (d <= 0) continue;
      const ia = idx.get(a.t);
      const ib = idx.get(b.t);
      if (ia === undefined || ib === undefined || ib <= ia) continue;
      const span = b.t - a.t;
      for (let j = ia; j < ib; j++) motion[j] += (d * (times[j + 1] - times[j])) / span;
    }
  }

  let total = 0;
  for (let j = 0; j < k - 1; j++) total += motion[j];
  /*
   * 整段完全沒有位移（照片全擠在同一點、或只有停留）就退回「照時間等速跑」。
   * 否則總量是 0，播放鍵按下去什麼事都不會發生 —— 舊的程式碼是用
   * nodesPerSec 這條退路處理同一件事。
   */
  if (total === 0) {
    for (let j = 0; j < k - 1; j++) motion[j] = times[j + 1] - times[j];
  }
  for (let j = 0; j < k - 1; j++) cum[j + 1] = cum[j] + motion[j];
  return { times, cum, total: cum[k - 1] };
}

/** 播放進度 → UTC 時刻 */
function timeAtProgress(w: TimeWarp, p: number): number {
  const k = w.times.length;
  if (k === 0) return NaN;
  if (k === 1 || p <= 0) return w.times[0];
  if (p >= w.cum[k - 1]) return w.times[k - 1];
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w.cum[mid] <= p) lo = mid; else hi = mid - 1;
  }
  const span = w.cum[lo + 1] - w.cum[lo];
  if (span <= 0) return w.times[lo];
  return w.times[lo] + (w.times[lo + 1] - w.times[lo]) * ((p - w.cum[lo]) / span);
}

/** UTC 時刻 → 播放進度。點照片跳到那個時間點用的 */
function progressAtTime(w: TimeWarp, t: number): number {
  const k = w.times.length;
  if (k === 0 || !Number.isFinite(t)) return 0;
  if (t <= w.times[0]) return 0;
  if (t >= w.times[k - 1]) return w.cum[k - 1];
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w.times[mid] <= t) lo = mid; else hi = mid - 1;
  }
  const dt = w.times[lo + 1] - w.times[lo];
  const f = dt > 0 ? (t - w.times[lo]) / dt : 0;
  return w.cum[lo] + (w.cum[lo + 1] - w.cum[lo]) * f;
}

/* ── 同遊判定的第一層：把貼路軌跡切成「一趟」，算兩趟重疊多少 ─────────────── */

/**
 * 公尺平面。**整份資料共用同一個原點**，不同人的兩趟座標才比得起來。
 *
 * 用等距圓柱投影而不是每次都算 haversine：比對是逐樣本做的，一次重算幾十萬次距離，
 * 而家族的活動範圍頂多幾百公里 —— 在那個尺度上這個近似的誤差遠小於 50 公尺的判定門檻。
 */
interface Projector {
  lat0: number;
  lng0: number;
  kx: number;
  ky: number;
}

function makeProjector(lat0: number, lng0: number): Projector {
  return { lat0, lng0, kx: 111320 * Math.cos((lat0 * Math.PI) / 180), ky: 110540 };
}

const projX = (p: Projector, lng: number) => (lng - p.lng0) * p.kx;
const projY = (p: Projector, lat: number) => (lat - p.lat0) * p.ky;

/** 格子鍵。邊長 TRIP_CELL_M，3×3 個格子保證涵蓋查詢點周圍 TRIP_CELL_M 公尺 */
const cellKey = (x: number, y: number) =>
  `${Math.floor(x / TRIP_CELL_M)},${Math.floor(y / TRIP_CELL_M)}`;

/** 一趟移動：貼路結果的一個 segment，等距重新取樣＋建好格網索引之後的樣子 */
interface Trip {
  userId: number | null;
  x: Float64Array;
  y: Float64Array;
  t: Float64Array;
  /** 取樣後的頭尾時間 */
  t0: number;
  t1: number;
  /** 'cx,cy' → 落在那一格的樣本索引 */
  grid: Map<string, number[]>;
}

/**
 * 把軌跡點切成一趟一趟，各自等距重新取樣。
 *
 * 為什麼要重新取樣：貼路結果的頂點密度是**道路幾何**決定的 —— 彎道上十幾公尺一個，
 * 高速公路直線段可以隔好幾百公尺。直接拿原始頂點逐點比會在直線段整段漏掉，
 * 而且「幾成的點重疊」會被彎道的密集頂點灌水。等距取樣之後，
 * 「幾成的樣本重疊」就直接等於「幾成的路重疊」。
 *
 * 這裡刻意**只吃軌跡點、不吃照片節點** —— 照片的 EXIF 座標不在路上，
 * 混進來會把這一趟的形狀往外拉。
 */
function buildTrips(
  points: TrackPoint[],
  ownerByDay: Map<string, number>,
  proj: Projector,
): Trip[] {
  // 鍵帶上人：day_key 只有非站長才有使用者前綴，光看 segment 有可能把兩個人
  // 的點混進同一趟，而一趟只認一個主人 —— 混到就是整趟掛錯人
  const bySeg = new Map<string, { user: number | null; pts: TrackPoint[] }>();
  for (const p of points) {
    const user = p.user_id ?? ownerByDay.get(p.day_key) ?? null;
    const key = `${user}@${segmentKey(p.day_key, p.seg)}`;
    const hit = bySeg.get(key);
    if (hit) hit.pts.push(p); else bySeg.set(key, { user, pts: [p] });
  }

  const out: Trip[] = [];
  for (const { user, pts: list } of Array.from(bySeg.values())) {
    const raw = list
      .map((p) => ({
        x: projX(proj, p.lng),
        y: projY(proj, p.lat),
        t: Date.parse(p.t_utc),
      }))
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
    if (raw.length < 2) continue;

    let total = 0;
    for (let i = 1; i < raw.length; i++) {
      total += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    }
    // 幾百公尺的路誰都會重疊，比例算出來沒有意義
    if (total < TRIP_MIN_LEN_M) continue;

    const step = Math.max(TRIP_SAMPLE_M, total / TRIP_MAX_SAMPLES);
    const xs: number[] = [];
    const ys: number[] = [];
    const ts: number[] = [];
    const push = (x: number, y: number, t: number) => { xs.push(x); ys.push(y); ts.push(t); };

    push(raw[0].x, raw[0].y, raw[0].t);
    let need = step;
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1];
      const b = raw[i];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      // 停留是兩個同座標的點，距離 0 —— 跳過它不會漏掉路，時間照樣由後面補上
      if (d <= 0) continue;
      let pos = 0;
      while (need <= d - pos) {
        pos += need;
        const f = pos / d;
        // 時間也照**距離**內插。貼路點夠密，跟照時間內插的差距遠小於 5 分鐘的容差
        push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.t + (b.t - a.t) * f);
        need = step;
      }
      need -= d - pos;
    }
    // 尾點一定要收：最後不足一步的那一段也是走過的路
    const last = raw[raw.length - 1];
    if (xs[xs.length - 1] !== last.x || ys[ys.length - 1] !== last.y) {
      push(last.x, last.y, last.t);
    }

    const grid = new Map<string, number[]>();
    for (let i = 0; i < xs.length; i++) {
      const key = cellKey(xs[i], ys[i]);
      const bucket = grid.get(key);
      if (bucket) bucket.push(i); else grid.set(key, [i]);
    }

    out.push({
      userId: user,
      x: Float64Array.from(xs),
      y: Float64Array.from(ys),
      t: Float64Array.from(ts),
      t0: ts[0],
      t1: ts[ts.length - 1],
      grid,
    });
  }
  return out;
}

/**
 * 這個點離那一趟的路最近有多遠（公尺）。找不到回 `Infinity`。
 *
 * **只認時間也對得上的樣本**（±TRIP_TIME_TOL_MS）—— 沒有這一刀，每天走同一條路
 * 上下班會被判成天天一起出遊，去程回程走同一條路也會。
 *
 * ⚠️ 只掃 3×3 格，所以回傳值在**超過 TRIP_CELL_M 之後就不保證是真的最近距離**。
 *    呼叫端只拿它跟 50／150／100 這幾個門檻比大小，都在保證範圍內。
 */
function nearestDist(trip: Trip, x: number, y: number, t: number): number {
  const cx = Math.floor(x / TRIP_CELL_M);
  const cy = Math.floor(y / TRIP_CELL_M);
  let best = Infinity;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const bucket = trip.grid.get(`${cx + ox},${cy + oy}`);
      if (!bucket) continue;
      for (const i of bucket) {
        if (Math.abs(trip.t[i] - t) > TRIP_TIME_TOL_MS) continue;
        const d = Math.hypot(trip.x[i] - x, trip.y[i] - y);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** 離這一群趟裡最近的那條線多遠 */
function nearestDistAny(trips: Trip[], x: number, y: number, t: number): number {
  let best = Infinity;
  for (const tr of trips) {
    const d = nearestDist(tr, x, y, t);
    if (d < best) best = d;
  }
  return best;
}

/** as 這幾趟加起來，有幾成的路走在 bs 那幾趟上面 */
function overlapAcross(as: Trip[], bs: Trip[]): number {
  let hit = 0;
  let total = 0;
  for (const a of as) {
    for (let i = 0; i < a.t.length; i++) {
      total++;
      if (nearestDistAny(bs, a.x[i], a.y[i], a.t[i]) <= TRIP_MATCH_M) hit++;
    }
  }
  return total > 0 ? hit / total : 0;
}

/** 判定成一起出遊的一條路程。a 一定是成員索引較小的那個人的那幾趟 */
interface JointEpisode {
  t0: number;
  t1: number;
  a: Trip[];
  b: Trip[];
}

/**
 * 哪幾條路程是一起出遊的。鍵是成員索引配對 `${小}:${大}`。
 *
 * 三步：
 *
 * 1. **相遇** —— 兩人時間有交集（≥ TRIP_MIN_OVERLAP_MS）的每一對趟。
 * 2. **串成一次出遊** —— 相鄰兩次相遇的空隙 ≤ OUTING_GAP_MS 就併起來。
 *    賣場的「去程＋停留一小時＋回程」在這一步變成一條路程。
 * 3. **整串算一次重疊率** —— 一次出遊裡兩人各自所有趟的樣本合起來當分母。
 *    這是使用者要的「先判定整條路程是不是一起出遊」：其中一段繞去加油、
 *    走了替代道路而單獨看不到門檻，整條路程仍然成立，動畫不會在那一段閃掉。
 *
 * 分母**取兩人裡移動距離較短的那個**（實作上就是兩個方向的比例取大的）：
 * 老婆中途下車回家、我又多開了一段，前半段仍然算同遊 —— 這是使用者拍板的。
 *
 * 區間取的是**整條路程的時間範圍**（涵蓋中間的停留），不是重疊樣本的範圍：
 * 成立之後合體就是鎖定的預設，中間真的分頭走才由 buildConvoys 的 150m／2 分鐘拆開。
 */
function buildJointTrips(
  trips: Trip[],
  indexOf: Map<number | null, number>,
  pct: number,
): Map<string, JointEpisode[]> {
  const out = new Map<string, JointEpisode[]>();
  const threshold = pct / 100;

  // 先照成員分組。趟數不多，但這樣配對迴圈只跑「不同人」的組合
  const byMember = new Map<number, Trip[]>();
  for (const tr of trips) {
    const idx = indexOf.get(tr.userId);
    if (idx === undefined) continue;
    const list = byMember.get(idx);
    if (list) list.push(tr); else byMember.set(idx, [tr]);
  }
  const idxs = Array.from(byMember.keys()).sort((p, q) => p - q);

  for (let i = 0; i < idxs.length; i++) {
    for (let j = i + 1; j < idxs.length; j++) {
      const ia = idxs[i];
      const ib = idxs[j];
      const A = byMember.get(ia)!;
      const B = byMember.get(ib)!;

      // ① 相遇：時間先篩，這一刀砍掉絕大多數的配對，幾何比對才不會變成災難
      const enc: { t0: number; t1: number; a: Trip; b: Trip }[] = [];
      for (const a of A) {
        for (const b of B) {
          const lo = Math.max(a.t0, b.t0);
          const hi = Math.min(a.t1, b.t1);
          if (hi - lo >= TRIP_MIN_OVERLAP_MS) enc.push({ t0: lo, t1: hi, a, b });
        }
      }
      if (enc.length === 0) continue;
      enc.sort((p, q) => p.t0 - q.t0);

      // ② 串成一次出遊
      const outings: { a: Set<Trip>; b: Set<Trip>; end: number }[] = [];
      for (const e of enc) {
        const cur = outings[outings.length - 1];
        if (cur && e.t0 - cur.end <= OUTING_GAP_MS) {
          cur.a.add(e.a);
          cur.b.add(e.b);
          if (e.t1 > cur.end) cur.end = e.t1;
        } else {
          outings.push({ a: new Set([e.a]), b: new Set([e.b]), end: e.t1 });
        }
      }

      // ③ 整串算一次重疊率
      for (const o of outings) {
        const as = Array.from(o.a);
        const bs = Array.from(o.b);
        if (Math.max(overlapAcross(as, bs), overlapAcross(bs, as)) < threshold) continue;

        let t0 = Infinity;
        let t1 = -Infinity;
        for (const tr of as) { if (tr.t0 < t0) t0 = tr.t0; if (tr.t1 > t1) t1 = tr.t1; }
        for (const tr of bs) { if (tr.t0 < t0) t0 = tr.t0; if (tr.t1 > t1) t1 = tr.t1; }
        if (!(t1 > t0)) continue;

        const ep: JointEpisode = { t0, t1, a: as, b: bs };
        const key = `${ia}:${ib}`;
        const list = out.get(key);
        if (list) list.push(ep); else out.set(key, [ep]);
      }
    }
  }

  // 播放時是照時間往前掃的指標，所以要排好；被前一段完全包住的直接丟掉，
  // 不然指標會停在長的那一段上，把短的那一段整個跳過
  for (const list of Array.from(out.values())) {
    list.sort((p, q) => p.t0 - q.t0 || p.t1 - q.t1);
    // ⚠️ 一定要**正向**掃：list 照 t0 由小到大排，end 要是「前一段」的結束時間。
    // 反過來從尾巴掃的話 end 會變成最後一段的結束時間，於是每一段更早的區間都
    // 滿足 t1 <= end 而被刪光 —— 一整天只會剩最後一趟是同遊。
    let end = -Infinity;
    for (let k = 0; k < list.length; ) {
      if (list[k].t1 <= end) list.splice(k, 1);
      else { end = list[k].t1; k += 1; }
    }
  }
  return out;
}

/** 某一段時間裡的隊形。groups 裡是 members 陣列的索引，只收兩人以上的組 */
interface ConvoyFrame {
  t: number;
  groups: number[][];
}

/**
 * 逐時刻算同行，**先算完整條時間軸再存起來**。
 *
 * 不能在播放時當場算：遲滯要看「靠近／分開持續了多久」，那是一路累積下來的狀態，
 * 拖時間軸跳著看的話當場算會得到跟順著播完全不同的隊形。
 *
 * 只在隊形**改變**的時刻記一筆 —— 遲滯本來就讓隊形很少變，一整天大概幾十筆，
 * 播放時二分找一下就好，不必每個關鍵時刻都存一份。
 *
 * 成本 K × C(N,2)：家庭 N ≤ 5 就是每個時刻最多 10 次距離計算，
 * 兩萬個時刻也才二十萬次，資料變動時算一次而已。
 *
 * 兩套規則並存，不是二選一：
 *
 * - **在同遊區間裡**（`joint`，由整條路程的重疊率判定）→ **預設合體**，
 *   只有「離開對方那條貼路線 >150m 而且撐過 2 分鐘」才拆開，回到 100m 內立刻復合。
 *   逐時刻的 80m 在這裡不管用：時速 60 公里跑 80 公尺只要 4.8 秒，
 *   兩支 logger 取樣間隔不同（1 秒 vs 60 秒）再各自內插，同一台車上的兩個人
 *   在時間軸上就能差到好幾百公尺，於是一路閃爍分合。
 * - **區間外**→ 原本的 80m／120s／180s 照舊。那條規則管的是**停留時的靠近**
 *   （在家、在餐廳），而停留早就被 `extractTrips` 從貼路軌跡裡切掉了，
 *   拿掉它會退步。
 */
function buildConvoys(
  members: MemberPath[],
  times: Float64Array,
  joint: Map<string, JointEpisode[]>,
  proj: Projector,
): ConvoyFrame[] {
  const n = members.length;
  if (n < 2 || times.length === 0) return [];

  const pairs = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      pairs.push({
        a, b,
        together: false, closeSince: NaN, farSince: NaN,
        // 同遊區間照時間排好了，指標只往前走，不必每個時刻都二分找
        eps: joint.get(`${a}:${b}`) ?? [],
        ep: 0,
        epMark: null as JointEpisode | null,
        awaySince: NaN,
      });
    }
  }

  const out: ConvoyFrame[] = [];
  const smp = new Array<HeadSample>(n);
  const pos = new Array<[number, number] | null>(n);
  // null 一定跟第一次算出來的 key（字串）不一樣，所以起手必定記一筆
  let lastKey: string | null = null;

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    for (let m = 0; m < n; m++) {
      smp[m] = sampleAt(members[m].nodes, t);
      pos[m] = smp[m].pos;
    }

    for (const pr of pairs) {
      const pa = pos[pr.a];
      const pb = pos[pr.b];
      if (!pa || !pb) {
        // 有一方這時候不在畫面上就不算同行，而且遲滯狀態整個重來 ——
        // 他再出現時是「重新遇到」，該重新等滿 120 秒
        pr.together = false;
        pr.closeSince = NaN;
        pr.farSince = NaN;
        pr.awaySince = NaN;
        pr.epMark = null;
        continue;
      }

      while (pr.ep < pr.eps.length && pr.eps[pr.ep].t1 < t) pr.ep++;
      const ep = pr.ep < pr.eps.length && pr.eps[pr.ep].t0 <= t ? pr.eps[pr.ep] : null;

      /*
       * 任一方正踩在資料空隙上就整個跳過（見 HEAD_SOLID_GAP_MS）。
       *
       * 空隙期間的「移動」是內插或凍結出來的假象 —— 換軌跡段時頭會停在原地
       * 再瞬間跳到下一段起點，那一瞬的距離可以是好幾公里。拿它去累積拆隊，
       * 同車的人會在每個段落交界被硬拆一次。維持原狀、不動任何計時器，
       * 等兩邊都重新踩在真實取樣上再繼續算。
       */
      if (!smp[pr.a].solid || !smp[pr.b].solid) continue;

      if (ep) {
        // 一進到新的一條同遊路程就先合體 —— 「整條路程有七成的路重疊」已經是結論，
        // 不需要再讓逐時刻的距離重新證明一次
        if (pr.epMark !== ep) {
          pr.epMark = ep;
          pr.together = true;
          pr.awaySince = NaN;
        }
        // 誰在誰的路上都算 —— 取兩個方向的較小值，偏向合體，那是同遊該有的預設。
        // 比的是整條路程的所有趟，中途換到下一趟不會憑空多出一次「離開對方路線」
        const ax = projX(proj, pa[0]);
        const ay = projY(proj, pa[1]);
        const bx = projX(proj, pb[0]);
        const by = projY(proj, pb[1]);
        const d = Math.min(nearestDistAny(ep.b, ax, ay, t), nearestDistAny(ep.a, bx, by, t));
        if (d > CONVOY_SPLIT_M) {
          if (!Number.isFinite(pr.awaySince)) pr.awaySince = t;
          if (t - pr.awaySince >= CONVOY_SPLIT_MS) pr.together = false;
        } else {
          pr.awaySince = NaN;
          // 回到對方路線 100m 內立刻復合：拆開要撐滿 2 分鐘、復合卻是立即的。
          // 100～150 這段空白帶不動作，維持現狀，免得剛好卡在門檻上抖
          if (d <= CONVOY_REJOIN_M) pr.together = true;
        }
        // 逐時刻那套的計時器要清掉，不然會帶著舊帳走出同遊區間
        pr.closeSince = NaN;
        pr.farSince = NaN;
        continue;
      }
      pr.awaySince = NaN;
      pr.epMark = null;

      const close = metersBetween(pa[1], pa[0], pb[1], pb[0]) <= CONVOY_RADIUS_M;
      if (pr.together) {
        if (close) {
          pr.farSince = NaN;
        } else {
          if (!Number.isFinite(pr.farSince)) pr.farSince = t;
          if (t - pr.farSince >= CONVOY_PART_MS) {
            pr.together = false;
            pr.closeSince = NaN;
            pr.farSince = NaN;
          }
        }
      } else if (close) {
        if (!Number.isFinite(pr.closeSince)) pr.closeSince = t;
        if (t - pr.closeSince >= CONVOY_JOIN_MS) {
          pr.together = true;
          pr.closeSince = NaN;
          pr.farSince = NaN;
        }
      } else {
        pr.closeSince = NaN;
      }
    }

    // 同行是可以傳遞的：A 跟 B 同車、B 跟 C 同車，三個人就是同一台。
    // 併集找連通分量（n 很小，路徑壓縮就夠了，不必按秩合併）
    const parent = Array.from({ length: n }, (_, x) => x);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const pr of pairs) {
      if (!pr.together) continue;
      const ra = find(pr.a);
      const rb = find(pr.b);
      if (ra !== rb) parent[ra] = rb;
    }
    const byRoot = new Map<number, number[]>();
    for (let m = 0; m < n; m++) {
      if (!pos[m]) continue;
      const r = find(m);
      const list = byRoot.get(r);
      if (list) list.push(m); else byRoot.set(r, [m]);
    }
    const groups = Array.from(byRoot.values()).filter((g) => g.length >= 2);
    const key = groups.map((g) => g.join('+')).sort().join('|');
    if (key !== lastKey) {
      out.push({ t, groups });
      lastKey = key;
    }
  }
  return out;
}

/** 時間游標落在哪一個隊形上 */
function convoyAt(frames: ConvoyFrame[], t: number): number[][] {
  if (frames.length === 0 || !Number.isFinite(t) || t < frames[0].t) return [];
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return frames[lo].groups;
}

/* ── 合體那幾段的彩虹線 ────────────────────────────────────────────────────
 *
 * 使用者要的是「一起出遊的那一段路，線變成漸層七彩繽紛的流動線條」。三個拍板的取捨：
 *
 * - **範圍跟畫面上那顆合體圖示同一份判定** —— 直接吃 buildConvoys 的隊形變化表，
 *   不是整條同遊路程。中間真的分開的那一段，車子拆成兩顆、線也就斷回各自的顏色。
 * - **一直流動**，不是只有按播放的時候才流。
 * - **那一段整個換成彩虹**：兩個人原本的線在合體段挖掉，只留一條。各自的顏色
 *   壓在彩虹底下只會把顏色弄髒，而「誰跟誰」看車上那幾顆大頭就知道。
 *
 * 全在瀏覽器算 —— 貼路結果本來就在前端手上，不多打任何一次 API。
 */

/** 一段時間區間（UTC 毫秒） */
interface Span { t0: number; t1: number }

/** 接在前一段屁股上的就併起來 —— 隊形表是逐格記的，不併會碎成幾百段 */
function pushSpan(list: Span[], t0: number, t1: number) {
  const last = list[list.length - 1];
  if (last && t0 <= last.t1) {
    if (t1 > last.t1) last.t1 = t1;
    return;
  }
  list.push({ t0, t1 });
}

/**
 * 隊形變化表 → 每個人的兩組區間：
 *
 * - `merged`：這段時間他在某台合體車上（他自己那條線要挖掉）
 * - `lead`：這段時間**由他代表**那台車（彩虹畫他這一條）
 *
 * 彩虹只畫代表的那一個：合體時兩條線幾乎重合，各畫一條彩虹會互相干擾，
 * 兩條的漸層相位也對不起來。代表取組裡索引最小的那個，同一組永遠選到同一個人。
 */
function convoySpans(
  frames: ConvoyFrame[], times: Float64Array, n: number,
): { merged: Span[][]; lead: Span[][] } {
  const merged: Span[][] = [];
  const lead: Span[][] = [];
  for (let i = 0; i < n; i++) { merged.push([]); lead.push([]); }
  if (frames.length === 0 || times.length === 0) return { merged, lead };
  const end = times[times.length - 1];
  for (let i = 0; i < frames.length; i++) {
    const t0 = frames[i].t;
    const t1 = i + 1 < frames.length ? frames[i + 1].t : end;
    if (!(t1 > t0)) continue;
    for (const g of frames[i].groups) {
      let head = Infinity;
      for (const m of g) {
        if (m >= 0 && m < n) pushSpan(merged[m], t0, t1);
        if (m < head) head = m;
      }
      if (head >= 0 && head < n) pushSpan(lead[head], t0, t1);
    }
  }
  return { merged, lead };
}

/** 這個時刻有沒有落在區間裡。區間照時間排好且不重疊，二分即可 */
function inSpans(spans: Span[], t: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < spans[mid].t0) hi = mid - 1;
    else if (t > spans[mid].t1) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 把一條折線照區間切成「在裡面」與「在外面」兩堆。
 *
 * ⚠️ 交界那一點**兩邊都要放**，不然彩虹跟各自顏色的線之間會露出一小截空白。
 */
function splitLineBySpans(
  l: TrackLine, spans: Span[],
): { inside: TrackLine[]; outside: TrackLine[] } {
  const inside: TrackLine[] = [];
  const outside: TrackLine[] = [];
  if (spans.length === 0 || l.times.length !== l.line.length) {
    return { inside, outside: [l] };
  }
  let line: [number, number][] = [l.line[0]];
  let times: number[] = [l.times[0]];
  let curIn = inSpans(spans, l.times[0]);
  const flush = () => {
    if (line.length >= 2) (curIn ? inside : outside).push({ userId: l.userId, line, times });
  };
  for (let i = 1; i < l.line.length; i++) {
    const isIn = inSpans(spans, l.times[i]);
    line.push(l.line[i]);
    times.push(l.times[i]);
    if (isIn !== curIn) {
      flush();
      line = [l.line[i]];
      times = [l.times[i]];
      curIn = isIn;
    }
  }
  flush();
  return { inside, outside };
}

/** 彩虹的漸層。`phase` 0→1 轉一圈，每一幀往前挪一點就是流動 */
function convoyGradient(phase: number): unknown[] {
  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']];
  for (let i = 0; i <= CONVOY_HUE_STOPS; i++) {
    const p = i / CONVOY_HUE_STOPS;
    // 整條線剛好一輪 —— 兩端同色，挪動的時候才看不出接縫
    const hue = Math.round(((((p - phase) % 1) + 1) % 1) * 360);
    expr.push(p, `hsl(${hue}, 95%, 55%)`);
  }
  return expr;
}

/** 播放列上的時間。多身分之後「第幾點／共幾點」沒有意義了 —— 每個人的點數不一樣 */
function cursorLabel(t: number): string {
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString([], {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** 'YYYY-MM-DD HH:MM:SS' → 顯示用的短字串 */
function shortTime(local: string): string {
  if (!local) return '';
  const [d, t] = local.split(' ');
  return t ? `${d} ${t.slice(0, 5)}` : d;
}

/** 照片的 UTC 毫秒。沒有 taken_at 就只能拿當地時間頂著 */
function photoUtcMs(p: FootprintPoint): number | null {
  if (p.taken_at) {
    const t = Date.parse(p.taken_at);
    if (Number.isFinite(t)) return t;
  }
  // 退而求其次：把當地時間當成 UTC。照片之間的先後順序仍然正確，
  // 但跟軌跡混排時會偏掉一個時區 —— 這種照片本來就沒有可靠的絕對時間
  if (p.local_time) {
    const t = Date.parse(`${p.local_time.replace(' ', 'T')}Z`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** 圓角矩形路徑。不用 ctx.roundRect —— 它比較新，而且各家 TS lib 版本有無不定 */
function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 對話框泡泡的外框路徑：圓角矩形 + 底部朝下的尾巴，一條路徑走完。
 *
 * 尾巴不另外畫一個三角形疊上去 —— 分開畫的話白框的接縫會露出來，
 * 而且外圈那條糖果色描邊會從尾巴根部橫切過去。
 * 尾巴尖端固定在正中央：錨點就是靠它對準座標的。
 */
function bubblePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, tail: number) {
  const cx = x + w / 2;
  const half = tail * 0.62; // 尾巴根部的半寬
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(cx + half, y + h);
  ctx.lineTo(cx, y + h + tail);
  ctx.lineTo(cx - half, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * 把照片畫成地圖用的對話框泡泡。
 *
 * 走 canvas 是因為 map.addImage 要的是像素資料，不是 <img>。
 * 這需要圖片是 CORS-clean，/api/photos/view/ 有回 Access-Control-Allow-Origin: *，
 * 所以 crossOrigin='anonymous' 成立；少了它 canvas 會被污染，getImageData 會直接丟例外。
 *
 * ring 是外圈描邊的顏色，由呼叫端依 id 挑（見 BUBBLE_RINGS）。
 */
function loadBubble(url: string, ring: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.onload = () => {
      const wPx = (BUBBLE_W + BUBBLE_PAD * 2) * BUBBLE_PR;
      const hPx = (BUBBLE_H + BUBBLE_TAIL + BUBBLE_PAD * 2) * BUBBLE_PR;
      const canvas = document.createElement('canvas');
      canvas.width = wPx;
      canvas.height = hPx;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('取不到 canvas context')); return; }
      // 之後的座標一律用 CSS px 思考，解析度只是倍率
      ctx.scale(BUBBLE_PR, BUBBLE_PR);

      const x = BUBBLE_PAD;
      const y = BUBBLE_PAD;

      // 白框本體。順手投一層淡影，泡泡才會像是浮在底圖上而不是印在上面
      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 3;
      bubblePath(ctx, x, y, BUBBLE_W, BUBBLE_H, BUBBLE_RADIUS, BUBBLE_TAIL);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();

      // 照片：置中裁切（cover），不要把照片壓扁
      ctx.save();
      const ix = x + BUBBLE_BORDER;
      const iy = y + BUBBLE_BORDER;
      const iw = BUBBLE_W - BUBBLE_BORDER * 2;
      const ih = BUBBLE_H - BUBBLE_BORDER * 2;
      roundedRectPath(ctx, ix, iy, iw, ih, Math.max(BUBBLE_RADIUS - BUBBLE_BORDER, 2));
      ctx.clip();
      const side = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - side) / 2, (img.height - side) / 2, side, side,
        ix, iy, iw, ih,
      );
      ctx.restore();

      // 外圈糖果色描邊。畫在最後，才不會被照片蓋掉，也不會沾到上面那層陰影
      bubblePath(ctx, x, y, BUBBLE_W, BUBBLE_H, BUBBLE_RADIUS, BUBBLE_TAIL);
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = ring;
      ctx.stroke();

      try {
        resolve(ctx.getImageData(0, 0, wPx, hPx));
      } catch (err) {
        reject(err as Error);
      }
    };
    img.src = url;
  });
}

/** 秒數 → '3 小時 20 分' 這種給人看的長度 */
function humanDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} 分`;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}

/**
 * 把擠在同一個地方的照片收成一坨，決定每張畫在哪、擺成什麼角度。
 *
 * 分組是貪婪的「領頭者」法：照時間掃過去，落在某一坨的質心 PILE_RADIUS_M 內
 * 且同一本相簿就併進去，質心跟著更新，否則自己開一坨。O(n × 坨數)，
 * 幾百張照片綽綽有餘，不值得為它拉一套空間索引進來。
 *
 * 一坨最多攤開 PILE_MAX_CARDS 張，而且是**照時間均勻取樣**而不是取前幾張 ——
 * 五張攤開來要能代表這個地方待的那一整段，不是只看到剛到的頭五分鐘。
 *
 * 沒被選中的那幾張仍然留在資料裡（fan = -1，圖層自己濾掉）：
 * 它們得繼續參與 maplibre 的聚合，否則縮小時徽章上的張數會少算。
 */
function buildPiles(sorted: FootprintPoint[], pileUp: boolean): Map<number, PileSlot> {
  const out = new Map<number, PileSlot>();

  // 編輯模式不併坨：位置要能對得上真實座標，不然「把這張搬到這裡」會從錯的地方搬起
  if (!pileUp) {
    for (const p of sorted) {
      out.set(p.id, { lng: p.lng, lat: p.lat, pile: 1, fan: 0, angle: (p.id % 11) - 5 });
    }
    return out;
  }

  const groups: { albumId: number; lng: number; lat: number; members: FootprintPoint[] }[] = [];
  for (const p of sorted) {
    const g = groups.find(
      (q) => q.albumId === p.album_id && metersBetween(q.lat, q.lng, p.lat, p.lng) <= PILE_RADIUS_M,
    );
    if (!g) {
      groups.push({ albumId: p.album_id, lng: p.lng, lat: p.lat, members: [p] });
      continue;
    }
    g.members.push(p);
    g.lng += (p.lng - g.lng) / g.members.length;
    g.lat += (p.lat - g.lat) / g.members.length;
  }

  for (const g of groups) {
    const n = g.members.length;
    const k = Math.min(n, PILE_MAX_CARDS);
    const picked = new Set<number>();
    for (let i = 0; i < k; i++) picked.add(k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1)));

    const step = k > 1 ? PILE_FAN_DEG / (k - 1) : 0;
    let fanIdx = 0;
    for (let i = 0; i < n; i++) {
      const m = g.members[i];
      const show = picked.has(i);
      const fan = show ? fanIdx++ : -1;
      // 單張沒得攤，給一點固定的小歪斜就好；一整排全擺正會像證件照
      const angle = n === 1 ? (m.id % 11) - 5 : -PILE_FAN_DEG / 2 + Math.max(fan, 0) * step;
      out.set(m.id, { lng: g.lng, lat: g.lat, pile: n, fan, angle: show ? angle : 0 });
    }
  }
  return out;
}

/**
 * 張數徽章上的數字：**永遠是這顆泡泡自己底下有幾張**。
 *
 * 一路縮放下來就是同一件事在細分：整片聚成一顆時報總數，放大拆成幾叢後
 * 各報各的，拆到 clusterMaxZoom 以上叢集解散，換成 buildPiles 的那一坨報 pile。
 * 三段的數字加起來守恆，所以數字變小＝真的分開了，不是換了一套算法。
 *
 * 別把它換成「相簿總張數」：那會讓同一本相簿的每顆泡泡都印同一個數字，
 * 加起來爆掉，也看不出哪裡拍得多。
 */
const BADGE_TEXT: any = [
  'case',
  ['has', 'point_count'],
  ['get', 'point_count_abbreviated'],
  ['to-string', ['get', 'pile']],
];

/** 一條可以連起來的折線，以及它是誰走的（多身分足跡靠這個分色） */
interface TrackLine {
  /** 走這一段的人（TrackDay.user_id）。查不到就是 null，畫成預設色 */
  userId: number | null;
  line: [number, number][];
  /**
   * 跟 `line` 一一對應的時刻（UTC 毫秒）。
   * 合體那幾段要照時間把線切開（見 `splitLineBySpans`），沒有這個就只能拿座標去猜。
   */
  times: number[];
}

/**
 * 把軌跡點按「哪一天的第幾段」切成一條條折線。
 * 跨段不可以連線 —— 中間是關機或收不到訊號，接起來會憑空畫出一條沒走過的直線。
 * 資料本來就按時間遞增，這裡只做分組。
 *
 * `ownerByDay` 是給**衍生資料**用的退路：貼路結果存在 R2，讀回來的點沒有 user_id，
 * 但它的 day_key 一定跟 D1 那批是同一個，所以拿 day_key 去問「這天是誰的」。
 */
function groupLines(
  points: TrackPoint[] | undefined,
  ownerByDay?: Map<string, number>,
): TrackLine[] {
  const groups = new Map<string, TrackLine>();
  for (const p of points || []) {
    const key = segmentKey(p.day_key, p.seg);
    const g = groups.get(key);
    if (g) {
      g.line.push([p.lng, p.lat]);
      g.times.push(Date.parse(p.t_utc));
    } else {
      groups.set(key, {
        userId: p.user_id ?? ownerByDay?.get(p.day_key) ?? null,
        line: [[p.lng, p.lat]],
        times: [Date.parse(p.t_utc)],
      });
    }
  }
  return Array.from(groups.values()).filter((g) => g.line.length >= 2);
}

/**
 * 依 userId 上色的 maplibre 運算式。給 line-color / circle-color 這類 paint 屬性用。
 *
 * 顏色寫進運算式而不是「一個人一個圖層」：圖層是在 map.on('load') 裡一次加完的，
 * 成員數量會變（站長隨時可以加人），動態增刪圖層還要處理排序，
 * 而 match 只是換一次 paint 屬性。
 *
 * 沒有任何成員資料時回一個純色字串 —— match 至少要一組標籤，硬湊一個假的
 * 只會讓 maplibre 在 console 抱怨。
 */
function colorByUser(colors: Record<number, string> | undefined, fallback: string): any {
  const entries = Object.entries(colors ?? {});
  if (entries.length === 0) return fallback;
  const expr: any[] = ['match', ['get', 'userId']];
  for (const [id, hex] of entries) expr.push(Number(id), hex);
  // feature 沒有 userId（舊資料、查不到擁有者的衍生資料）時落到這裡
  expr.push(fallback);
  return expr;
}

export default function FootprintMap({
  points, showPhotos = true, albums, tracks, connectPhotos = false, height = 520, styleUrl, onSelectPhoto,
  editable = false, onEditPoints, onMovePhoto,
  rawTracks, showRawLine = false,
  matchedTracks, showMatchedLine = false,
  showTrackLine = true,
  animateOn = 'track',
  convoyOverlapPct = CONVOY_PCT_DEFAULT,
  timelineLines,
  trackColors,
  trackAvatars,
  timelineColor = DEFAULT_TRACK_COLOR,
  focusPoint,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const rafRef = useRef<number | null>(null);
  // 地圖只建立一次，事件處理器會鎖住當時的 props。用 ref 讓它讀得到最新的資料
  const memberPathsRef = useRef<MemberPath[]>([]);
  const convoysRef = useRef<ConvoyFrame[]>([]);
  /** 把播放頭移到某個 UTC 時刻。點照片時用（見底下那個同步 warp 的效果） */
  const seekRef = useRef<(t: number) => void>(() => {});
  const sortedRef = useRef<FootprintPoint[]>([]);
  const albumsRef = useRef<Album[]>([]);
  // 已經加進地圖的縮圖，以及正在下載中的。避免同一張重複抓，也用來擋住上限
  const thumbLoaded = useRef<Set<string>>(new Set());
  const thumbPending = useRef<Set<string>>(new Set());
  // 編輯模式相關的 ref，同樣是為了讓「只註冊一次」的地圖事件讀得到最新狀態
  const tracksRef = useRef<TrackPoint[]>([]);
  const editingRef = useRef(false);
  // shift 連選的起點（tracks 陣列裡的索引）
  const anchorIdxRef = useRef<number | null>(null);
  // 車與頭的動畫迴圈讀這個決定要不要繼續要下一幀。地圖只建立一次，讀不到 state
  const playingRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  /*
   * 播放進度：**所有顯示中的人一共移動了多少公尺**，不是時間也不是點索引。
   * 真正的時間游標由 timeAtProgress 換算出來（為什麼要這樣繞，見 TimeWarp）。
   */
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);

  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // 編輯模式下被選起來的照片。跟軌跡點分開存 —— 兩邊的 id 各自從 1 開始，混在同一個 Set 裡會撞號
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<number>>(new Set());
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // 依當地時間排序；後端已排過，這裡再保險一次
  const sorted = useMemo(
    () => [...points].sort((a, b) => (a.local_time || '').localeCompare(b.local_time || '')),
    [points],
  );
  const coords = useMemo(() => sorted.map((p) => [p.lng, p.lat] as [number, number]), [sorted]);

  // 只影響 photos 這個 source 怎麼畫。動畫路徑、鏡頭框景、點擊後的資料一律走真實座標
  const piles = useMemo(() => buildPiles(sorted, !editing), [sorted, editing]);

  /*
   * 每一天是誰的。D1 那批軌跡點自己就帶 user_id，但貼路結果是從 R2 讀回來的，
   * 上面只有 day_key —— 用這張表把擁有者補回去，那條紫線才知道要畫成誰的顏色。
   *
   * 用 tracks 而不是另外要一份 TrackDay：貼路是從 tracks 的日子衍生出來的，
   * 兩邊的 day_key 集合本來就一樣，多傳一個 prop 只是多一條要維護的線。
   */
  const ownerByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of tracks || []) if (p.user_id != null) m.set(p.day_key, p.user_id);
    return m;
  }, [tracks]);

  /**
   * 某個人的顏色。圖層大多用 colorByUser 那個 match 運算式讓 maplibre 自己挑，
   * 但小碟的顏色是我們自己一顆一顆算出來寫進 feature 的，那裡需要真的字串
   */
  const colorFor = useCallback(
    (userId: number | null) => (userId != null && trackColors?.[userId]) || DEFAULT_TRACK_COLOR,
    [trackColors],
  );

  /** 某個人的頭像網址。沒有就是 null —— 那他在地圖上坐的是外星人 */
  const avatarFor = useCallback(
    (userId: number | null) => (userId != null && trackAvatars?.[userId]) || null,
    [trackAvatars],
  );

  /** 已經開始做的頭像貼圖。同一張只做一次（每張都要下載、描邊、讀回像素） */
  const headPending = useRef<Set<string>>(new Set());
  /**
   * 頭像貼圖做好一張就 +1，逼那個每幀重算的效果再跑一次 ——
   * 不然暫停中做好的頭要等下次播放才換得上去，畫面會卡在外星人。
   */
  const [headTick, setHeadTick] = useState(0);
  /** 每台車現在車頭朝哪。key 是「車上有誰」，見 FACING_HYSTERESIS_PX */
  const facingRef = useRef<Map<string, 1 | -1>>(new Map());

  /** 這個顏色、這個朝向的車。沒有就現做一台 */
  const ensureCar = useCallback((map: MapLibreMap, color: string, flip: boolean) => {
    const id = `car:${color}:${flip ? 'l' : 'r'}`;
    if (!map.hasImage(id)) {
      map.addImage(
        id,
        // 只有播放中才要求下一幀：暫停時地圖不該一直重畫
        createCarImage(() => map.triggerRepaint(), () => playingRef.current, color, flip) as any,
        { pixelRatio: CAR_PIXEL_RATIO },
      );
    }
    return id;
  }, []);

  /**
   * 這個人的頭。有頭像就用他的頭像，**還沒做好或做不出來就先坐外星人** ——
   * icon-image 指到不存在的圖只會什麼都不畫，車上空一格看起來像壞掉。
   */
  const ensureHead = useCallback((map: MapLibreMap, userId: number | null, color: string) => {
    const alien = `head:alien:${color}`;
    if (!map.hasImage(alien)) {
      map.addImage(
        alien,
        createAlienHead(() => map.triggerRepaint(), () => playingRef.current, color) as any,
        { pixelRatio: HEAD_PIXEL_RATIO },
      );
    }
    const url = avatarFor(userId);
    if (!url) return alien;

    // 顏色也進 id：肩膀是那個人的軌跡色，換色就得重做一張
    const id = `head:${color}:${url}`;
    if (map.hasImage(id)) return id;
    if (!headPending.current.has(id)) {
      headPending.current.add(id);
      buildAvatarHead(url, color)
        .then((img) => {
          // 地圖可能已經被拆掉（換頁）——那就什麼都別做
          if (mapRef.current !== map) return;
          if (!map.hasImage(id)) map.addImage(id, img as any, { pixelRatio: HEAD_PIXEL_RATIO });
          setHeadTick((v) => v + 1);
        })
        // 載不下來（檔案沒了、跨網域被擋）就一直坐外星人，不要一直重試
        .catch(() => {});
    }
    return alien;
  }, [avatarFor]);

  const trackLines = useMemo(() => groupLines(tracks, ownerByDay), [tracks, ownerByDay]);

  // 原始軌跡與貼路軌跡的線，分組規則跟 trackLines 一樣
  const rawLines = useMemo(() => groupLines(rawTracks, ownerByDay), [rawTracks, ownerByDay]);
  const matchedLines = useMemo(() => groupLines(matchedTracks, ownerByDay), [matchedTracks, ownerByDay]);

  /*
   * 兩趟之間的虛線橋接。
   *
   * 貼路是一趟一趟送出去的（見 gpx.ts 的 extractTrips），所以人停下來的地方線一定
   * 會斷 —— 走進賣場的那 75 分鐘沒有路可以貼，硬送去 matcher 只會換來一團繞著
   * 附近街廓的假線。但兩條線各走各的看起來像資料掉了，所以用虛線把斷點接上：
   * **實線＝真的貼在路上，虛線＝知道你從這頭到了那頭，但不知道中間怎麼走的。**
   *
   * 只接同一天、編號相鄰、而且兩端夠近的兩段。seg 就是「第幾趟」（runMatch 依
   * 時間順序給的），所以照 seg 排序就是行進順序。
   */
  const matchedBridges = useMemo<TrackLine[]>(() => {
    const byDay = new Map<string, Map<number, TrackPoint[]>>();
    for (const p of matchedTracks || []) {
      let bySeg = byDay.get(p.day_key);
      if (!bySeg) { bySeg = new Map(); byDay.set(p.day_key, bySeg); }
      const list = bySeg.get(p.seg);
      if (list) list.push(p);
      else bySeg.set(p.seg, [p]);
    }

    const out: TrackLine[] = [];
    for (const [dayKey, bySeg] of Array.from(byDay.entries())) {
      const segs = Array.from(bySeg.keys()).sort((a, b) => a - b);
      for (let i = 1; i < segs.length; i++) {
        const prev = bySeg.get(segs[i - 1])!;
        const a = prev[prev.length - 1];
        const b = bySeg.get(segs[i])![0];
        // 太遠就讓它斷著。那不是「停下來一下」，是中間有一段我們根本沒有的路
        if (metersBetween(a.lat, a.lng, b.lat, b.lng) > MATCHED_BRIDGE_MAX_M) continue;
        out.push({
          userId: a.user_id ?? ownerByDay.get(dayKey) ?? null,
          line: [[a.lng, a.lat], [b.lng, b.lat]],
          times: [Date.parse(a.t_utc), Date.parse(b.t_utc)],
        });
      }
    }
    return out;
  }, [matchedTracks, ownerByDay]);

  // 動畫沿著哪一份軌跡跑。選了某一份卻還沒載到資料時退回濃縮版 ——
  // 否則切過去的那一瞬間動畫會整個空掉，看起來像壞了
  const animTracks = useMemo(() => {
    if (animateOn === 'raw' && (rawTracks?.length ?? 0) > 0) return rawTracks!;
    if (animateOn === 'matched' && (matchedTracks?.length ?? 0) > 0) return matchedTracks!;
    return tracks || [];
  }, [animateOn, rawTracks, matchedTracks, tracks]);

  // 每個軌跡點在它那一段裡的序號（從 1 起算）。地圖上的號碼跟工具列的訊息共用這一份。
  //
  // 每段各自編號，而不是整份軌跡一路數下去：一天有好幾段的日子會冒出「第 3184 點」
  // 這種記不住的數字，而且能合併的點本來就限定在同一段裡。
  // tracks 已按時間排序，照順序數出來就是行進順序。
  const orderById = useMemo(() => {
    const counters = new Map<string, number>();
    const out = new Map<number, number>();
    for (const p of tracks || []) {
      const key = segmentKey(p.day_key, p.seg);
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      out.set(p.id, n);
    }
    return out;
  }, [tracks]);

  // 停留：匯入時已經把室內亂跳的一串點收成質心上的兩點（進入、離開），
  // 這裡把那個時間區間還原回來，之後用它判斷「照片是不是在同一個地方拍的」。
  const stays = useMemo<Stay[]>(() => {
    const list = tracks || [];
    const out: Stay[] = [];
    for (let i = 0; i < list.length; i++) {
      const sec = list[i].stay_sec ?? 0;
      if (sec <= 0) continue;
      const t0 = Date.parse(list[i].t_utc);
      if (!Number.isFinite(t0)) continue;
      // 離開時刻就是同座標的下一個點。萬一被截斷（LIMIT）就用停留秒數推回去
      const next = list[i + 1];
      const sameSeg = next && next.day_key === list[i].day_key && next.seg === list[i].seg;
      const t1 = sameSeg ? Date.parse(next.t_utc) : t0 + sec * 1000;
      out.push({
        t0, t1: Number.isFinite(t1) ? t1 : t0 + sec * 1000,
        lng: list[i].lng, lat: list[i].lat, sec,
        userId: list[i].user_id ?? null,
      });
    }
    return out;
  }, [tracks]);

  // 照片依 UTC 排好，用來對照「動畫走到這個時間點時，人在拍哪一張」
  const photoNodes = useMemo(
    () => sorted
      .map((p) => ({ p, t: photoUtcMs(p) }))
      .filter((x): x is { p: FootprintPoint; t: number } => x.t !== null)
      .sort((a, b) => a.t - b.t),
    [sorted],
  );

  // 動畫路徑：軌跡點永遠算數，照片只有在開關打開時才併進來，並且依 UTC 混排。
  // 手機軌跡是密集的實測位置，照片位置是同一段行程的稀疏取樣，兩者本來就該是同一條線。
  const path = useMemo<PathNode[]>(() => {
    // group 為 null 代表「不會自己造成斷點」—— 照片會接上它時間上落在的那一段軌跡
    const raw: { t: number; lng: number; lat: number; group: string | null; user: number | null }[] = [];

    for (const p of animTracks) {
      const t = Date.parse(p.t_utc);
      if (Number.isFinite(t)) {
        raw.push({
          t, lng: p.lng, lat: p.lat,
          group: segmentKey(p.day_key, p.seg),
          user: p.user_id ?? ownerByDay.get(p.day_key) ?? null,
        });
      }
    }

    if (connectPhotos) {
      for (const p of sorted) {
        // interpolated 的座標本來就是在前後兩張照片之間拉直線算出來的。
        // 把它當成路徑節點，等於把那條假直線再畫一次。
        if (p.geo_source === 'interpolated') continue;
        const t = photoUtcMs(p);
        if (t === null) continue;
        // 在同一棟大樓裡拍的照片：時間落在停留區間內、位置又跟停留質心重疊，
        // 那個位置停留點已經代表過了。再加一個節點只會讓動畫為了一張照片
        // 往外拉一條線再拉回來 —— 那正是「濃縮成一個點」要消掉的東西。
        // 兩個條件都成立才收，只有時間對上但位置差很遠時是真的移動過，要留著。
        const insideStay = stays.some(
          (s) => t >= s.t0 && t <= s.t1 && metersBetween(p.lat, p.lng, s.lat, s.lng) <= STAY_SNAP_M,
        );
        if (insideStay) continue;
        // 照片沒有主人可言（誰上傳的跟「那天是誰在走」是兩件事），
        // 底下那個迴圈會讓它沿用時間上落在的那一段軌跡的主人
        raw.push({ t, lng: p.lng, lat: p.lat, group: null, user: null });
      }
    }

    raw.sort((a, b) => a.t - b.t);

    // 段別要往後傳遞，不能被中間的照片沖掉。照片剛好落在兩段軌跡之間的錄製空隙時，
    // 若只比對「前一個節點」，兩邊都會因為照片的段別是 null 而比不出換段，
    // 結果那張照片就把兩段本來該斷開的軌跡接成一條沒走過的直線。
    const out: PathNode[] = [];
    let lastGroup: string | null = null;
    let lastUser: number | null = null;
    for (let i = 0; i < raw.length; i++) {
      const n = raw[i];
      const prev = i > 0 ? raw[i - 1] : null;
      const segChanged = n.group !== null && lastGroup !== null && n.group !== lastGroup;
      if (n.group !== null) { lastGroup = n.group; lastUser = n.user; }
      const tooFar = prev !== null && n.t - prev.t > MAX_GAP_MS;
      out.push({
        t: n.t, lng: n.lng, lat: n.lat,
        breakBefore: prev !== null && (segChanged || tooFar),
        // 照片節點沿用它落在的那一段的交通工具，不然畫面上的圖示會一路閃爍
        segKey: n.group ?? lastGroup,
        // 主人也一樣往後傳遞。照片自己沒有主人，跟著它落在的那段軌跡走，
        // 才不會在多身分播放時被分到一條沒人的線上
        userId: n.group !== null ? n.user : lastUser,
      });
    }
    return out;
  }, [animTracks, sorted, connectPhotos, stays, ownerByDay]);

  /*
   * 把混在一起的 path 拆成「每個人自己的一條」。播放的一切都建立在這上面 ——
   * 位置內插、同行判定、線的生長，都是逐人算的。
   */
  const memberPaths = useMemo<MemberPath[]>(() => {
    const by = new Map<number | null, PathNode[]>();
    for (const n of path) {
      const list = by.get(n.userId);
      if (list) list.push(n); else by.set(n.userId, [n]);
    }
    const out: MemberPath[] = [];
    for (const [userId, nodes] of Array.from(by.entries())) {
      /*
       * breakBefore 一定要在這裡重算。合併陣列上的那個值是「跟前一個節點（可能是別人的）
       * 之間能不能連」，把別人抽掉之後前一個節點換人了，原本的答案就不再成立 ——
       * 直接沿用會在兩個人交錯取樣的日子裡到處畫出假的斷線。
       */
      out.push({
        userId,
        nodes: nodes.map((n, i) => {
          if (i === 0) return { ...n, breakBefore: false };
          const p = nodes[i - 1];
          const segChanged = n.segKey !== null && p.segKey !== null && n.segKey !== p.segKey;
          return { ...n, breakBefore: segChanged || n.t - p.t > MAX_GAP_MS };
        }),
      });
    }
    // 顏色的 match 運算式與同行分組都吃索引，排序固定一點，畫面才不會因為
    // Map 的插入順序在資料重抓後跳來跳去
    out.sort((a, b) => (a.userId ?? 0) - (b.userId ?? 0));
    return out;
  }, [path]);

  /** 播放進度 ↔ 時間的換算表（見 buildWarp） */
  const warp = useMemo(() => buildWarp(memberPaths), [memberPaths]);

  /**
   * 公尺平面的原點。**整份資料共用一個** —— 每趟各自取原點的話座標就對不起來了。
   * 取第一個軌跡點即可：投影誤差只跟「離原點多遠」有關，家族活動範圍內可以忽略。
   */
  const projector = useMemo(() => {
    const p = (animTracks || []).find((q) => Number.isFinite(q.lat) && Number.isFinite(q.lng));
    return makeProjector(p ? p.lat : 23.5, p ? p.lng : 121);
  }, [animTracks]);

  /**
   * 一趟一趟的移動，以及哪幾趟判定成一起出遊（見 buildTrips／buildJointTrips）。
   *
   * 吃的是**動畫用的那份軌跡**：`animateOn === 'matched'` 時就是貼路結果 ——
   * 使用者要的「用貼路軌跡判斷重疊」在這裡自動成立，而且判定跟畫面永遠是同一份資料。
   */
  const trips = useMemo(
    () => buildTrips(animTracks || [], ownerByDay, projector),
    [animTracks, ownerByDay, projector],
  );
  const jointTrips = useMemo(() => {
    const indexOf = new Map<number | null, number>();
    memberPaths.forEach((m, i) => indexOf.set(m.userId, i));
    return buildJointTrips(trips, indexOf, convoyOverlapPct);
  }, [trips, memberPaths, convoyOverlapPct]);

  /** 整條時間軸上的隊形變化（見 buildConvoys） */
  const convoys = useMemo(
    () => buildConvoys(memberPaths, warp.times, jointTrips, projector),
    [memberPaths, warp, jointTrips, projector],
  );

  /** user_id → memberPaths 的索引。隊形表裡記的是索引，畫線時手上的卻是 user_id */
  const memberIndexByUser = useMemo(() => {
    const m = new Map<number, number>();
    memberPaths.forEach((p, i) => { if (p.userId != null) m.set(p.userId, i); });
    return m;
  }, [memberPaths]);

  /** 每個人「在合體中」與「代表那台車」的時間區間（見 convoySpans） */
  const convoyRanges = useMemo(
    () => convoySpans(convoys, warp.times, memberPaths.length),
    [convoys, warp, memberPaths.length],
  );

  /** 合體那幾段從各自顏色的線上挖掉，交給彩虹線畫 */
  const cutSolo = useCallback((lines: TrackLine[]) => {
    if (convoys.length === 0) return lines;
    const out: TrackLine[] = [];
    for (const l of lines) {
      const mi = l.userId != null ? memberIndexByUser.get(l.userId) : undefined;
      const merged = mi === undefined ? [] : convoyRanges.merged[mi];
      if (merged.length === 0) { out.push(l); continue; }
      out.push(...splitLineBySpans(l, merged).outside);
    }
    return out;
  }, [convoys.length, memberIndexByUser, convoyRanges]);

  const soloTrackLines = useMemo(() => cutSolo(trackLines), [cutSolo, trackLines]);
  const soloMatchedLines = useMemo(() => cutSolo(matchedLines), [cutSolo, matchedLines]);

  /**
   * 彩虹線本身。只取「代表那台車」的那個人的線（見 convoySpans），
   * 而且只切**動畫跑的那一份**軌跡 —— 隊形就是照那一份判出來的，
   * 拿另一份去切會對不上（貼路過的線跟原始線不是同一條路）。
   */
  const convoyLines = useMemo(() => {
    if (convoys.length === 0) return [];
    const base = animateOn === 'matched' ? matchedLines : trackLines;
    const out: [number, number][][] = [];
    for (const l of base) {
      const mi = l.userId != null ? memberIndexByUser.get(l.userId) : undefined;
      const lead = mi === undefined ? [] : convoyRanges.lead[mi];
      if (lead.length === 0) continue;
      for (const seg of splitLineBySpans(l, lead).inside) out.push(seg.line);
    }
    return out;
  }, [convoys.length, animateOn, matchedLines, trackLines, memberIndexByUser, convoyRanges]);

  /** 現在播到哪個 UTC 時刻。畫面上的一切都是從這個數字推出來的 */
  const cursorT = useMemo(() => timeAtProgress(warp, progress), [warp, progress]);
  const atEnd = warp.total <= 0 || progress >= warp.total;

  // 動畫走到哪個時間，就顯示那個時間之前最後拍的那張
  const current = useMemo(() => {
    if (!Number.isFinite(cursorT)) return undefined;
    let found: FootprintPoint | undefined;
    for (const x of photoNodes) {
      if (x.t > cursorT) break;
      found = x.p;
    }
    return found;
  }, [photoNodes, cursorT]);

  useEffect(() => { memberPathsRef.current = memberPaths; }, [memberPaths]);
  useEffect(() => { convoysRef.current = convoys; }, [convoys]);
  // 點照片要跳到那個時間點，但點擊的 handler 綁在地圖上只跑一次，
  // 拿不到當下的 warp。用 ref 轉一手，讓它永遠打到最新的換算表
  useEffect(() => {
    seekRef.current = (t: number) => setProgress(progressAtTime(warp, t));
  }, [warp]);
  useEffect(() => { sortedRef.current = sorted; }, [sorted]);
  useEffect(() => { albumsRef.current = albums || []; }, [albums]);
  useEffect(() => { tracksRef.current = tracks || []; }, [tracks]);
  useEffect(() => { editingRef.current = editing; }, [editing]);
  useEffect(() => {
    playingRef.current = playing;
    // 停的時候 render() 就不再要求下一幀，所以要重新起跑得自己踢一下
    if (playing) mapRef.current?.triggerRepaint();
  }, [playing]);

  // --- 建立地圖 ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleUrl || DEFAULT_STYLE,
      center: coords[0] || [121.5, 25.04],
      zoom: coords.length ? 9 : 6,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    // 底圖或圖磚載入失敗時要留下線索 —— 沒有這個 handler 時地圖只會靜靜地一片空白
    map.on('error', (e: any) => console.error('[FootprintMap] 地圖錯誤:', e?.error?.message || e));

    map.on('load', () => {
      // Google 時間軸的紀念層。第一個加，所以墊在所有東西的最底下 ——
      // 它是背景中的背景：十二年的足跡疊起來，常走的路自然變濃，
      // 但今天要看的是上面那幾層
      map.addSource('timeline-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'timeline-track-line',
        type: 'line',
        source: 'timeline-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 顏色跟著這個人自己的軌跡色走（多身分之後不再固定桃紅 —— 那個顏色
        // 現在是調色盤裡的一格，會跟挑到它的人撞色）。
        // 靠**細而淡**跟同色的貼路線分開：那條是 3.5 寬 / 0.75 不透明，
        // 這條單獨一條不搶戲，重疊多的地方自己會浮出來。
        // 實際的顏色由底下那個 paint 效果覆蓋，這裡只是還沒拿到成員資料時的起始值
        paint: { 'line-color': DEFAULT_TRACK_COLOR, 'line-width': 1, 'line-opacity': 0.35 },
      });

      // 原始軌跡的對照底線，排在 gps-track 之前才會墊在它下面 ——
      // 要看的是「濃縮後的線偏離原始路徑多少」，濃縮後那條必須疊在上面
      map.addSource('raw-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'raw-track-line',
        type: 'line',
        source: 'raw-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 橘色虛線：跟綠色實線的軌跡明顯區隔，一眼看得出哪條是原始的
        paint: {
          'line-color': '#f97316',
          'line-width': 1.5,
          'line-opacity': 0.7,
          'line-dasharray': [2, 1.5],
        },
      });

      // 貼路軌跡。也墊在 gps-track 底下，一樣是為了對照 ——
      // 要看的是原本的線偏離道路多少，原本那條得在上面
      map.addSource('matched-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'matched-track-line',
        type: 'line',
        source: 'matched-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 粗實線：畫的是道路本身，比原始軌跡的虛線更該被看見。
        // 顏色由「依人上色」那個效果覆蓋（原本固定紫色，也就是現在的預設色）
        paint: {
          'line-color': DEFAULT_TRACK_COLOR,
          'line-width': 3.5,
          'line-opacity': 0.75,
        },
      });

      // 兩趟之間的橋接。同色但細、虛、半透明 —— 一眼看得出是同一條路線的一部分，
      // 又不會被誤讀成「這段路我們真的知道」。只填斷點之間的空白，跟實線幾乎不重疊
      map.addSource('matched-bridge', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'matched-bridge-line',
        type: 'line',
        source: 'matched-bridge',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          // 同上，由「依人上色」覆蓋 —— 橋接一定要跟它接起來的實線同色
          'line-color': DEFAULT_TRACK_COLOR,
          'line-width': 2,
          'line-opacity': 0.5,
          'line-dasharray': [1.5, 1.5],
        },
      });

      // 先加軌跡，才會壓在照片路線與標記底下 —— 它是背景，不是主角
      map.addSource('gps-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'gps-track-line',
        type: 'line',
        source: 'gps-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 顏色由「依人上色」那個效果覆蓋（原本固定綠色）。
        // ⚠️ 這一層跟貼路線現在會是同一個顏色 —— 兩條同時打開是拿來比對
        // 「貼路貼準了沒」的除錯用法，那時得靠寬度（2.5 vs 3.5）分辨。
        // 這一頁預設只畫貼路線（SHOW_TRACK_LINE = false），平常碰不到
        paint: { 'line-color': DEFAULT_TRACK_COLOR, 'line-width': 2.5, 'line-opacity': 0.45 },
      });

      /*
       * 合體那幾段的彩虹線。畫在所有軌跡線之上 —— 那一段本來就只剩它一條
       * （各自顏色的線已經被挖掉），壓在底下反而會被停留點蓋住。
       *
       * ⚠️ `line-gradient` 有兩個硬條件：來源必須 `lineMetrics: true`（要算
       * line-progress），而且它會**整個蓋掉 `line-color`**。這正是合體段非得
       * 自成一層不可的原因 —— 塞回 matched-track 的話所有人的線都會變成彩虹。
       */
      map.addSource('convoy-track', {
        type: 'geojson',
        lineMetrics: true,
        data: { type: 'FeatureCollection', features: [] },
      });
      // 外圈的光暈，讓彩虹在底圖上浮起來一點
      map.addLayer({
        id: 'convoy-track-glow',
        type: 'line',
        source: 'convoy-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 11,
          'line-opacity': 0.22,
          'line-blur': 7,
          'line-gradient': convoyGradient(0) as any,
        },
      });
      map.addLayer({
        id: 'convoy-track-line',
        type: 'line',
        source: 'convoy-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // 比各自的線再粗一點（3.5 → 4.5）：合體是「兩個人的線併成一條」
        paint: {
          'line-width': 4.5,
          'line-opacity': 0.95,
          'line-gradient': convoyGradient(0) as any,
        },
      });

      // 停留點：待越久畫越大。沒有這一層的話，濃縮完的軌跡看起來只是一條線
      // 中間莫名其妙頓住，看不出「這裡待了三個小時」
      map.addSource('stays', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'stay-points',
        type: 'circle',
        source: 'stays',
        paint: {
          'circle-radius': ['step', ['get', 'sec'], 7, 1800, 10, 7200, 14],
          // 填色與外框都由「依人上色」那個效果覆蓋（原本固定綠色）
          'circle-color': DEFAULT_TRACK_COLOR,
          'circle-opacity': 0.22,
          'circle-stroke-width': 2,
          'circle-stroke-color': DEFAULT_TRACK_COLOR,
          'circle-stroke-opacity': 0.7,
        },
      });
      map.addLayer({
        id: 'stay-label',
        type: 'symbol',
        source: 'stays',
        // 短暫的停留不標字，否則整張地圖都是標籤
        filter: ['>=', ['get', 'sec'], 1800],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-offset': [0, 1.4],
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#15803d', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });

      // 多身分之後這裡是 FeatureCollection 而不是單一條線：每個人各自一條（甚至多條，
      // 中斷會把一個人的路切開），每條帶著 userId 讓 match 運算式挑顏色
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // 路線畫兩層：底下較寬的淡色當光暈，上面實線當主體
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 10, 'line-opacity': 0.18, 'line-blur': 6 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 3 },
      });

      map.addSource('photos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        // 泡泡比原本的圓點大得多，聚合半徑跟著放大，否則縮小時會擠成一片疊圖
        clusterRadius: 70,
        // 一路聚到 z17 才散開，散開之後由 buildPiles 的扇形接手。
        // 停在 z15 的話 z16~17 這一段既沒有叢集、又還沒近到分得開，會糊成一團
        clusterMaxZoom: 17,
        clusterProperties: {
          // 整叢是不是同一本相簿：min === max 就是。
          // 沒有「集合」型的累加器可用，只好靠兩端夾出來
          aMin: ['min', ['get', 'album_id']],
          aMax: ['max', ['get', 'album_id']],
          // 這一叢的代表照（見 REP_ID_MOD）
          rep: ['max', ['get', 'rep']],
        },
      });

      // 泡泡的大小與傾角，單張與整叢共用同一組，兩層看起來才是同一種東西。
      // interpolate 在頭尾停靠點之外會夾住，這就是「不能大過頭」的上下限
      const bubbleSize: any = [
        'interpolate', ['linear'], ['zoom'],
        9, 0.62,
        13, 0.95,
        16, 1.25,
        18, 1.5,
      ];
      // 每個泡泡歪一點點，角度由 rep 決定（單張與叢集都有這個屬性）。
      // 全部擺正會像一排證件照，歪一點才活
      const bubbleTilt: any = ['-', ['%', ['get', 'rep'], 11], 5];
      const bubbleLayout = {
        'icon-size': bubbleSize,
        // 尾巴尖端要落在座標上：圖的底部往下推一個 BUBBLE_PAD（陰影留白）補回來。
        // icon-offset 會跟著 icon-size 一起縮放，所以放大時也對得準
        'icon-anchor': 'bottom' as const,
        'icon-offset': [0, BUBBLE_PAD] as [number, number],
        'icon-rotate': bubbleTilt,
        // 傾角是畫面上的裝飾，不該跟著地圖轉
        'icon-rotation-alignment': 'viewport' as const,
        // 照片本來就常常擠在一起，讓它們互相遮擋比整片消失好
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      };

      // 同一景點常常拍幾十張，不聚合會疊成一坨。
      // 這個圓點只是泡泡還沒載到時的底 —— 數量改由右上角的徽章顯示
      map.addLayer({
        id: 'photo-clusters',
        type: 'circle',
        source: 'photos',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#2563eb',
          'circle-opacity': 0.9,
          'circle-radius': ['step', ['get', 'point_count'], 8, 10, 10, 50, 12],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // 單點一律同一個樣子。以前依 geo_source 分成五種顏色與透明度，拿掉了：
      // 那需要一整排圖例才看得懂，而多數點上面本來就疊著縮圖，顏色根本露不出來。
      // 「這張照片的位置是量到的還是推出來的」點開它就會說（見底下的播放列）。
      map.addLayer({
        id: 'photo-points',
        type: 'circle',
        source: 'photos',
        // fan < 0 是被同一坨蓋掉、不畫的那幾張。它們跟同坨的其他人同座標，
        // 畫出來只是把同一個圓點重疊描好幾次
        filter: ['all', ['!', ['has', 'point_count']], ['>=', ['get', 'fan'], 0]],
        paint: {
          'circle-radius': 7,
          'circle-color': '#2563eb',
          'circle-opacity': 1,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // 泡泡疊在圓點之上。圓點那兩層留著當底 —— 圖還沒載到（或載失敗）時
      // 至少還看得到位置，不會整個標記消失。
      //
      // 單張與叢集分兩層而不是靠 icon-image 一條 case 判完，是為了點擊：
      // 點單張要開燈箱、點叢集要展開，兩件事得掛在不同的 layer 上
      map.addLayer({
        id: 'photo-thumbs',
        type: 'symbol',
        source: 'photos',
        filter: ['all', ['!', ['has', 'point_count']], ['>=', ['get', 'fan'], 0]],
        layout: {
          ...bubbleLayout,
          'icon-image': ['concat', 'photo-', ['to-string', ['get', 'id']]],
          // 擠在一起的那幾張已經被釘在同一個點上，角度由 buildPiles 排成扇形。
          // 旋轉中心就是 icon-anchor（尾巴尖端），所以攤開來自然是握著一手牌的樣子
          'icon-rotate': ['get', 'angle'],
          // 牌面由左到右依序疊上去，不然每次重繪的前後關係都可能不一樣
          'symbol-sort-key': ['get', 'fan'],
        },
      });

      // 整叢的代表照：全部同一本相簿就用那本的封面（album-<id>，載不到封面時
      // 由 styleimagemissing 那邊退回隨機一張），否則用這一區隨機抽中的那張照片
      map.addLayer({
        id: 'photo-cluster-thumbs',
        type: 'symbol',
        source: 'photos',
        filter: ['has', 'point_count'],
        layout: {
          ...bubbleLayout,
          'icon-image': [
            'case',
            ['==', ['get', 'aMin'], ['get', 'aMax']],
            ['concat', 'album-', ['to-string', ['get', 'aMin']]],
            ['concat', 'photo-', ['to-string', ['%', ['get', 'rep'], REP_ID_MOD]]],
          ],
        },
      });

      // 張數徽章，貼在泡泡的右上角。
      //
      // 不能畫進貼圖裡：同一張代表照會出現在張數不同的叢集上，貼圖是共用的。
      // 位置只好用 translate 手算 —— 泡泡以尾巴尖端為錨，本體頂緣在
      // -(BUBBLE_H + BUBBLE_TAIL) × icon-size，右緣在 BUBBLE_W/2 × icon-size，
      // 下面每個縮放停靠點就是把這兩個數字乘出來的（跟 bubbleSize 同一組 zoom）
      //
      // 每個停靠點的 [x, y] 一定要包成 ['literal', [...]]：expression 裡裸露的陣列
      // 會被當成「函式呼叫」去解析，第一個元素是數字就直接判定整條式子非法，
      // 這兩層會被 maplibre 整個拒收（徽章就完全不會出現）
      const badgeShift: any = [
        'interpolate', ['linear'], ['zoom'],
        9, ['literal', [22, -57]],
        13, ['literal', [34, -87]],
        16, ['literal', [45, -115]],
        18, ['literal', [54, -138]],
      ];
      // 徽章要蓋兩種情況：maplibre 聚出來的叢集，以及放大之後攤成扇形的那一坨。
      // 一坨只掛在第一張牌上，否則五張牌會冒出五個一模一樣的徽章
      const badgeFilter: any = [
        'any',
        ['has', 'point_count'],
        ['all', ['==', ['get', 'fan'], 0], ['>', ['get', 'pile'], 1]],
      ];
      map.addLayer({
        id: 'photo-count-badge',
        type: 'circle',
        source: 'photos',
        filter: badgeFilter,
        paint: {
          'circle-color': '#f43f5e',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 9, 13, 12, 16, 15, 18, 17],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
          'circle-translate': badgeShift,
          // 泡泡是畫面對齊的，徽章要跟著它，不能跟著地圖轉
          'circle-translate-anchor': 'viewport',
        },
      });
      map.addLayer({
        id: 'photo-count-label',
        type: 'symbol',
        source: 'photos',
        filter: badgeFilter,
        // 必須指定 OpenFreeMap 實際提供的字型；用 maplibre 預設的
        // "Open Sans Regular,Arial Unicode MS Regular" 會 404 而退化成本地字型
        layout: {
          'text-field': BADGE_TEXT,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 12, 16, 14, 18, 16],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-translate': badgeShift,
          'text-translate-anchor': 'viewport',
        },
      });

      /*
       * 移動圖示：小小的車 ＋ 大大的頭。畫在最上層，它是動畫的主角。
       *
       * 車與頭是**兩層**，每一幀各自定位（見底下 project／unproject 那段）——
       * 合成一張圖的話，每一種人數 × 每一組頭像都要各做一張貼圖。
       * 圖本身是現做的（見 lib/car.ts），車身色與頭像不同就是另一張，
       * 所以這裡不預先加，等真的有人上場再 ensureCarImage／ensureHeadImage。
       */
      map.addSource('vehicle', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'vehicle-marker',
        type: 'symbol',
        source: 'vehicle',
        layout: {
          // 每個 feature 自己指定要哪張車（顏色 × 朝左朝右）
          'icon-image': ['get', 'img'],
          // 人多的時候車要寬一點才裝得下那幾顆頭，見 CAR_BASE_W
          'icon-size': ['get', 'scale'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // 圖的底部中央是輪子接地點，錨在那裡車才會停在軌跡上
          'icon-anchor': 'bottom',
          // 朝向靠左右兩張圖切換，不靠旋轉 —— 車轉起來會變成側翻
          'icon-rotation-alignment': 'viewport',
        },
      });

      /*
       * 車上的人。一個人一顆頭，加在 vehicle-marker 後面才會疊在車身上。
       *
       * 「今天誰跟誰在一起」全靠這一層：合體時同一台車上有幾顆頭就是幾個人。
       */
      map.addSource('heads', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'rider-heads',
        type: 'symbol',
        source: 'heads',
        layout: {
          'icon-image': ['get', 'img'],
          'icon-size': ['get', 'scale'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // 錨在下緣：那裡是小身體的底部，正好坐進座位
          'icon-anchor': 'bottom',
          'icon-rotation-alignment': 'viewport',
        },
      });

      // 編輯模式的軌跡點。放在最上層 —— 縮圖比它大得多，壓在底下會點不到。
      // 只有進編輯模式才會有資料，平常這一層是空的
      map.addSource('track-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'track-point-dots',
        type: 'circle',
        source: 'track-points',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 9, ['case', ['get', 'stay'], 7, 5]],
          'circle-color': ['case', ['get', 'selected'], '#ef4444', '#0f766e'],
          'circle-opacity': 0.9,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // 點號。要一個一個核對「合併哪幾點」時，光看一堆長得一樣的圓點是數不出來的。
      // 刻意不開 text-allow-overlap：軌跡動輒上千點，全部標出來會糊成一片黑，
      // 交給 maplibre 的碰撞偵測自動疏密 —— 放大才看得到每一點的號碼。
      map.addLayer({
        id: 'track-point-labels',
        type: 'symbol',
        source: 'track-points',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.7],
          // 數字越小越優先擺放：選起來的點一定要看得到號碼，
          // 否則使用者沒辦法確認自己選的是不是打算選的那幾點
          'symbol-sort-key': ['case', ['get', 'selected'], 0, 1],
        },
        paint: {
          'text-color': ['case', ['get', 'selected'], '#b91c1c', '#0f766e'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });

      // 被選起來的照片。畫成一圈紅框套在縮圖外面，而不是改圓點的顏色 ——
      // 縮圖蓋在圓點上，改底下那層根本看不到。
      // filter 預設不匹配任何東西，選取變動時才由下面的 effect 換掉
      map.addLayer({
        id: 'photo-selected-ring',
        type: 'circle',
        source: 'photos',
        filter: ['all', ['!', ['has', 'point_count']], ['in', ['get', 'id'], ['literal', []]]],
        paint: {
          // 跟著縮圖一起縮放，才會一直是「框住那張照片」而不是框住空氣
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 20, 14, 34, 17, 50],
          'circle-opacity': 0,
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ef4444',
        },
      });

      map.on('click', 'track-point-dots', (e: MapLayerMouseEvent) => {
        const id = Number(e.features?.[0]?.properties?.id);
        if (!Number.isFinite(id)) return;
        const idx = tracksRef.current.findIndex((p) => p.id === id);
        const shift = (e.originalEvent as MouseEvent | undefined)?.shiftKey === true;

        setEditError(null);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (shift && anchorIdxRef.current !== null && idx >= 0) {
            // 連選：一個一個點五十個點是不可能的操作
            const lo = Math.min(anchorIdxRef.current, idx);
            const hi = Math.max(anchorIdxRef.current, idx);
            for (let i = lo; i <= hi; i++) next.add(tracksRef.current[i].id);
          } else if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        // shift 連選不移動錨點，才能反覆調整同一段的範圍
        if (!shift && idx >= 0) anchorIdxRef.current = idx;
      });
      map.on('mouseenter', 'track-point-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'track-point-dots', () => { map.getCanvas().style.cursor = ''; });

      /**
       * icon-image 的名字 → 要拿哪張圖來畫。
       *
       * photo-<id>：那張照片本身。
       * album-<id>：那本相簿的封面；沒設封面就從這本相簿在地圖上的照片裡隨機挑一張。
       *   挑完就進了 maplibre 的圖庫、整個 session 不會再抽，所以不會一直跳。
       */
      const bubbleSourceFor = (imageId: string): string | null => {
        if (imageId.startsWith('photo-')) {
          const photoId = Number(imageId.slice('photo-'.length));
          return sortedRef.current.find((p) => p.id === photoId)?.url ?? null;
        }
        const albumId = Number(imageId.slice('album-'.length));
        const cover = albumsRef.current.find((a) => a.id === albumId)?.cover_photo_url;
        if (cover) return cover;
        const pool = sortedRef.current.filter((p) => p.album_id === albumId);
        if (pool.length === 0) return null;
        return pool[Math.floor(Math.random() * pool.length)].url;
      };

      // 縮圖採「用到才載」：maplibre 找不到 icon-image 就會發這個事件。
      // 一次把整個相簿的縮圖抓下來是白費頻寬 —— 聚合起來的照片只會畫出一張代表。
      map.on('styleimagemissing', (e: { id: string }) => {
        const id = e.id;
        if (!id.startsWith('photo-') && !id.startsWith('album-')) return;
        if (thumbPending.current.has(id) || thumbLoaded.current.size >= MAX_THUMBS) return;
        const url = bubbleSourceFor(id);
        if (!url) return;

        // 外圈顏色只求穩定與分散，用 id 的數字部分取模就夠
        const ring = BUBBLE_RINGS[Math.abs(Number(id.slice(id.indexOf('-') + 1)) || 0) % BUBBLE_RINGS.length];

        thumbPending.current.add(id);
        loadBubble(url, ring)
          .then((data) => {
            // 這中間地圖可能已經被 remove，或別的路徑已經加過同一張
            if (!mapRef.current || mapRef.current.hasImage(id)) return;
            mapRef.current.addImage(id, data, { pixelRatio: BUBBLE_PR });
            thumbLoaded.current.add(id);
          })
          .catch(() => { /* 載不到就維持圓點，不需要打擾使用者 */ })
          .finally(() => { thumbPending.current.delete(id); });
      });

      // 點叢集就展開。泡泡那一層畫得比底下的圓點大，只掛圓點的話點到泡泡不會有反應
      const onClusterClick = (e: MapLayerMouseEvent) => {
        const f = map.queryRenderedFeatures(e.point, {
          layers: ['photo-clusters', 'photo-cluster-thumbs'],
        })[0];
        const clusterId = f?.properties?.cluster_id;
        const src = map.getSource('photos') as GeoJSONSource;
        if (clusterId == null || !src) return;
        src.getClusterExpansionZoom(clusterId).then((zoom: number) => {
          map.easeTo({ center: (f.geometry as any).coordinates, zoom });
        }).catch(() => { /* 叢集已不存在，忽略 */ });
      };
      map.on('click', 'photo-clusters', onClusterClick);
      map.on('click', 'photo-cluster-thumbs', onClusterClick);

      const onPhotoClick = (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = Number(f.properties?.id);

        // 編輯模式下點照片是「選起來」，不是開燈箱
        if (editingRef.current) {
          if (!Number.isFinite(id)) return;
          // 軌跡點那一層畫在縮圖上面，同一下點擊兩邊的 handler 都會收到。
          // 讓軌跡點優先，否則想選底下的軌跡點時會連照片一起選到
          if (map.queryRenderedFeatures(e.point, { layers: ['track-point-dots'] }).length > 0) return;
          setEditError(null);
          setSelectedPhotoIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
          return;
        }

        const point = sortedRef.current.find((p) => p.id === id);
        if (point) {
          // 播放頭是時間游標，照片本來就有時間，直接跳過去
          const t = photoUtcMs(point);
          if (t !== null) seekRef.current(t);
          onSelectPhoto?.(point);
        }
      };
      // 泡泡比底下的圓點大，只掛在圓點上的話點到泡泡邊緣會沒有反應
      map.on('click', 'photo-points', onPhotoClick);
      map.on('click', 'photo-thumbs', onPhotoClick);

      for (const layer of ['photo-points', 'photo-thumbs', 'photo-clusters', 'photo-cluster-thumbs']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // 只建立一次；資料變動由下面的 effect 更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  // --- 資料變動時重設並套用 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    setPlaying(false);

    const src = map.getSource('photos') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showPhotos ? sorted : []).map((p) => {
        // 落單的照片（理論上不會有，piles 是照 sorted 建的）就照原座標畫
        const slot = piles.get(p.id) ?? { lng: p.lng, lat: p.lat, pile: 1, fan: 0, angle: 0 };
        return {
          type: 'Feature' as const,
          properties: {
            id: p.id,
            geo_source: p.geo_source,
            title: p.title,
            album_id: p.album_id,
            // 每次資料換掉就重抽一次代表照（也順便換一輪叢集泡泡的傾角）。
            // id 超過 REP_ID_MOD 的話低位會溢位、代表照就抽錯 —— 現實中差了好幾個數量級
            rep: Math.floor(Math.random() * REP_RAND_MAX) * REP_ID_MOD + (p.id % REP_ID_MOD),
            pile: slot.pile,
            fan: slot.fan,
            angle: slot.angle,
          },
          // 同一坨的照片一律釘在該坨的質心上，不是各自的真實座標
          geometry: { type: 'Point' as const, coordinates: [slot.lng, slot.lat] },
        };
      }),
    });

  }, [sorted, coords, piles, showPhotos, ready]);

  // 關掉照片時把照片的選取一起放掉。留著的話編輯面板會說「已選 3 張」，
  // 但畫面上一張都看不到，也點不到任何一張來取消
  useEffect(() => {
    if (!showPhotos) setSelectedPhotoIds(new Set());
  }, [showPhotos]);

  // 路徑換了就把播放頭移到終點，維持「預設看到完整路線」的樣子
  useEffect(() => {
    setProgress(warp.total);
    setPlaying(false);
  }, [warp]);

  /*
   * --- 依人上色 ---
   *
   * 圖層是在 map.on('load') 裡一次加完的，那時還沒有成員資料（`/api/track-members`
   * 是另一趟請求），而且站長隨時可以加人、家人隨時可以換色。所以顏色不寫死在
   * addLayer 裡，改成拿到資料之後換一次 paint 屬性。
   *
   * 停留圈的外框與填色都跟著走 —— 只換一個會變成「紫圈藍邊」。
   * 停留的字（stay-label）維持深綠不動：那是標籤不是軌跡，跟著人變色反而難讀。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const expr = colorByUser(trackColors, DEFAULT_TRACK_COLOR);
    map.setPaintProperty('gps-track-line', 'line-color', expr);
    map.setPaintProperty('matched-track-line', 'line-color', expr);
    map.setPaintProperty('matched-bridge-line', 'line-color', expr);
    map.setPaintProperty('stay-points', 'circle-color', expr);
    map.setPaintProperty('stay-points', 'circle-stroke-color', expr);
  }, [trackColors, ready]);

  /*
   * 播放路線的顏色。只有**同框不只一個人**時才依人上色。
   *
   * 單人時維持原本那個藍：這一層是「動畫走過的地方」，跟底下那條靜態軌跡刻意不同色，
   * 才看得出播放頭走到哪了。多人時分辨「誰是誰」比較重要，才讓它跟著各人的顏色。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const expr = memberPaths.length > 1 ? colorByUser(trackColors, '#2563eb') : '#2563eb';
    map.setPaintProperty('route-glow', 'line-color', expr);
    map.setPaintProperty('route-line', 'line-color', expr);
  }, [trackColors, memberPaths.length, ready]);

  // Google 紀念層是頁面切好的線，帶不了 userId，所以單獨給一個色（見 timelineColor）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty('timeline-track-line', 'line-color', timelineColor);
  }, [timelineColor, ready]);

  // --- 軌跡 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('gps-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      // soloTrackLines：合體那幾段已經挖掉了，改由 convoy-track 那條彩虹畫
      features: (showTrackLine ? soloTrackLines : []).map(({ userId, line }) => ({
        type: 'Feature',
        properties: { userId },
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [soloTrackLines, showTrackLine, ready]);

  // --- Google 時間軸紀念層 ---
  // 線已經在頁面那邊切好了，這裡不做任何判斷 —— 沒傳就是不畫
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('timeline-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (timelineLines ?? []).map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [timelineLines, ready]);

  // --- 原始軌跡對照底線 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('raw-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showRawLine ? rawLines : []).map(({ line }) => ({
        type: 'Feature',
        // 原始軌跡是「濃縮前長什麼樣」的對照層，不分人上色 ——
        // 它跟濃縮後那條永遠是同一批點，兩條都依人分色反而分不出誰是誰
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [rawLines, showRawLine, ready]);

  // --- 貼路軌跡 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('matched-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      // soloMatchedLines：同上，合體那幾段交給彩虹線
      features: (showMatchedLine ? soloMatchedLines : []).map(({ userId, line }) => ({
        type: 'Feature',
        properties: { userId },
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [soloMatchedLines, showMatchedLine, ready]);

  // --- 兩趟之間的虛線橋接（跟著貼路軌跡一起開關）---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('matched-bridge') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showMatchedLine ? matchedBridges : []).map(({ userId, line }) => ({
        type: 'Feature',
        properties: { userId },
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [matchedBridges, showMatchedLine, ready]);

  // --- 合體那幾段的彩虹線 ---
  // 跟著它切出來的那一層一起開關：切的是哪一份軌跡由 animateOn 決定，
  // 那一層被關掉的話彩虹留在畫面上就會變成一條孤零零、沒有來歷的線
  const showConvoyLine = animateOn === 'matched' ? showMatchedLine : showTrackLine;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('convoy-track') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: (showConvoyLine ? convoyLines : []).map((line) => ({
        type: 'Feature',
        // 彩虹不分人上色 —— 合體的意思就是「這一段沒有你我之分」
        properties: {},
        geometry: { type: 'LineString', coordinates: line },
      })),
    });
  }, [convoyLines, showConvoyLine, ready]);

  /*
   * 讓彩虹流動。
   *
   * 使用者要的是「一直流」，所以這個 rAF 跟播放無關，只要畫面上有合體線就一直跑。
   * 兩道節流：**沒有合體線就整個不開**（大部分日子都是各走各的），以及 ≈20fps ——
   * 漸層是重畫一張線的貼圖，60fps 對「顏色慢慢流過去」這件事沒有任何加分，
   * 只是白白吃手機的電。尊重 prefers-reduced-motion：那時停在靜止的彩虹上。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !showConvoyLine || convoyLines.length === 0) return;
    if (!map.getLayer('convoy-track-line')) return;
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < CONVOY_FLOW_STEP_MS) return;
      last = now;
      const expr = convoyGradient((now % CONVOY_FLOW_MS) / CONVOY_FLOW_MS) as any;
      map.setPaintProperty('convoy-track-line', 'line-gradient', expr);
      map.setPaintProperty('convoy-track-glow', 'line-gradient', expr);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, showConvoyLine, convoyLines.length]);

  // --- 停留點 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('stays') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      // 停留圈是綠線的註解（「這裡的線頓住是因為待了三小時」），
      // 綠線關掉時單獨留著只會變成一堆沒有來由的圈
      features: (showTrackLine ? stays : []).map((s) => ({
        type: 'Feature',
        properties: { sec: s.sec, label: humanDuration(s.sec), userId: s.userId },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
  }, [stays, showTrackLine, ready]);

  // --- 編輯模式的軌跡點 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('track-points') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: editing
        ? (tracks || []).map((p) => ({
          type: 'Feature' as const,
          properties: {
            id: p.id,
            selected: selectedIds.has(p.id),
            stay: (p.stay_sec ?? 0) > 0,
            label: String(orderById.get(p.id) ?? ''),
          },
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        }))
        : [],
    });
  }, [editing, selectedIds, tracks, orderById, ready]);

  // --- 被選起來的照片 ---
  // 只換 filter，不動 photos 這個 source —— 它開了 cluster，重設資料會讓
  // 整個聚合重算，每點一下照片就閃一次
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getLayer('photo-selected-ring')) return;
    const ids = editing ? Array.from(selectedPhotoIds) : [];
    map.setFilter('photo-selected-ring', [
      'all', ['!', ['has', 'point_count']], ['in', ['get', 'id'], ['literal', ids]],
    ]);
  }, [editing, selectedPhotoIds, ready]);

  // --- 視野 ---
  // 照片與軌跡分開載入，兩邊都要納入，否則先到的那一批會把視野定死
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // 只看一天：直接停在起點，不框全部。理由見 focusPoint 的說明
    if (focusPoint) {
      map.easeTo({ center: focusPoint, zoom: FOCUS_ZOOM, duration: 600 });
      return;
    }

    // 只框看得到的線。綠線關掉、只留貼路時還照 trackLines 框的話，
    // 鏡頭會停在一個畫面上什麼都沒有的範圍
    const lines = showTrackLine ? trackLines : showMatchedLine ? matchedLines : trackLines;

    // Google 足跡也要框進來。以前漏掉它，結果只有那一層有資料的年份（2014 年那些
    // 早於 GPS 軌跡的日子）畫得出線，鏡頭卻不會過去 —— 線確實畫了，只是在畫面外。
    // timelineLines 沒開的時候頁面傳 undefined，跟上面「只框看得到的」一致。
    //
    // 不用 flat()：不篩日期時這一層是十二年、幾十萬個點，攤平只是白配一個大陣列
    let bounds: LngLatBounds | null = null;
    const extend = (c: [number, number]) => {
      bounds = bounds === null ? new LngLatBounds(c, c) : bounds.extend(c);
    };
    for (const c of coords) extend(c);
    for (const { line } of lines) for (const c of line) extend(c);
    for (const line of timelineLines ?? []) for (const c of line) extend(c);
    if (bounds === null) return;

    map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 600 });
  }, [coords, trackLines, matchedLines, timelineLines, showTrackLine, showMatchedLine, focusPoint, ready]);

  // --- 路線隨時間游標生長 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('route') as GeoJSONSource | undefined;
    const vehicleSrc = map.getSource('vehicle') as GeoJSONSource | undefined;
    const headsSrc = map.getSource('heads') as GeoJSONSource | undefined;
    if (!src) return;

    const lineFeatures: any[] = [];
    /** 每個人現在在哪。null＝這個時候他不該出現（沒資料／中斷中） */
    const pos: ([number, number] | null)[] = [];

    for (const m of memberPaths) {
      const cursorPos = posAt(m.nodes, cursorT);
      pos.push(cursorPos);

      // 走過的部分要切成多條線 —— 遇到斷點（換軌跡段、或隔太久）就另起一條，
      // 用單一 LineString 會把中間那段沒走過的路憑空連起來
      let cur: [number, number][] = [];
      const flush = () => {
        if (cur.length >= 2) {
          lineFeatures.push({
            type: 'Feature',
            properties: { userId: m.userId },
            geometry: { type: 'LineString', coordinates: cur },
          });
        }
        cur = [];
      };
      for (const nd of m.nodes) {
        if (nd.t > cursorT) break;
        if (nd.breakBefore) flush();
        cur.push([nd.lng, nd.lat]);
      }
      /*
       * 內插出最後一小截，線條才會平滑前進而不是一格一格跳。
       * posAt 已經處理過「下一段是斷點就不內插」，這裡只要確認它真的落在
       * 剛畫完的那一截後面（游標在資料範圍外時是 null，那就什麼都不接）
       */
      if (cursorPos && cur.length > 0) {
        const tail = cur[cur.length - 1];
        if (cursorPos[0] !== tail[0] || cursorPos[1] !== tail[1]) cur.push(cursorPos);
      }
      flush();
    }

    src.setData({ type: 'FeatureCollection', features: lineFeatures });

    /*
     * 車與頭：同行的人擠同一台車，各自走的各開各的。
     *
     * 一台車 ＝ 一群人。車畫在那一群人的形心上，每個人一顆大頭坐在車頂 ——
     * 一個人的時候就退化成「一顆頭一台車」，看不出這裡有處理多人的事。
     */
    const carFeatures: any[] = [];
    const headFeatures: any[] = [];
    const inConvoy = new Set<number>();
    const now = performance.now() / 1000;

    /** 這台車往哪開。位移太小就沿用上次的答案，不然停等時車頭會左右亂甩 */
    const facingOf = (key: string, cur: [number, number], prev: [number, number] | null) => {
      const last = facingRef.current.get(key) ?? 1;
      if (!prev) return last;
      const dx = map.project(cur).x - map.project(prev).x;
      if (Math.abs(dx) < FACING_HYSTERESIS_PX) return last;
      const next: 1 | -1 = dx < 0 ? -1 : 1;
      facingRef.current.set(key, next);
      return next;
    };

    /**
     * 擺一台車與車上的人。
     *
     * 頭的位置只能用螢幕座標算：符號圖層沒有「每個 feature 各自位移」的辦法
     * （icon-translate 是整層共用的），所以把車的位置投影成像素、在像素上排好，
     * 再投影回經緯度。反正播放中本來就每幀重畫一次，不多花什麼。
     */
    const placeCar = (idx: number[], center: [number, number], prev: [number, number] | null) => {
      const n = idx.length;
      const key = idx.map((i) => memberPaths[i].userId ?? 'x').join(',');
      const flip = facingOf(key, center, prev) < 0;
      // 獨行的人開自己顏色的車；合體那台不屬於任何一個人，用中性色
      const carColor = n === 1 ? colorFor(memberPaths[idx[0]].userId) : CAR_NEUTRAL;
      const headScale = n > 1 ? HEAD_CROWD_SCALE : 1;
      const step = HEAD_STEP * headScale;
      // 車至少要跟這排頭一樣寬，不然頭會掛在車外面
      const carScale = Math.max(1, ((n - 1) * step + CAR_BASE_W * 0.5) / CAR_BASE_W);

      carFeatures.push({
        type: 'Feature',
        properties: { img: ensureCar(map, carColor, flip), scale: carScale },
        geometry: { type: 'Point', coordinates: center },
      });

      const cpx = map.project(center);
      const seatY = cpx.y + CAR_SEAT_Y * carScale;
      idx.forEach((i, k) => {
        const color = colorFor(memberPaths[i].userId);
        const ll = map.unproject([
          cpx.x + (k - (n - 1) / 2) * step,
          // 奇數位的人坐低一點（後座），加上各自錯開相位的上下晃動
          seatY + (k % 2) * HEAD_TIER + Math.sin(now * 3 + k * 1.3) * HEAD_BOB,
        ]);
        headFeatures.push({
          type: 'Feature',
          // 後排的先畫，前排的才蓋得住他 —— 這一層的疊放順序就是 feature 的順序
          properties: { img: ensureHead(map, memberPaths[i].userId, color), scale: headScale },
          geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] },
        });
      });
    };

    /** 往回看一小段，用來判斷車頭朝哪邊 */
    const prevOf = (i: number) => posAt(memberPaths[i].nodes, cursorT - FACING_LOOKBACK_MS);

    for (const group of convoyAt(convoys, cursorT)) {
      const present = group.filter((i) => pos[i]);
      if (present.length < 2) continue;
      for (const i of present) inConvoy.add(i);

      let lng = 0;
      let lat = 0;
      for (const i of present) { lng += pos[i]![0]; lat += pos[i]![1]; }
      const center: [number, number] = [lng / present.length, lat / present.length];

      // 上一刻的形心。只算「剛剛也在」的那幾個人，不然有人中途加入會讓
      // 形心跳一大步，車頭跟著亂轉
      const prevs = present.map(prevOf).filter((p): p is [number, number] => p != null);
      const prev: [number, number] | null = prevs.length
        ? [
            prevs.reduce((s, p) => s + p[0], 0) / prevs.length,
            prevs.reduce((s, p) => s + p[1], 0) / prevs.length,
          ]
        : null;

      placeCar(present, center, prev);
    }

    for (let i = 0; i < memberPaths.length; i++) {
      const p = pos[i];
      if (!p || inConvoy.has(i)) continue;
      placeCar([i], p, prevOf(i));
    }

    vehicleSrc?.setData({ type: 'FeatureCollection', features: carFeatures });
    headsSrc?.setData({ type: 'FeatureCollection', features: headFeatures });

    /*
     * 跟拍：每一幀都把鏡頭對到車目前的位置，讓它固定在畫面正中央。
     *
     * 用 setCenter 而不是 easeTo —— easeTo 是「用 N 毫秒滑過去」，每幀都下一次
     * 新的 easeTo 會不斷打斷上一次的補間，鏡頭永遠追在車後面，車就會飄到
     * 畫面邊緣（原本每 600ms 才對準一次節點，正是這個症狀）。時間游標本身已經是
     * 連續內插出來的，直接設中心就已經是平滑的移動。
     *
     * 好幾台車時對準它們的形心：跟著其中一台跑的話，其他人隨時會被甩出畫面，
     * 而「大家分頭在哪」正是多身分播放要看的東西。
     */
    if (playing && carFeatures.length > 0) {
      let cx = 0;
      let cy = 0;
      for (const f of carFeatures) { cx += f.geometry.coordinates[0]; cy += f.geometry.coordinates[1]; }
      map.setCenter([cx / carFeatures.length, cy / carFeatures.length]);
    }
  }, [cursorT, memberPaths, convoys, colorFor, ensureCar, ensureHead, headTick, ready, playing]);

  // --- 播放迴圈 ---
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    // 不管一天走了 300 公尺還是 300 公里，1x 都大約 25 秒跑完 ——
    // 進度本身就是位移總量，除以總時長就是等速（見 TimeWarp 的註解）
    const perSec = (warp.total / PLAY_SECONDS) * speed;
    let last = performance.now();
    const tick = (now: number) => {
      // requestAnimationFrame 給的是「這一幀開始」的時間，可能早於上面那個
      // 在同一幀的 JS 裡取的 performance.now()，第一次 tick 的 dt 會是負的
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      setProgress((p) => {
        const next = p + dt * perSec;
        if (next >= warp.total) {
          setPlaying(false);
          return warp.total;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, speed, warp.total]);

  const replay = useCallback(() => {
    setProgress(0);
    setPlaying(true);
  }, []);

  // --- 軌跡點編修 ---

  const selectedPoints = useMemo(
    () => (tracks || []).filter((p) => selectedIds.has(p.id)),
    [tracks, selectedIds],
  );

  const selectedPhotos = useMemo(
    () => sorted.filter((p) => selectedPhotoIds.has(p.id)),
    [sorted, selectedPhotoIds],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedPhotoIds(new Set());
    anchorIdxRef.current = null;
    setEditError(null);
  }, []);

  const enterEdit = useCallback(() => {
    setPlaying(false);
    clearSelection();
    setEditing(true);
  }, [clearSelection]);

  const exitEdit = useCallback(() => {
    setEditing(false);
    clearSelection();
  }, [clearSelection]);

  const submitEdits = useCallback(async (edits: TrackPointEdit[]) => {
    if (!onEditPoints || edits.length === 0) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const ok = await onEditPoints(edits);
      // 失敗時保留選取，使用者才能直接重試而不用重選一次
      if (ok) clearSelection();
      else setEditError('儲存失敗，請再試一次');
    } finally {
      setEditBusy(false);
    }
  }, [onEditPoints, clearSelection]);

  const deleteSelected = useCallback(() => {
    if (selectedPoints.length === 0) return;
    if (!window.confirm(`確定刪除 ${selectedPoints.length} 個軌跡點？`)) return;
    // 後端是逐日改的（day_key 同時當作刪除的防護），跨日的選取要拆成多筆
    const byDay = new Map<string, number[]>();
    for (const p of selectedPoints) {
      const ids = byDay.get(p.day_key);
      if (ids) ids.push(p.id);
      else byDay.set(p.day_key, [p.id]);
    }
    void submitEdits(Array.from(byDay, ([dayKey, deleteIds]) => ({ dayKey, deleteIds, insert: [] })));
  }, [selectedPoints, submitEdits]);

  const mergeSelected = useCallback(() => {
    if (selectedPoints.length < 2) {
      setEditError('至少要選兩個點才能合併');
      return;
    }
    const { day_key: dayKey, seg } = selectedPoints[0];
    if (selectedPoints.some((p) => p.day_key !== dayKey || p.seg !== seg)) {
      setEditError('合併的點必須在同一天的同一段軌跡內');
      return;
    }

    const times = selectedPoints.map((p) => Date.parse(p.t_utc)).filter(Number.isFinite);
    if (times.length === 0) { setEditError('選到的點沒有有效時間'); return; }
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);

    // 把時間區間內的點全部吸收，不只刪選到的 —— 中間漏掉幾個沒選到的點，
    // 合併完那裡還是一團亂跳，等於沒合併
    const absorbed = (tracks || [])
      .filter((p) => {
        if (p.day_key !== dayKey || p.seg !== seg) return false;
        const t = Date.parse(p.t_utc);
        return Number.isFinite(t) && t >= t0 && t <= t1;
      })
      .sort((a, b) => Date.parse(a.t_utc) - Date.parse(b.t_utc));
    if (absorbed.length < 2) { setEditError('沒有可以合併的點'); return; }

    const lat = absorbed.reduce((s, p) => s + p.lat, 0) / absorbed.length;
    const lng = absorbed.reduce((s, p) => s + p.lng, 0) / absorbed.length;
    const staySec = Math.max(1, Math.round((t1 - t0) / 1000));

    if (!window.confirm(
      `把 ${absorbed.length} 個點合併成一處停留（${humanDuration(staySec)}）？`,
    )) return;

    void submitEdits([{
      dayKey,
      deleteIds: absorbed.map((p) => p.id),
      // 兩個同座標的點（進入、離開），跟匯入時濃縮停留產生的形狀完全一樣。
      // 時間直接沿用原本的字串，免得格式跟既有資料對不上。
      // 少了離開點的話，停留期間拍的照片在時間軸上會全部落到下一個移動點之後
      insert: [
        { t: absorbed[0].t_utc, lat, lng, src: 'stay', seg, staySec },
        { t: absorbed[absorbed.length - 1].t_utc, lat, lng, src: 'stay', seg, staySec: null },
      ],
    }]);
  }, [selectedPoints, tracks, submitEdits]);

  // --- 軌跡點與照片的結合 ---
  //
  // 兩邊都是「同一個地點」的兩種記錄：軌跡是手機每隔幾秒記一次的實測位置，
  // 照片是相機在按下快門那一刻記的。哪一邊比較準沒有定論（相機的 GPS 收訊常常
  // 比手機好，但也可能是進了室內才定位到），所以兩個方向都留給使用者決定。

  /** 剛好一個軌跡點配一張照片才談得上結合。湊不齊就是 null */
  const mergePair = useMemo(() => {
    if (selectedPoints.length !== 1 || selectedPhotos.length !== 1) return null;
    return { point: selectedPoints[0], photo: selectedPhotos[0] };
  }, [selectedPoints, selectedPhotos]);

  /** 軌跡點搬到照片的位置 */
  const movePointToPhoto = useCallback(() => {
    if (!mergePair) return;
    const { point, photo } = mergePair;
    const n = orderById.get(point.id);
    if (!window.confirm(
      `把軌跡點${n ? ` #${n}` : ''} 移到「${photo.title}」的位置？`,
    )) return;
    void submitEdits([{
      dayKey: point.day_key,
      deleteIds: [point.id],
      // 刪掉再插一個新的 —— 後端沒有「只改座標」的操作。時間、段別、停留秒數
      // 原封不動抄過去，所以在動畫與段的統計上它還是同一個點，只是位置換了
      insert: [{
        t: point.t_utc,
        lat: photo.lat,
        lng: photo.lng,
        src: point.src ?? 'manual',
        seg: point.seg,
        staySec: point.stay_sec ?? null,
      }],
    }]);
  }, [mergePair, orderById, submitEdits]);

  /** 照片搬到軌跡點的位置。geo_source 會變成 manual，之後的內插補點不會再覆蓋它 */
  const movePhotoToPoint = useCallback(async () => {
    if (!mergePair || !onMovePhoto) return;
    const { point, photo } = mergePair;
    const n = orderById.get(point.id);
    if (!window.confirm(
      `把「${photo.title}」移到軌跡點${n ? ` #${n}` : ''} 的位置？`,
    )) return;
    setEditBusy(true);
    setEditError(null);
    try {
      if (await onMovePhoto(photo.id, point.lat, point.lng)) clearSelection();
      else setEditError('儲存失敗，請再試一次');
    } finally {
      setEditBusy(false);
    }
  }, [mergePair, onMovePhoto, orderById, clearSelection]);

  const canEdit = editable && !!onEditPoints && (tracks?.length ?? 0) > 0;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height, borderRadius: 12, overflow: 'hidden' }} />

      {/*
        這裡曾經有一塊「這個範圍內還沒有帶座標的照片」的半透明遮罩。拿掉了：
        它的判斷只看照片與 GPS 軌跡，Google 足跡那層畫得好好的也照樣蓋上去，
        等於用一段建議把使用者真正想看的東西擋住。地圖沒東西看不看得出來，
        本來就不需要一層蓋在上面的東西來說明 —— 右上角的狀態列已經在講點數了。
      */}

      {canEdit && !editing && (
        <button
          onClick={enterEdit}
          style={{
            position: 'absolute', left: 12, top: 12, border: 'none', borderRadius: 8,
            padding: '6px 12px', cursor: 'pointer', fontSize: 13,
            background: 'rgba(255,255,255,.94)', color: '#0f172a',
            boxShadow: '0 2px 8px rgba(0,0,0,.15)',
          }}
        >
          ✎ 編輯軌跡點
        </button>
      )}

      {editing && (
        <div style={{
          position: 'absolute', left: 12, right: 12, bottom: 12, padding: '10px 14px',
          background: 'rgba(255,255,255,.96)', borderRadius: 10,
          boxShadow: '0 2px 12px rgba(0,0,0,.15)', display: 'flex',
          alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13, color: '#0f172a', fontWeight: 600, flexShrink: 0 }}>
            已選 {selectedPoints.length} 點
            {selectedPhotos.length > 0 && ` ・ ${selectedPhotos.length} 張照片`}
          </span>
          <span style={{ fontSize: 12, color: '#64748b', flex: '1 1 200px', minWidth: 0 }}>
            點擊軌跡點或照片選取，按住 Shift 點第二個軌跡點可連選一段
          </span>

          {/* 選到照片時才長出來 —— 平常這排已經四顆按鈕，再多兩顆會擠成一團 */}
          {selectedPhotos.length > 0 && (
            <>
              <button
                onClick={movePointToPhoto}
                disabled={editBusy || !mergePair}
                title="軌跡點的座標改成這張照片的座標"
                style={{
                  border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
                  background: mergePair ? '#0f766e' : '#e2e8f0',
                  color: mergePair ? '#fff' : '#94a3b8',
                  cursor: editBusy || !mergePair ? 'default' : 'pointer',
                }}
              >
                軌跡點 → 照片
              </button>
              <button
                onClick={movePhotoToPoint}
                disabled={editBusy || !mergePair || !onMovePhoto}
                title="照片的座標改成這個軌跡點的座標，並標記為手動指定"
                style={{
                  border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
                  background: mergePair && onMovePhoto ? '#2563eb' : '#e2e8f0',
                  color: mergePair && onMovePhoto ? '#fff' : '#94a3b8',
                  cursor: editBusy || !mergePair || !onMovePhoto ? 'default' : 'pointer',
                }}
              >
                照片 → 軌跡點
              </button>
            </>
          )}

          <button
            onClick={mergeSelected}
            disabled={editBusy || selectedPoints.length < 2}
            style={{
              border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
              background: selectedPoints.length < 2 ? '#e2e8f0' : '#16a34a',
              color: selectedPoints.length < 2 ? '#94a3b8' : '#fff',
              cursor: editBusy || selectedPoints.length < 2 ? 'default' : 'pointer',
            }}
          >
            合併成一個停留點
          </button>
          <button
            onClick={deleteSelected}
            disabled={editBusy || selectedPoints.length === 0}
            style={{
              border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, flexShrink: 0,
              background: selectedPoints.length === 0 ? '#e2e8f0' : '#dc2626',
              color: selectedPoints.length === 0 ? '#94a3b8' : '#fff',
              cursor: editBusy || selectedPoints.length === 0 ? 'default' : 'pointer',
            }}
          >
            刪除
          </button>
          <button
            onClick={clearSelection}
            disabled={editBusy || (selectedPoints.length === 0 && selectedPhotos.length === 0)}
            style={{
              border: '1px solid #cbd5e1', borderRadius: 8, padding: '5px 12px', fontSize: 13,
              background: '#fff', color: '#475569', flexShrink: 0,
              cursor: editBusy || (selectedPoints.length === 0 && selectedPhotos.length === 0)
                ? 'default' : 'pointer',
            }}
          >
            取消選取
          </button>
          <button
            onClick={exitEdit}
            disabled={editBusy}
            style={{
              border: '1px solid #cbd5e1', borderRadius: 8, padding: '5px 12px', fontSize: 13,
              background: '#fff', color: '#475569', cursor: editBusy ? 'default' : 'pointer',
              flexShrink: 0,
            }}
          >
            離開編輯
          </button>

          {editBusy && <span style={{ fontSize: 12, color: '#64748b' }}>儲存中…</span>}
          {editError && <span style={{ fontSize: 12, color: '#dc2626' }}>{editError}</span>}
        </div>
      )}

      {/* 沒有路徑就沒有東西可以播 —— 只有照片標記、沒開「連接照片位置」時就是這樣 */}
      {!editing && warp.times.length > 1 && (
        <div style={{
          position: 'absolute', left: 12, right: 12, bottom: 12, padding: '10px 14px',
          background: 'rgba(255,255,255,.94)', borderRadius: 10,
          boxShadow: '0 2px 12px rgba(0,0,0,.15)', display: 'flex',
          alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <button
            onClick={() => (atEnd ? replay() : setPlaying((p) => !p))}
            style={{
              border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
              background: '#2563eb', color: '#fff', fontSize: 14, flexShrink: 0,
            }}
          >
            {atEnd ? '重播' : playing ? '暫停' : '播放'}
          </button>

          {/*
            拉桿走的是播放進度（＝大家一共移動了多少）而不是時間，跟播放本身
            同一把尺 —— 用真實時間當刻度的話，半夜那八小時會佔掉拉桿一大截，
            拖過去卻什麼都沒發生
          */}
          <input
            type="range"
            min={0}
            max={warp.total}
            step="any"
            value={progress}
            onChange={(e) => {
              setPlaying(false);
              setProgress(Number(e.target.value));
            }}
            style={{ flex: '1 1 180px', minWidth: 140 }}
            aria-label="時間軸"
          />

          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ fontSize: 13, padding: '4px 6px', borderRadius: 6, flexShrink: 0 }}
            aria-label="播放速度"
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={3}>3x</option>
            <option value={8}>8x</option>
          </select>

          {current && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 200px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.url}
                alt={current.title}
                style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
              />
              <div style={{ fontSize: 12, lineHeight: 1.4, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {current.place_name || current.title}
                </div>
                <div style={{ color: '#64748b' }}>
                  {shortTime(current.local_time)}
                  {current.geo_source === 'timeline' && '（Google 時間軸）'}
                  {current.geo_source === 'segment' && '（打卡地點）'}
                  {current.geo_source === 'interpolated' && '（推估位置）'}
                  {current.geo_source === 'manual' && '（手動指定）'}
                </div>
              </div>
            </div>
          )}

          <div style={{ fontSize: 12, color: '#64748b', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 16 }} title="播放中的位置">
              {MOVER_EMOJI}
            </span>
            {/*
              改顯示時間而不是「第幾點／共幾點」：多身分同框時每個人的點數不一樣，
              那個分母根本不知道是誰的。時間則是所有人共用的那把尺
            */}
            {cursorLabel(cursorT)}
          </div>
        </div>
      )}
    </div>
  );
}
