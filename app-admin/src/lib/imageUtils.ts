/**
 * Generate a thumbnail from a base64 image using a canvas element.
 * Standard AdventureWorks ProductPhoto thumbnail size: 75×56 px
 */
export function generateThumbnail(
  base64: string,
  filename: string,
  width = 75,
  height = 56,
): Promise<{ thumbBase64: string; thumbFilename: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get canvas 2D context"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const thumbBase64 = canvas.toDataURL("image/png");
      const ext = filename.match(/\.[^.]+$/)?.[0] ?? ".png";
      const thumbFilename = filename.replace(/\.[^.]+$/, `_thumb${ext}`);
      resolve({ thumbBase64, thumbFilename });
    };
    img.onerror = () =>
      reject(new Error("Failed to load image for thumbnail generation"));
    img.src = base64;
  });
}
