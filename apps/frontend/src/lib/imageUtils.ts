import exifr from 'exifr';
import piexif from 'piexifjs';
import { normalizeGeo } from './geo';

/**
 * GIF 的動畫本體上限。**後端 `index.ts` 的 `GIF_MAX_BYTES` 是同一個數字，
 * 要改就兩邊一起改** —— 這裡是為了在選檔當下就講得出原因，後端那道才是真的關。
 *
 * 25MB 的由來：GIF 是站上**唯一位元組真的躺在 R2 的媒體**（照片只有兩顆縮圖、
 * 影片只有一張封面），所以它直接吃免費額度的儲存空間；而後端收檔走的是
 * `request.formData()`，整份會進 Worker 記憶體（上限 128MB）。
 * 再大的動畫本來就該錄成影片走影片那條。
 */
export const GIF_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 這個檔是不是 GIF。
 *
 * GIF **不轉影片、動畫本體整份進 R2**（見 migrations/0021）：`<video>` 播不了
 * image/gif，走影片那條就得轉檔，而轉檔在瀏覽器（ffmpeg.wasm 要的 COOP/COEP
 * 會弄壞 Google Picker、Drive 上傳與地圖圖磚）與 Worker（10ms CPU）兩邊都做不到。
 *
 * 有些來源的 `File.type` 是空的，退回看副檔名 —— 跟 `isVideoFile` 同一個規矩。
 */
export function isGifFile(file: File): boolean {
  if (file.type) return file.type.toLowerCase() === 'image/gif';
  return /\.gif$/i.test(file.name);
}

/**
 * 燈箱要用的 4K WebP。長邊 3840、q80。
 *
 * **一定要餵原始檔，不要餵 resizeImageFile 的產物** —— 那份已經被壓到 2000px，
 * 再放大到 3840 只會得到一張又大又糊的圖。
 *
 * WebP 沒有 EXIF（piexifjs 只寫得進 JPEG），這裡刻意接受：
 *   - 拍攝資訊在上傳當下就被解析進 D1 了，顯示不靠檔案本身
 *   - **原始檔會原封不動另外存一份到 Drive**，EXIF 一個位元組都不會少
 * 也就是說這張純粹是「拿來看的那一份」。
 *
 * 回傳 null 代表這個瀏覽器編不出 WebP 或畫布失敗 —— 呼叫端該當成
 * 「這張沒有 4K」，照片本身照樣成立（見 [[縮圖成功就算數]]）。
 */
export async function encode4kWebp(file: File, maxEdge: number = 3840): Promise<Blob | null> {
  if (!file.type.startsWith('image/')) return null;

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('圖片解碼失敗'));
      el.src = objectUrl;
    });

    // 只縮不放。手機拍的 4032×3024 本來就小於 3840 的對角，放大沒有意義
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.8);
    });
    // toBlob 對不認得的 MIME 會安靜地吐 PNG。一張 4K 的 PNG 是好幾 MB，
    // 寧可回 null 讓燈箱退回 R2，也不要把它塞進 Drive
    if (!blob || blob.type !== 'image/webp') return null;
    return blob;
  } catch (e) {
    console.warn('4K WebP 產生失敗', e);
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function resizeImageFile(file: File, maxEdge: number = 2000): Promise<{ file: File; exifData: any; takenAt: string | null }> {
  // 檢查是否為圖片
  if (!file.type.startsWith('image/')) {
    return { file, exifData: null, takenAt: null };
  }

  // 1. 嘗試解析 EXIF
  let exifData = null;
  let takenAt = null;
  let exifDump = null;

  try {
    exifData = await exifr.parse(file, true);

    if (exifData) {
      // exifr 預設會把 EXIF 時間字串 revive 成 Date，但 EXIF 時間不帶時區，
      // revive 是以「瀏覽器當下時區」解讀的 —— 一旦 JSON.stringify 送到後端就會位移。
      // 例：在台灣(+8)上傳日本拍的 09:30，會變成 01:30Z，行程段比對就整批對不上。
      // 因此另取一次未經轉換的原始字串覆寫回去，讓後端拿到真正的牆上時間。
      try {
        const rawTime: any = await exifr.parse(file, { reviveValues: false, exif: true, gps: true });
        if (rawTime) {
          for (const key of ['DateTimeOriginal', 'OffsetTimeOriginal', 'GPSDateStamp', 'GPSTimeStamp']) {
            const v = rawTime[key];
            if (typeof v === 'string' || Array.isArray(v)) exifData[key] = v;
          }
        }
      } catch (e) {
        console.warn("原始 EXIF 時間字串解析失敗，時區可能不準:", e);
      }

      // 由 OffsetTimeOriginal 或 GPS UTC 時戳推導時區後，才換算出正確的 UTC 瞬間
      takenAt = normalizeGeo(exifData).takenAtUtc;
    }


    if (file.type === 'image/jpeg') {
      try {
        const dataURL = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const exifObj = piexif.load(dataURL);
        exifDump = piexif.dump(exifObj);
      } catch (e) {
        console.warn("piexifjs could not dump exif:", e);
      }
    }
  } catch (e) {
    console.error("EXIF 解析失敗:", e);
  }

  // 2. 如果是 HEIC/HEIF 檔案，使用 heic2any 轉換為 JPEG
  let processFile = file;
  if (file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif')) {
    try {
      const heic2any = (await import('heic2any')).default;
      const convertedBlob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      processFile = new File([Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", { type: 'image/jpeg' });
    } catch (e) {
      console.error("HEIC 轉換失敗:", e);
      throw new Error("HEIC 轉換失敗");
    }
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(processFile);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        // 如果長邊小於等於 maxEdge，且檔案原本就是 jpeg 時，才能不縮圖直接回傳，否則也需要透過 canvas 轉換格式
        if (width <= maxEdge && height <= maxEdge && processFile.type === 'image/jpeg') {
          resolve({ file: processFile, exifData, takenAt });
          return;
        }

        // 計算等比例縮放後的尺寸
        if (width > height) {
          height = Math.round((height * maxEdge) / width);
          width = maxEdge;
        } else {
          width = Math.round((width * maxEdge) / height);
          height = maxEdge;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ file, exifData, takenAt });
          return;
        }

        // 繪製高畫質縮圖
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        const outputType = 'image/jpeg';
        const quality = 0.9;
        const outFileName = file.name.replace(/\.[^/.]+$/, "") + ".jpg";

        if (exifDump) {
          // 如果是 JPEG 且有 EXIF，將 EXIF 寫回
          const dataUrl = canvas.toDataURL(outputType, quality);
          try {
            const finalDataUrl = piexif.insert(exifDump, dataUrl);
            // Convert dataUrl to blob
            const arr = finalDataUrl.split(',');
            const mime = arr[0].match(/:(.*?);/)?.[1];
            const bstr = atob(arr[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while(n--){
                u8arr[n] = bstr.charCodeAt(n);
            }
            const blob = new Blob([u8arr], {type: mime});
            const resizedFile = new File([blob], outFileName, {
              type: outputType,
              lastModified: Date.now(),
            });
            resolve({ file: resizedFile, exifData, takenAt });
          } catch(e) {
            console.error("Failed to insert EXIF back:", e);
            canvas.toBlob((blob) => {
              if (blob) resolve({ file: new File([blob], outFileName, { type: outputType, lastModified: Date.now() }), exifData, takenAt });
              else resolve({ file: processFile, exifData, takenAt });
            }, outputType, quality);
          }
        } else {
          canvas.toBlob((blob) => {
            if (!blob) {
              resolve({ file: processFile, exifData, takenAt });
              return;
            }
            const resizedFile = new File([blob], outFileName, {
              type: outputType,
              lastModified: Date.now(),
            });
            resolve({ file: resizedFile, exifData, takenAt });
          }, outputType, quality);
        }
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
}
