/**
 * Reduz a foto no próprio aparelho antes de enviar: converte para JPEG e
 * limita o lado maior. Uma foto de celular de 8–12 MB vira ~0,5 MB, o que
 * sobe rápido no 4G e ainda mantém a nota legível. Também resolve fotos
 * HEIC do iPhone, que o navegador decodifica e reexporta como JPEG.
 */
export async function photoToJpeg(file: File, maxSide = 2400, quality = 0.85): Promise<{ base64: string; preview: string }> {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não consegui processar a foto neste navegador");
  ctx.drawImage(bitmap, 0, 0, w, h);
  if ("close" in bitmap) bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), preview: dataUrl };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      // respeita a rotação EXIF (foto tirada com o celular de pé)
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // cai no método antigo abaixo
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(`Não consegui abrir "${file.name}". Tire a foto em JPG ou envie como PDF.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
