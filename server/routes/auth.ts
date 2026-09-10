import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { parseColorValue } from "../../src/lib/colorPalette";
import {
  clearSessionCookie,
  createSession,
  requireAuth,
  requireAuthForSessionCheck,
  requireAdmin,
  requirePasswordChanged,
  requestUser,
  revokeRequestSession,
  revokeUserSessions,
  setSessionCookie,
} from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { db, query, queryOne, transaction } from "../lib/database";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password";
import { ACTIVE_RUN_LIMIT } from "../lib/generationLimits";
import {
  prepareUserTemplateAccountMutation,
  reconcileUserTemplateAccountMutations,
} from "../lib/userTemplateLifecycle";

export const authRouter = Router();

interface UserRow {
  id: string;
  account_id: string;
  display_name: string;
  role: "admin" | "user";
  must_change_password: number;
  active?: number;
  created_at?: string;
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    ...(row.active === undefined ? {} : { active: row.active === 1 }),
    ...(row.created_at ? { createdAt: row.created_at } : {}),
  };
}

const MAX_FAVORITE_COLORS = 128;
const MAX_COLOR_VALUE_LENGTH = 64;

function normalizeFavoriteColors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FAVORITE_COLORS) {
    throw new Error(`收藏颜色必须是最多 ${MAX_FAVORITE_COLORS} 项的数组`);
  }
  const seen = new Set<string>();
  const favorites: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate.length > MAX_COLOR_VALUE_LENGTH) {
      throw new Error("收藏颜色格式无效");
    }
    const color = parseColorValue(candidate);
    if (!seen.has(color)) {
      seen.add(color);
      favorites.push(color);
    }
  }
  return favorites;
}

function validateExpectedPreferenceOwner(req: Request, res: Response, userId: string): boolean {
  const expectedOwnerId = req.get("x-expected-user-id");
  if (!expectedOwnerId || expectedOwnerId === userId) return true;
  res.status(409).json({ error: "登录账号已切换，请刷新后重试", code: "SESSION_OWNER_MISMATCH" });
  return false;
}

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { accountId, password } = req.body as { accountId?: string; password?: string };
  if (typeof accountId !== "string" || typeof password !== "string" || !accountId.trim() || !password) {
    res.status(400).json({ error: "账号和密码不能为空" });
    return;
  }
  const row = await queryOne<UserRow & { password_hash: string; active: number }>(`
    SELECT id, account_id, display_name, role, password_hash, must_change_password, active
    FROM users WHERE account_id = $1 AND deleted_at IS NULL
  `, [accountId.trim()]);
  if (!row || row.active !== 1 || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ error: "账号或密码错误" });
    return;
  }
  const session = await createSession(row.id);
  setSessionCookie(res, session.token);
  res.json({ user: publicUser(row), expiresAt: session.expiresAt });
}));

authRouter.get("/me", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  requireAuthForSessionCheck(req, res, next);
}, (req, res) => {
  res.json({ user: requestUser(req) });
});

authRouter.use(requireAuth);

authRouter.post("/logout", asyncHandler(async (req, res) => {
  await revokeRequestSession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

authRouter.post("/change-password", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "当前密码和新密码不能为空" });
    return;
  }
  const invalid = validatePassword(newPassword);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const row = await queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ error: "当前密码错误" });
    return;
  }
  const now = new Date().toISOString();
  await query("UPDATE users SET password_hash = $1, must_change_password = 0, updated_at = $2 WHERE id = $3", [
    hashPassword(newPassword), now, user.id,
  ]);
  const session = await createSession(user.id, { markExistingAsReplaced: false });
  setSessionCookie(res, session.token);
  res.json({ ok: true, user: { ...user, mustChangePassword: false }, expiresAt: session.expiresAt });
}));

authRouter.use(requirePasswordChanged);


authRouter.get("/color-preferences", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  if (!validateExpectedPreferenceOwner(req, res, user.id)) return;
  const row = await queryOne<{ favorite_colors: unknown }>(`
    SELECT favorite_colors FROM user_color_preferences WHERE user_id = $1
  `, [user.id]);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ownerId: user.id,
    favorites: row ? normalizeFavoriteColors(row.favorite_colors) : [],
    initialized: Boolean(row),
  });
}));

authRouter.put("/color-preferences", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  if (!validateExpectedPreferenceOwner(req, res, user.id)) return;
  let favorites: string[];
  try {
    favorites = normalizeFavoriteColors((req.body as { favorites?: unknown })?.favorites);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "收藏颜色格式无效" });
    return;
  }
  const initializedFavorites = await transaction(async (client) => {
    const updatedAt = new Date().toISOString();
    await client.query(`
      INSERT INTO user_color_preferences (user_id, favorite_colors, updated_at)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (user_id) DO NOTHING
    `, [user.id, JSON.stringify(favorites), updatedAt]);
    const result = await client.query<{ favorite_colors: unknown }>(`
      SELECT favorite_colors FROM user_color_preferences WHERE user_id = $1
    `, [user.id]);
    return normalizeFavoriteColors(result.rows[0]?.favorite_colors);
  });
  res.json({ ownerId: user.id, favorites: initializedFavorites });
}));

authRouter.patch("/color-preferences", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  if (!validateExpectedPreferenceOwner(req, res, user.id)) return;
  const body = req.body as { color?: unknown; favorite?: unknown; bootstrapFavorites?: unknown };
  let color: string;
  let bootstrapFavorites: string[];
  try {
    if (body.favorite !== true && body.favorite !== false) throw new Error("收藏状态格式无效");
    color = normalizeFavoriteColors([body.color])[0];
    bootstrapFavorites = normalizeFavoriteColors(body.bootstrapFavorites ?? []);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "收藏颜色格式无效" });
    return;
  }
  const result = await transaction(async (client) => {
    const updatedAt = new Date().toISOString();
    await client.query(`
      INSERT INTO user_color_preferences (user_id, favorite_colors, updated_at)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (user_id) DO NOTHING
    `, [user.id, JSON.stringify(bootstrapFavorites), updatedAt]);
    const locked = await client.query<{ favorite_colors: unknown }>(`
      SELECT favorite_colors FROM user_color_preferences WHERE user_id = $1 FOR UPDATE
    `, [user.id]);
    const current = normalizeFavoriteColors(locked.rows[0]?.favorite_colors);
    const favorites = body.favorite
      ? current.includes(color) ? current : [...current, color]
      : current.filter((candidate) => candidate !== color);
    if (favorites.length > MAX_FAVORITE_COLORS) {
      return { favorites: current, limitReached: true };
    }
    await client.query(`
      UPDATE user_color_preferences SET favorite_colors = $1::jsonb, updated_at = $2
      WHERE user_id = $3
    `, [JSON.stringify(favorites), updatedAt, user.id]);
    return { favorites, limitReached: false };
  });
  if (result.limitReached) {
    res.status(400).json({ error: `收藏颜色最多保存 ${MAX_FAVORITE_COLORS} 项` });
    return;
  }
  res.json({ ownerId: user.id, favorites: result.favorites });
}));
authRouter.get("/users", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query<UserRow>(`
    SELECT id, account_id, display_name, role, must_change_password, active, created_at
    FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC
  `);
  res.json(rows.map(publicUser));
}));

authRouter.post("/users", requireAdmin, asyncHandler(async (req, res) => {
  const { accountId, displayName, password, role } = req.body as {
    accountId?: string; displayName?: string; password?: string; role?: "admin" | "user";
  };
  if (typeof accountId !== "string" || !/^[A-Za-z0-9@._+-]{3,64}$/.test(accountId) ||
      typeof displayName !== "string" || !displayName.trim() || displayName.length > 100 ||
      typeof password !== "string") {
    res.status(400).json({ error: "账号、名称或密码格式无效" });
    return;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const now = new Date().toISOString();
  const id = nanoid(12);
  try {
    await query(`
      INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $6)
    `, [id, accountId, displayName.trim(), role === "admin" ? "admin" : "user", hashPassword(password), now]);
    res.status(201).json({ id });
  } catch (error) {
    const duplicate = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
    res.status(duplicate ? 409 : 500).json({ error: duplicate ? "账号已存在" : String(error) });
  }
}));

authRouter.patch("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  const { active, displayName } = req.body as { active?: boolean; displayName?: string };
  if (req.params.id === actor.id && active === false) {
    res.status(400).json({ error: "不能停用当前管理员账号" });
    return;
  }
  const row = await queryOne<{ id: string }>("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  const now = new Date().toISOString();
  if (typeof displayName === "string" && displayName.trim() && displayName.length <= 100) {
    await query("UPDATE users SET display_name = $1, updated_at = $2 WHERE id = $3", [displayName.trim(), now, req.params.id]);
  }
  if (typeof active === "boolean") {
    await query("UPDATE users SET active = $1, updated_at = $2 WHERE id = $3", [active ? 1 : 0, now, req.params.id]);
    if (!active) await revokeUserSessions(req.params.id);
  }
  res.json({ ok: true });
}));

authRouter.post("/users/:id/reset-password", requireAdmin, asyncHandler(async (req, res) => {
  const { password } = req.body as { password?: string };
  if (typeof password !== "string") {
    res.status(400).json({ error: "新密码不能为空" });
    return;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const result = await db().query(`
    UPDATE users SET password_hash = $1, must_change_password = 1, updated_at = $2
    WHERE id = $3 AND deleted_at IS NULL
  `, [hashPassword(password), new Date().toISOString(), req.params.id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  await revokeUserSessions(req.params.id);
  res.json({ ok: true });
}));

authRouter.delete("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  if (req.params.id === actor.id) {
    res.status(400).json({ error: "不能删除当前管理员账号" });
    return;
  }
  const { transferToUserId, deleteData } = req.body as { transferToUserId?: string; deleteData?: boolean };
  if (!transferToUserId && deleteData !== true) {
    res.status(400).json({ error: "必须选择数据接收用户，或明确将数据放入 15 天回收站" });
    return;
  }
  if (transferToUserId === req.params.id) {
    res.status(400).json({ error: "不能把账号数据转移给自身" });
    return;
  }
  const source = await queryOne<{ id: string }>("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!source) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  if (transferToUserId) {
    const target = await queryOne<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND active = 1 AND deleted_at IS NULL",
      [transferToUserId],
    );
    if (!target) {
      res.status(400).json({ error: "数据接收用户不存在或已停用" });
      return;
    }
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const purgeAfter = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString();
  const outcome = await transaction(async (client) => {
    // 所有新生成任务先持有 owner 用户共享锁；账号变更按 id 稳定取得排他锁，
    // 保证请求要么先完整入队并随后被转移/回收，要么在账号变更后被拒绝。
    const userIds = transferToUserId
      ? [req.params.id, transferToUserId]
      : [req.params.id];
    const lockedUsers = (await client.query<{ id: string; active: number; deleted_at: string | null }>(`
      SELECT id, active, deleted_at FROM users
      WHERE id = ANY($1::text[])
      ORDER BY id
      FOR NO KEY UPDATE
    `, [userIds])).rows;
    const lockedSource = lockedUsers.find((row) => row.id === req.params.id);
    if (!lockedSource || lockedSource.deleted_at !== null) {
      return { status: "source_changed" as const };
    }
    if (transferToUserId) {
      const lockedTarget = lockedUsers.find((row) => row.id === transferToUserId);
      if (!lockedTarget || lockedTarget.active !== 1 || lockedTarget.deleted_at !== null) {
        return { status: "target_changed" as const };
      }
      const activeRuns = (await client.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM generation_runs
        WHERE owner_id = ANY($1::text[])
          AND deleted_at IS NULL
          AND plan_json IS NOT NULL
          AND status IN ('queued','running','retry_wait','cancel_requested')
      `, [[req.params.id, transferToUserId]])).rows[0]?.count ?? 0;
      if (activeRuns > ACTIVE_RUN_LIMIT) {
        return { status: "active_limit" as const };
      }
      const initialDrafts = (await client.query<{ owner_id: string }>(`
        SELECT owner_id FROM projects
        WHERE owner_id = ANY($1::text[])
          AND lifecycle = 'initial_draft'
          AND deleted_at IS NULL
        ORDER BY id
        FOR UPDATE
      `, [[req.params.id, transferToUserId]])).rows;
      const draftOwners = new Set(initialDrafts.map((row) => row.owner_id));
      if (draftOwners.has(req.params.id) && draftOwners.has(transferToUserId)) {
        return { status: "draft_conflict" as const };
      }
    } else {
      const activeRuns = (await client.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM generation_runs
        WHERE owner_id = $1
          AND deleted_at IS NULL
          AND plan_json IS NOT NULL
          AND status IN ('queued','running','retry_wait','cancel_requested')
      `, [req.params.id])).rows[0]?.count ?? 0;
      if (activeRuns > 0) return { status: "active_runs" as const };
    }
    if (transferToUserId) {
      for (const table of ["projects", "assets"] as const) {
        await client.query(`UPDATE ${table} SET owner_id = $1 WHERE owner_id = $2`, [transferToUserId, req.params.id]);
      }
      await client.query(`
        UPDATE try_on_style_presets source
        SET name = source.name || '（转移 ' || left(source.id, 4) || '）'
        WHERE source.owner_id = $2 AND source.deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM try_on_style_presets target
          WHERE target.owner_id = $1 AND target.deleted_at IS NULL
            AND lower(target.name) = lower(source.name)
        )
      `, [transferToUserId, req.params.id]);
      await client.query(
        "UPDATE try_on_style_presets SET owner_id = $1 WHERE owner_id = $2",
        [transferToUserId, req.params.id],
      );
      // 源/目标用户排他锁已隔离新 Run；这里只按行更新，避免与 Worker 的
      // generation_runs 行锁形成表锁升级死锁。
      await client.query(`
        UPDATE generation_runs source
        SET client_request_id = NULL, request_fingerprint = NULL
        WHERE source.owner_id = $2
          AND source.client_request_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM generation_runs target
            WHERE target.owner_id = $1
              AND target.client_request_id = source.client_request_id
          )
      `, [transferToUserId, req.params.id]);
      await client.query(
        "UPDATE generation_runs SET owner_id = $1 WHERE owner_id = $2",
        [transferToUserId, req.params.id],
      );
      await client.query(
        "UPDATE usage_events SET owner_id = $1 WHERE owner_id = $2",
        [transferToUserId, req.params.id],
      );
      // Worker 按 run → files/usage 的顺序提交结果。先等待并转移 Run，再扫
      // 结果表，才能包含它在等待期间刚登记的文件和消耗记录。
      await client.query(
        "UPDATE files SET owner_id = $1 WHERE owner_id = $2",
        [transferToUserId, req.params.id],
      );
    } else {
      await client.query(
        "UPDATE projects SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL",
        [nowIso, purgeAfter, req.params.id],
      );
      await client.query(
        "UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL",
        [nowIso, purgeAfter, req.params.id],
      );
      await client.query(
        "UPDATE try_on_style_presets SET deleted_at = $1, updated_at = $1 WHERE owner_id = $2 AND deleted_at IS NULL",
        [nowIso, req.params.id],
      );
      for (const table of ["generation_runs", "usage_events", "files"] as const) {
        await client.query(
          `UPDATE ${table} SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL`,
          [nowIso, purgeAfter, req.params.id],
        );
      }
    }
    const templateMutation = prepareUserTemplateAccountMutation({
      sourceOwnerId: req.params.id,
      sourceDeletedAt: nowIso,
      ...(transferToUserId
        ? { transferToOwnerId: transferToUserId }
        : { deletedAt: nowIso, purgeAfter }),
    });
    templateMutation.apply();
    await client.query("DELETE FROM sessions WHERE user_id = $1", [req.params.id]);
    await client.query("UPDATE users SET active = 0, deleted_at = $1, updated_at = $1 WHERE id = $2", [nowIso, req.params.id]);
    return { status: "ok" as const };
  }).catch(async (error) => {
    await reconcileUserTemplateAccountMutations().catch((reconcileError) => {
      console.error("[garment-canvas] failed to reconcile user template ownership mutation", reconcileError);
    });
    throw error;
  });
  await reconcileUserTemplateAccountMutations().catch((reconcileError) => {
    console.error("[garment-canvas] failed to finalize user template ownership mutation", reconcileError);
  });
  if (outcome.status === "source_changed") {
    res.status(404).json({ error: "用户不存在或状态已变化，请刷新后重试" });
    return;
  }
  if (outcome.status === "target_changed") {
    res.status(409).json({ error: "数据接收用户状态已变化，请刷新后重试" });
    return;
  }
  if (outcome.status === "active_limit") {
    res.status(409).json({ error: `数据转移后活动任务将超过 ${ACTIVE_RUN_LIMIT} 条，请等待任务结束后再试` });
    return;
  }
  if (outcome.status === "active_runs") {
    res.status(409).json({ error: "账号仍有生成任务，请等待任务结束后再删除" });
    return;
  }
  if (outcome.status === "draft_conflict") {
    res.status(409).json({
      error: "转出账号和接收账号都存在未保存初始草稿，请先在其中一个账号保存或放弃草稿",
    });
    return;
  }
  res.json({ ok: true, purgeAfter: transferToUserId ? null : purgeAfter });
}));
