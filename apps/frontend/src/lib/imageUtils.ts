import exifr from 'exifr';
import piexif from 'piexifjs';

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
    if (exifData && exifData.DateTimeOriginal) {
      takenAt = new Date(exifData.DateTimeOriginal).toISOString();
    }
    
    if (file.type === 'image/jpeg') {
      // 讀取原始檔案轉 Base64 以提取 piexifjs 可用的 dump
      const buffer = await file.arrayBuffer();
      const base64Str = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
      const dataURL = `data:image/jpeg;base64,${base64Str}`;
      
      try {
        const exifObj = piexif.load(dataURL);
        exifDump = piexif.dump(exifObj);
      } catch (e) {
        console.warn("piexifjs could not dump exif:", e);
      }
    }
  } catch (e) {
    console.error("EXIF 解析失敗:", e);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        // 如果長邊小於等於 maxEdge，且檔案原本就是 jpeg 時，才能不縮圖直接回傳，否則也需要透過 canvas 轉換格式
        if (width <= maxEdge && height <= maxEdge && file.type === 'image/jpeg') {
          resolve({ file, exifData, takenAt });
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
              else resolve({ file, exifData, takenAt });
            }, outputType, quality);
          }
        } else {
          canvas.toBlob((blob) => {
            if (!blob) {
              resolve({ file, exifData, takenAt });
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
