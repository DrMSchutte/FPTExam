import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Block 8b: where recording segments live. Video cannot sit in the database
// the way stills do (about a gigabyte per learner per three-hour paper), so it
// goes to object storage:
//
//   RECORDINGS_STORAGE=replit   Replit App Storage (the bucket attached to the Repl;
//                               @replit/object-storage, no secrets needed)
//   RECORDINGS_STORAGE=local    the server's filesystem under RECORDINGS_DIR
//                               (default server/data/recordings) - development and
//                               small venues only; the disk is finite
//
// Unset: local. Keys look like recordings/<sessionId>/<kind>/<seq>.webm.

export interface ObjectStore {
  kind: "replit" | "local";
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localRoot = () => process.env.RECORDINGS_DIR ?? path.resolve(__dirname, "../../data/recordings");

const safe = (key: string) => {
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes("..")) throw new Error(`Bad storage key: ${key}`);
  return key;
};

function localStore(): ObjectStore {
  const root = localRoot();
  const file = (key: string) => path.join(root, safe(key));
  return {
    kind: "local",
    async put(key, bytes) { const f = file(key); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, bytes); },
    async get(key) { try { return await fs.readFile(file(key)); } catch { return null; } },
    async delete(key) { try { await fs.unlink(file(key)); } catch { /* gone */ } },
    async deletePrefix(prefix) {
      const dir = path.join(root, safe(prefix));
      let n = 0;
      const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else { await fs.unlink(p).catch(() => {}); n++; } } };
      await walk(dir);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return n;
    },
  };
}

async function replitStore(): Promise<ObjectStore> {
  const { Client } = await import("@replit/object-storage");
  const client = new Client(process.env.RECORDINGS_BUCKET ? { bucketId: process.env.RECORDINGS_BUCKET } : undefined);
  return {
    kind: "replit",
    async put(key, bytes) { const r = await client.uploadFromBytes(safe(key), bytes); if (!r.ok) throw new Error(`Object storage upload failed: ${r.error?.message ?? "unknown"}`); },
    async get(key) { const r = await client.downloadAsBytes(safe(key)); return r.ok ? Buffer.from(r.value[0]) : null; },
    async delete(key) { await client.delete(safe(key)).catch(() => {}); },
    async deletePrefix(prefix) {
      const r = await client.list({ prefix: safe(prefix) });
      if (!r.ok) return 0;
      let n = 0;
      for (const o of r.value) { const d = await client.delete(o.name); if (d.ok) n++; }
      return n;
    },
  };
}

let store: Promise<ObjectStore> | null = null;
export function objectStore(): Promise<ObjectStore> {
  if (!store) store = (process.env.RECORDINGS_STORAGE === "replit" ? replitStore() : Promise.resolve(localStore()));
  return store;
}

export const storageDescription = () => (process.env.RECORDINGS_STORAGE === "replit" ? "Replit App Storage" : `this server's disk (${localRoot()})`);
