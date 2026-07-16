export async function resizeImageFile(file: File, maxEdge: number = 2000): Promise<File> {
  // 檢查是否為圖片
  if (!file.type.startsWith('image/')) {
    return file;
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

        // 如果長邊小於等於 maxEdge，則不需要縮圖，直接回傳原檔案
        if (width <= maxEdge && height <= maxEdge) {
          resolve(file);
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
          resolve(file);
          return;
        }

        // 繪製高畫質縮圖
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // 將 Canvas 轉回 Blob (使用 JPEG 或 WebP 品質 0.9)
        // 為了保持透明度，PNG 原樣輸出為 PNG，其餘轉換為 JPEG
        const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const quality = outputType === 'image/jpeg' ? 0.9 : undefined;

        canvas.toBlob((blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          // 將 Blob 轉回 File
          const resizedFile = new File([blob], file.name, {
            type: outputType,
            lastModified: Date.now(),
          });
          resolve(resizedFile);
        }, outputType, quality);
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
}
