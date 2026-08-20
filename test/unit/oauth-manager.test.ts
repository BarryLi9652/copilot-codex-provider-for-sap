import assert from "node:assert/strict";
import test from "node:test";

import {
  CHATGPT_OAUTH_SECRET_KEY,
  type OAuthSession,
  type SecretStore,
} from "../../src/transports/chatgpt-oauth/oauth-store.js";
import {
  OAuthError,
  OAuthManager,
  type OAuthFetch,
  type OAuthHttpResponse,
} from "../../src/transports/chatgpt-oauth/oauth-manager.js";
import type {
  LoopbackServer,
  LoopbackServerHandle,
} from "../../src/transports/chatgpt-oauth/loopback-server.js";

const waitForCondition = async (
  condition: () => boolean,
  description: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}.`);
};

class MemorySecretStore implements SecretStore {
  public value: string | undefined;
  public readonly keys: string[] = [];

  public get(key: string): Promise<string | undefined> {
    this.keys.push(`get:${key}`);
    return Promise.resolve(this.value);
  }

  public store(key: string, value: string): Promise<void> {
    this.keys.push(`store:${key}`);
    this.value = value;
    return Promise.resolve();
  }

  public delete(key: string): Promise<void> {
    this.keys.push(`delete:${key}`);
    this.value = undefined;
    return Promise.resolve();
  }
}

class FakeLoopbackHandle implements LoopbackServerHandle {
  public readonly port = 1455;
  public readonly redirectUri = "http://localhost:1455/auth/callback";
  public readonly callback: Promise<string>;
  public closed = false;
  public closeCalls = 0;
  public closeStarted = false;
  public closeError: Error | undefined;
  private resolveCallback!: (url: string) => void;
  private rejectCallback!: (error: Error) => void;
  private closeGate: Promise<void> | undefined;
  private releaseCloseGate: (() => void) | undefined;

  public constructor() {
    this.callback = new Promise<string>((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
    });
  }

  public emit(url: string): void {
    this.resolveCallback(url);
  }

  public reject(error: Error): void {
    this.rejectCallback(error);
  }

  public deferClose(): void {
    this.closeGate = new Promise<void>((resolve) => {
      this.releaseCloseGate = resolve;
    });
  }

  public releaseClose(): void {
    this.releaseCloseGate?.();
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.closeStarted = true;
    await this.closeGate;
    if (this.closeError) {
      throw this.closeError;
    }
    this.closed = true;
  }
}

class FakeLoopbackServer implements LoopbackServer {
  public readonly handles: FakeLoopbackHandle[] = [];

  public async start(): Promise<LoopbackServerHandle> {
    const handle = new FakeLoopbackHandle();
    this.handles.push(handle);
    return handle;
  }
}

class DeferredStartLoopbackServer implements LoopbackServer {
  public starts = 0;
  public readonly handles: FakeLoopbackHandle[] = [];
  public readonly firstStart: Promise<void>;
  private releaseFirstStart!: () => void;

  public constructor() {
    this.firstStart = new Promise<void>((resolve) => {
      this.releaseFirstStart = resolve;
    });
  }

  public release(): void {
    this.releaseFirstStart();
  }

  public async start(): Promise<LoopbackServerHandle> {
    this.starts += 1;
    const handle = new FakeLoopbackHandle();
    this.handles.push(handle);
    if (this.starts === 1) {
      await this.firstStart;
    }
    return handle;
  }
}

const response = (body: unknown, status = 200): OAuthHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const session = (overrides: Partial<OAuthSession> = {}): OAuthSession => ({
  accessToken: "access-old",
  refreshToken: "refresh-old",
  expiresAt: 2_000,
  ...overrides,
});

const completeManualSignIn = async (
  manager: OAuthManager,
  code: string,
): Promise<OAuthSession> => {
  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });
  await waitForCondition(() => authorizeUrl.length > 0, "authorize URL");
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state);
  const callback = manager.completeManualCallback(
    `http://localhost:1455/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
  const [result] = await Promise.all([signIn, callback]);
  return result;
};

test("callback state mismatch rejects before token exchange", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new FakeLoopbackServer();
  let tokenRequests = 0;
  const fetch: OAuthFetch = async () => {
    tokenRequests += 1;
    return response({ access_token: "unexpected", refresh_token: "unexpected" });
  };
  const manager = new OAuthManager(secrets, {
    fetch,
    loopbackServer: loopback,
    now: () => 1_000,
  });

  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });
  while (!authorizeUrl) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  await assert.rejects(
    manager.completeManualCallback(
      "http://localhost:1455/auth/callback?code=code&state=wrong-state",
    ),
    /state mismatch/i,
  );
  await assert.rejects(signIn, /state mismatch/i);
  assert.equal(tokenRequests, 0);
});

test("malformed stored JSON is ignored instead of being exchanged", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = "{not-json";
  let tokenRequests = 0;
  const fetch: OAuthFetch = async () => {
    tokenRequests += 1;
    return response({ access_token: "unexpected", refresh_token: "unexpected" });
  };
  const manager = new OAuthManager(secrets, { fetch, now: () => 1_000 });

  await assert.rejects(manager.getAccessToken(), /authentication is required/i);
  assert.equal(tokenRequests, 0);
  assert.ok(secrets.keys.includes(`get:${CHATGPT_OAUTH_SECRET_KEY}`));
});

test("sign-in exchanges the validated code and stores a complete session", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new FakeLoopbackServer();
  const requests: { url: string; body: string }[] = [];
  const fetch: OAuthFetch = async (url, init) => {
    requests.push({ url, body: String(init?.body) });
    return response({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3_600,
    });
  };
  const manager = new OAuthManager(secrets, {
    fetch,
    loopbackServer: loopback,
    now: () => 10_000,
  });
  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });

  while (!authorizeUrl) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state);
  const result = await (async () => {
    const callback = manager.completeManualCallback(
      `http://localhost:1455/auth/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    );
    return Promise.all([signIn, callback]);
  })();

  assert.deepEqual(result[0], {
    accessToken: "access-new",
    refreshToken: "refresh-new",
    expiresAt: 3_610_000,
  });
  assert.deepEqual(result[1], result[0]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://auth.openai.com/oauth/token");
  const body = new URLSearchParams(requests[0]?.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "authorization-code");
  assert.equal(body.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.match(body.get("code_verifier") ?? "", /^[A-Za-z0-9_-]+$/);
  assert.equal(secrets.keys.at(-1), `store:${CHATGPT_OAUTH_SECRET_KEY}`);
});

test("expiry within sixty seconds uses one refresh request for concurrent callers", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session({ expiresAt: 1_030 }));
  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const fetch: OAuthFetch = async (_url, init) => {
    refreshCalls += 1;
    assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
    await refreshReleased;
    return response({ access_token: "access-refreshed", expires_in: 3_600 });
  };
  const manager = new OAuthManager(secrets, { fetch, now: () => 1_000 });

  const first = manager.getAccessToken();
  const second = manager.getAccessToken();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);

  releaseRefresh();
  assert.deepEqual(await Promise.all([first, second]), [
    { token: "access-refreshed" },
    { token: "access-refreshed" },
  ]);
  assert.deepEqual(JSON.parse(secrets.value ?? "null"), {
    accessToken: "access-refreshed",
    refreshToken: "refresh-old",
    expiresAt: 3_601_000,
  });
});

test("forced refresh shares one request for concurrent callers", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session({ expiresAt: 10_000 }));
  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const fetch: OAuthFetch = async (_url, init) => {
    refreshCalls += 1;
    assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
    await refreshReleased;
    return response({ access_token: "access-forced", expires_in: 3_600 });
  };
  const manager = new OAuthManager(secrets, { fetch, now: () => 1_000 });

  const first = manager.getAccessToken(true);
  const second = manager.getAccessToken(true);
  await waitForCondition(() => refreshCalls === 1, "one forced refresh request");

  releaseRefresh();
  assert.deepEqual(await Promise.all([first, second]), [
    { token: "access-forced" },
    { token: "access-forced" },
  ]);
  assert.equal(refreshCalls, 1);
});

test("a new sign-in prevents an old refresh success from replacing the new account", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session({ expiresAt: 1_030 }));
  let refreshStarted!: () => void;
  const refreshStartedSignal = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const loopback = new FakeLoopbackServer();
  const fetch: OAuthFetch = async (_url, init) => {
    const fields = new URLSearchParams(String(init?.body));
    if (fields.get("grant_type") === "refresh_token") {
      refreshStarted();
      await refreshReleased;
      return response({ access_token: "access-account-a", expires_in: 3_600 });
    }
    return response({
      access_token: "access-account-b",
      refresh_token: "refresh-account-b",
      expires_in: 3_600,
    });
  };
  const manager = new OAuthManager(secrets, {
    fetch,
    loopbackServer: loopback,
    now: () => 1_000,
  });

  const staleRefresh = manager.getAccessToken();
  await refreshStartedSignal;
  const accountB = await completeManualSignIn(manager, "account-b-code");
  assert.equal(accountB.accessToken, "access-account-b");
  assert.deepEqual(JSON.parse(secrets.value ?? "null"), accountB);

  releaseRefresh();
  await assert.rejects(
    staleRefresh,
    (error: unknown) =>
      error instanceof OAuthError && error.code === "callback_closed",
  );
  assert.deepEqual(JSON.parse(secrets.value ?? "null"), accountB);
  assert.deepEqual(await manager.getAccessToken(), { token: "access-account-b" });
});

test("a new sign-in prevents an old invalid_grant from clearing the new account", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session({ expiresAt: 1_030 }));
  let refreshStarted!: () => void;
  const refreshStartedSignal = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const loopback = new FakeLoopbackServer();
  const fetch: OAuthFetch = async (_url, init) => {
    const fields = new URLSearchParams(String(init?.body));
    if (fields.get("grant_type") === "refresh_token") {
      refreshStarted();
      await refreshReleased;
      return response({ error: "invalid_grant" }, 400);
    }
    return response({
      access_token: "access-account-b",
      refresh_token: "refresh-account-b",
      expires_in: 3_600,
    });
  };
  const manager = new OAuthManager(secrets, {
    fetch,
    loopbackServer: loopback,
    now: () => 1_000,
  });

  const staleRefresh = manager.getAccessToken();
  await refreshStartedSignal;
  const accountB = await completeManualSignIn(manager, "account-b-code");
  assert.equal(accountB.accessToken, "access-account-b");
  assert.deepEqual(JSON.parse(secrets.value ?? "null"), accountB);

  releaseRefresh();
  await assert.rejects(
    staleRefresh,
    (error: unknown) =>
      error instanceof OAuthError && error.code === "callback_closed",
  );
  assert.deepEqual(JSON.parse(secrets.value ?? "null"), accountB);
  assert.deepEqual(await manager.getAccessToken(), { token: "access-account-b" });
});

test("concurrent sign-in reserves one slot before loopback start resolves", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new DeferredStartLoopbackServer();
  const manager = new OAuthManager(secrets, { loopbackServer: loopback });
  let browserCalls = 0;

  const first = manager.signIn(async () => {
    browserCalls += 1;
    return true;
  });
  await waitForCondition(() => loopback.starts === 1, "first loopback start");
  const second = manager.signIn(async () => {
    browserCalls += 1;
    return true;
  });

  try {
    assert.equal(loopback.starts, 1);
    assert.equal(browserCalls, 0);
    await assert.rejects(
      second,
      (error: unknown) =>
        error instanceof OAuthError && error.code === "sign_in_in_progress",
    );
  } finally {
    loopback.release();
    for (const handle of loopback.handles) {
      handle.reject(new Error("test cleanup"));
    }
    await Promise.allSettled([first, second]);
  }
});

test("successful callback waits for loopback close to settle", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new FakeLoopbackServer();
  const manager = new OAuthManager(secrets, {
    loopbackServer: loopback,
    fetch: async () =>
      response({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3_600 }),
  });
  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });
  await waitForCondition(() => authorizeUrl.length > 0, "authorize URL");
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state);
  const handle = loopback.handles[0];
  assert.ok(handle);
  handle.deferClose();

  let signInSettled = false;
  void signIn.then(
    () => {
      signInSettled = true;
    },
    () => {
      signInSettled = true;
    },
  );
  const callback = manager.completeManualCallback(
    `http://localhost:1455/auth/callback?code=code&state=${encodeURIComponent(state)}`,
  );
  try {
    await waitForCondition(() => handle.closeStarted, "loopback close start");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signInSettled, false);
  } finally {
    handle.releaseClose();
  }
  await callback;
  await signIn;
  assert.equal(signInSettled, true);
});

test("loopback close failure is surfaced as a typed OAuth error", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new FakeLoopbackServer();
  const manager = new OAuthManager(secrets, {
    loopbackServer: loopback,
    fetch: async () =>
      response({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3_600 }),
  });
  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });
  await waitForCondition(() => authorizeUrl.length > 0, "authorize URL");
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state);
  const handle = loopback.handles[0];
  assert.ok(handle);
  handle.closeError = new Error("synthetic close failure");
  const callback = manager.completeManualCallback(
    `http://localhost:1455/auth/callback?code=code&state=${encodeURIComponent(state)}`,
  );

  await assert.rejects(
    callback,
    (error: unknown) =>
      error instanceof OAuthError && (error.code as string) === "callback_close_failed",
  );
  await assert.rejects(
    signIn,
    (error: unknown) =>
      error instanceof OAuthError && (error.code as string) === "callback_close_failed",
  );
  assert.equal(handle.closeCalls, 1);
});

test("callback failure preserves the primary error and records close failure", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new FakeLoopbackServer();
  const manager = new OAuthManager(secrets, { loopbackServer: loopback });
  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });
  await waitForCondition(() => authorizeUrl.length > 0, "authorize URL");
  const handle = loopback.handles[0];
  assert.ok(handle);
  handle.closeError = new Error("synthetic close failure");
  const callback = manager.completeManualCallback(
    "http://localhost:1455/auth/callback?code=code&state=wrong-state",
  );

  await assert.rejects(
    callback,
    (error: unknown) => {
      if (!(error instanceof OAuthError) || error.code !== "callback_state_mismatch") {
        return false;
      }
      const cleanup = (error as OAuthError & { cleanupError?: unknown }).cleanupError;
      return cleanup instanceof OAuthError && (cleanup.code as string) === "callback_close_failed";
    },
  );
  await assert.rejects(
    signIn,
    (error: unknown) => error instanceof OAuthError && error.code === "callback_state_mismatch",
  );
  assert.equal(handle.closeCalls, 1);
});

test("loopback callback rejection still awaits close and reports timeout cleanup", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new FakeLoopbackServer();
  const manager = new OAuthManager(secrets, { loopbackServer: loopback });
  const signIn = manager.signIn(async () => true);
  await waitForCondition(() => loopback.handles.length === 1, "loopback handle");
  const handle = loopback.handles[0];
  assert.ok(handle);
  handle.closeError = new Error("synthetic close failure");
  handle.reject(new Error("OAuth callback server timed out."));

  await assert.rejects(
    signIn,
    (error: unknown) => {
      if (!(error instanceof OAuthError) || error.code !== "callback_timeout") {
        return false;
      }
      const cleanup = (error as OAuthError & { cleanupError?: unknown }).cleanupError;
      return cleanup instanceof OAuthError && (cleanup.code as string) === "callback_close_failed";
    },
  );
  assert.equal(handle.closeCalls, 1);
});

test("sign-out clears storage before surfacing a loopback close failure", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session());
  const loopback = new FakeLoopbackServer();
  const manager = new OAuthManager(secrets, { loopbackServer: loopback });
  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });
  await waitForCondition(() => authorizeUrl.length > 0, "authorize URL");
  const handle = loopback.handles[0];
  assert.ok(handle);
  handle.closeError = new Error("synthetic close failure");
  const signInFailure = assert.rejects(
    signIn,
    (error: unknown) => error instanceof OAuthError && error.code === "callback_closed",
  );

  await assert.rejects(
    manager.signOut(),
    (error: unknown) =>
      error instanceof OAuthError && (error.code as string) === "callback_close_failed",
  );
  await signInFailure;
  assert.equal(secrets.value, undefined);
  assert.ok(secrets.keys.includes(`delete:${CHATGPT_OAUTH_SECRET_KEY}`));
  assert.equal(handle.closeCalls, 1);
});

test("invalid_grant clears the extension session", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session({ expiresAt: 1_030 }));
  const fetch: OAuthFetch = async () => response({ error: "invalid_grant" }, 400);
  const manager = new OAuthManager(secrets, { fetch, now: () => 1_000 });

  await assert.rejects(manager.getAccessToken(), /authentication is required/i);
  assert.equal(secrets.value, undefined);
});

test("JWT metadata is optional session context and never required for token use", async () => {
  const secrets = new MemorySecretStore();
  const loopback = new FakeLoopbackServer();
  const accessToken = [
    "header",
    Buffer.from(
      JSON.stringify({
        email: "user@example.test",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
  const manager = new OAuthManager(secrets, {
    loopbackServer: loopback,
    fetch: async () =>
      response({ access_token: accessToken, refresh_token: "refresh-new", expires_in: 3_600 }),
  });
  let authorizeUrl = "";
  const signIn = manager.signIn(async (url) => {
    authorizeUrl = url;
    return true;
  });
  while (!authorizeUrl) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state);

  const result = await manager.completeManualCallback(
    `http://localhost:1455/auth/callback?code=code&state=${encodeURIComponent(state)}`,
  );
  await signIn;

  assert.equal(result.accountId, "acct-test");
  assert.equal(result.email, "user@example.test");
});
