import exifr from 'exifr';
import piexif from 'piexifjs';
import { normalizeGeo } from './geo';

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
