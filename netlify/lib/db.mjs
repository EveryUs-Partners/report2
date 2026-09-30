// 저장소 어댑터: 운영=Netlify Blobs, 로컬 테스트=파일(LOCAL_DATA_DIR)
import fs from 'node:fs/promises';
import path from 'node:path';

export function getDb() {
  if (process.env.LOCAL_DATA_DIR) return fileDb(process.env.LOCAL_DATA_DIR);
  return blobDb();
}

function blobDb() {
  let storePromise;
  const store = async () => {
    if (!storePromise) {
      storePromise = import('@netlify/blobs').then((m) =>
        m.getStore({ name: 'shift-data', consistency: 'strong' })
      );
    }
    return storePromise;
  };
  return {
    async get(key) {
      return (await store()).get(key, { type: 'json' });
    },
    async set(key, value) {
      await (await store()).setJSON(key, value);
    },
    async del(key) {
      await (await store()).delete(key);
    },
    async list(prefix) {
      const { blobs } = await (await store()).list({ prefix });
      return blobs.map((b) => b.key);
    },
  };
}

function fileDb(dir) {
  const file = (k) => path.join(dir, encodeURIComponent(k));
  return {
    async get(key) {
      try {
        return JSON.parse(await fs.readFile(file(key), 'utf8'));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key), JSON.stringify(value));
    },
    async del(key) {
      await fs.rm(file(key), { force: true });
    },
    async list(prefix) {
      try {
        const names = await fs.readdir(dir);
        return names.map(decodeURIComponent).filter((k) => k.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}
