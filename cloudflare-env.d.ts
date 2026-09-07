interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Blob, options?: {
    httpMetadata?: {
      contentType?: string;
      cacheControl?: string;
    };
  }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    PROFILE_PHOTOS: R2Bucket;
  };
}
