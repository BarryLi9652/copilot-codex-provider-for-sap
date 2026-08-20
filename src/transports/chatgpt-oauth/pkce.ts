import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const randomBase64Url = (): string => randomBytes(32).toString("base64url");

export const createPkcePair = (): PkcePair => {
  const verifier = randomBase64Url();
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
};

export const createOAuthState = (): string => randomBase64Url();

export const createState = createOAuthState;
