import type { ApiError } from "@shared/types";

const BASE = "/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body as ApiError;
    throw new Error(describeError(err, path, res.status));
  }
  return body as T;
}

// Server errors carry { error, detail }. Show both - a bare "failed with 502"
// tells nobody anything. A response with no JSON body at all (e.g. a gateway
// timing out) gets an explicit explanation too.
function describeError(err: ApiError, path: string, status: number): string {
  if (err.error) return err.detail ? `${err.error} ${err.detail}` : err.error;
  if (status === 502 || status === 504)
    return `The server didn't answer in time (HTTP ${status}). If this was a long operation it may still be running.`;
  return `Request to ${path} failed with HTTP ${status}.`;
}

export type JobStatus<T> =
  | { status: "running" | "pending" }
  | ({ status: "done" } & T)
  | { status: "failed"; error: string; detail?: string };

// Poll a background job until it finishes. Long AI work (drafting a paper)
// runs server-side as a job precisely so no single request has to stay open
// past a proxy's timeout; this is the client half of that.
export async function pollJob<T>(
  path: string,
  { intervalMs = 3000, timeoutMs = 10 * 60 * 1000 }: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const job = await request<JobStatus<T>>(path, { method: "GET" });
    if (job.status === "done") return job as unknown as T;
    if (job.status === "failed") throw new Error(job.detail ? `${job.error} ${job.detail}` : job.error);
    if (Date.now() - started > timeoutMs) throw new Error("Gave up waiting for the job to finish.");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const api = {
  get: <T,>(path: string) => request<T>(path, { method: "GET" }),
  post: <T,>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  patch: <T,>(path: string, data?: unknown) =>
    request<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  // For multipart/form-data uploads (e.g. the QCTO-document instrument
  // intake). Deliberately bypasses `request()`'s JSON Content-Type header -
  // the browser needs to set its own multipart boundary, which it can only
  // do if we don't set Content-Type ourselves.
  postForm: async <T,>(path: string, formData: FormData): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body as ApiError;
      throw new Error(describeError(err, path, res.status));
    }
    return body as T;
  },
};
