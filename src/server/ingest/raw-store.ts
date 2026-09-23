// Raw API responses are stored BEFORE transformation, so metrics can be recomputed without
// calling the API again (docs/tubestat-spec.md, principle 4). S3 when configured, else a local dir.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RawStore {
  put(key: string, body: unknown): Promise<string>;
  get(key: string): Promise<unknown>;
}

export class LocalRawStore implements RawStore {
  constructor(private dir: string) {}
  async put(key: string, body: unknown) {
    const file = path.join(this.dir, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(body));
    return key;
  }
  async get(key: string) { return JSON.parse(await readFile(path.join(this.dir, key), "utf8")); }
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
}

export function rawStoreFromEnv(env: Record<string, string | undefined> = process.env): RawStore {
  if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
    return new S3RawStore({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY });
  }
  return new LocalRawStore(env.RAW_DIR ?? "/data/raw");
}

/** raw/{source}/{cut}/{date}/{runId}.json */
export const rawKey = (source: string, cut: string, date: string, runId: string) => `raw/${source}/${cut}/${date}/${runId}.json`;
