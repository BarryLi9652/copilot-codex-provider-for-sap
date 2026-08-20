import assert from "node:assert/strict";
import test from "node:test";

import {
  CHATGPT_OAUTH_SECRET_KEY,
  type OAuthSession,
  type SecretStore,
} from "../../src/transports/chatgpt-oauth/oauth-store.js";
import {
  OAuthManager,
  type OAuthFetch,
  type OAuthHttpResponse,
} from "../../src/transports/chatgpt-oauth/oauth-manager.js";
import type {
  LoopbackServer,
  LoopbackServerHandle,
} from "../../src/transports/chatgpt-oauth/loopback-server.js";

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
  private resolveCallback!: (url: string) => void;
  private rejectCallback!: (error: Error) => void;

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

  public async close(): Promise<void> {
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
