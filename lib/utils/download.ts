/**
 * Hands the browser a file to save.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari
 * and some Chromium builds abort the download if the URL is released in the
 * same task as the click.
 */
export function downloadTextFile(filename: string, contents: string, mimeType = "application/json") {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Reads a picked file as text, as a promise rather than an event dance. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsText(file);
  });
}
