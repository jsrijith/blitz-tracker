// Keeps the stall's data in this browser's localStorage, saved on every change.
import { defaultData, parseData, finishedTokens } from "./rules.js";

const KEY = "blitz-tracker-v1";

export function load() {
  let text = null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    // Storage blocked (private mode on some phones). Start empty; the page warns.
  }
  if (!text) return defaultData();
  try {
    return parseData(text);
  } catch (err) {
    // Keep the unreadable copy so nothing is lost, and start fresh.
    try {
      localStorage.setItem(`${KEY}-broken-${Date.now()}`, text);
    } catch {}
    console.error(err);
    return defaultData();
  }
}

// Returns false if the browser refused to save, so the page can warn loudly.
export function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

export function tokensSinceBackup(data) {
  return Math.max(0, finishedTokens(data).length - (data.lastBackupTokens || 0));
}

// Asks the browser not to clear our storage when space runs low.
export async function askPersistent() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}

// Saves a file. A computer whose browser can (Chrome or Edge on Windows, Mac, Linux, ChromeOS) asks where
// to save it; a phone hands it to the share sheet; anything else downloads it.
export async function shareFile(name, type, text) {
  const file = new File([text], name, { type });
  if (window.showSaveFilePicker) {
    let handle;
    try {
      const ext = name.slice(name.lastIndexOf("."));
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: name, accept: { [type]: [ext] } }] });
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
      handle = null; // blocked, say inside a frame: fall through to the share sheet or a download
    }
    if (handle) {
      const out = await handle.createWritable();
      await out.write(file);
      await out.close();
      return "saved";
    }
  }
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "downloaded";
}
