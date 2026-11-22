import { createClerkClient, verifyToken } from "@clerk/backend";
import { User, db, hashPassword, nowSec } from "./store.js";
import crypto from "node:crypto";

export const CLERK_PUBLISHABLE_KEY = (process.env.CLERK_PUBLISHABLE_KEY || "").trim();
export const CLERK_SECRET_KEY = (process.env.CLERK_SECRET_KEY || "").trim();
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

export function isClerkEnabled(): boolean {
  return Boolean(CLERK_PUBLISHABLE_KEY && CLERK_SECRET_KEY);
}

const clerkClient = CLERK_SECRET_KEY ? createClerkClient({ secretKey: CLERK_SECRET_KEY }) : null;

export interface ClerkIdentity {
  clerkUserId: string;
  email: string;
  name: string;
}

export async function verifyClerkBearerToken(token: string): Promise<ClerkIdentity | null> {
  if (!isClerkEnabled() || !token) return null;
  try {
    const payload = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    const clerkUserId = String(payload.sub || "");
    if (!clerkUserId) return null;

    let email = String((payload as any).email || "").trim().toLowerCase();
    let name = String((payload as any).name || "").trim();

    if ((!email || !name) && clerkClient) {
      try {
        const clerkUser = await clerkClient.users.getUser(clerkUserId);
        const primary =
          clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId) ||
          clerkUser.emailAddresses[0];
        if (primary?.emailAddress) email = primary.emailAddress.toLowerCase();
        name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() || clerkUser.username || email;
      } catch {
        // Fallback to sub if profile fetch fails transiently
      }
    }

    return {
      clerkUserId,
      email,
      name: name || email || clerkUserId,
    };
  } catch {
    return null;
  }
}

export function resolveOrProvisionClerkUser(identity: ClerkIdentity): User {
  // 1. Match by clerk_user_id
  let user = db.users.find((u) => u.clerk_user_id === identity.clerkUserId);
  if (user) return user;

  // 2. Match pre-invited staff account by email
  if (identity.email) {
    user = db.users.find(
      (u) => u.email && u.email.toLowerCase() === identity.email.toLowerCase(),
    );
    if (user) {
      user.clerk_user_id = identity.clerkUserId;
      return user;
    }
  }

  // 3. Provision a new clinic owner (or admin if email matches ADMIN_EMAIL)
  const isAdmin = Boolean(ADMIN_EMAIL && identity.email && identity.email === ADMIN_EMAIL);
  const baseUsername = (identity.email || identity.name || identity.clerkUserId)
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, "_")
    .slice(0, 60);
  let username = baseUsername || `user_${nowSec()}`;
  let suffix = 1;
  while (db.users.some((u) => u.username === username)) {
    username = `${baseUsername.slice(0, 50)}_${suffix++}`;
  }

  user = {
    id: db.nextId("users"),
    username,
    email: identity.email || null,
    clerk_user_id: identity.clerkUserId,
    password_hash: hashPassword(crypto.randomBytes(24).toString("hex")),
    role: isAdmin ? "admin" : "owner",
    clinic_id: null,
    active: true,
  };
  db.users.push(user);
  db.audit(user.username, "user.clerk_provisioned", user.id, null);
  return user;
}
