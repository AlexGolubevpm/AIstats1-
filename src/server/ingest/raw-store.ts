// Raw API responses are stored BEFORE transformation, so metrics can be recomputed without
// calling the API again (docs/tubestat-spec.md, principle 4). S3 when configured, else a local dir.
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const gz = promisify(gzip);
const gunz = promisify(gunzip);

export interface RawStore {
  put(key: string, body: unknown): Promise<string>;
  get(key: string): Promise<unknown>;
  /** Keys under a prefix (e.g. "raw/adspyglass/country/"). */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/**
 * Files on the server's disk, gzipped (`<key>.gz`; ADOK JSON shrinks ~10×). Keys stay `….json`:
 * callers never see the compression. Plain files written before it are still read and listed,
 * and `compressLegacy` (the nightly raw:prune) converts them.
 */
export class LocalRawStore implements RawStore {
  constructor(private dir: string) {}
  async put(key: string, body: unknown) {
    const file = path.join(this.dir, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.gz`, await gz(JSON.stringify(body)));
    return key;
  }
  async get(key: string) {
    const file = path.join(this.dir, key);
    const text = await readFile(`${file}.gz`).then(async (b) => (await gunz(b)).toString("utf8"), () => readFile(file, "utf8"));
    return JSON.parse(text);
  }
  private async files(prefix: string): Promise<string[]> {
    try {
      const files = await readdir(path.join(this.dir, prefix), { recursive: true, withFileTypes: true });
      return files.filter((f) => f.isFile()).map((f) => path.relative(this.dir, path.join(f.parentPath, f.name)).split(path.sep).join("/"));
    } catch { return []; }
  }
  async list(prefix: string) {
    return [...new Set((await this.files(prefix)).map((f) => f.replace(/\.gz$/, "")))].sort();
  }
  async delete(key: string) {
    const file = path.join(this.dir, key);
    await rm(`${file}.gz`, { force: true });
    await rm(file, { force: true });
    await rmdir(path.dirname(file)).catch(() => {}); // the day's folder, once it is empty
  }
  /** Gzips plain files left from before compression; returns how many. */
  async compressLegacy(prefix = "raw/"): Promise<number> {
    let n = 0;
    for (const f of await this.files(prefix)) {
      if (!f.endsWith(".json")) continue;
      const file = path.join(this.dir, f);
      await writeFile(`${file}.gz`, await gz(await readFile(file)));
      await rm(file);
      n++;
    }
    return n;
  }
}

export class S3RawStore implements RawStore {
  constructor(private cfg: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string }) {}
  private async client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({ endpoint: this.cfg.endpoint, region: this.cfg.region ?? "auto", forcePathStyle: true,
      credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey } });
  }
  async put(key: string, body: unknown) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: JSON.stringify(body), ContentType: "application/json" }));
    return key;
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const r = await (await this.client()).send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return JSON.parse(await r.Body!.transformToString());
  }
  async list(prefix: string) {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await c.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      out.push(...(r.Contents ?? []).map((o) => o.Key!).filter(Boolean));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

export function rawStoreFromEnv(env: Record<string, string | undefined> = process.env): RawStore {
  if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
    return new S3RawStore({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY });
  }
  return new LocalRawStore(env.RAW_DIR ?? "/data/raw");
}

/** raw/{source}/{cut}/{date}/{runId}.json */
export const rawKey = (source: string, cut: string, date: string, runId: string) => `raw/${source}/${cut}/${date}/${runId}.json`;
