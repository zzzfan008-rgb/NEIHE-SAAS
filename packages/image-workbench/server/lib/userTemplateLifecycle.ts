import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { writeJsonAtomicSync } from "./atomicJson";
import { queryOne } from "./database";

interface StoredTemplateMetadata extends Record<string, unknown> {
  id?: unknown;
  ownerId?: unknown;
  deletedAt?: unknown;
  purgeAfter?: unknown;
}

function userTemplatesDir(): string {
  const dir = path.join(config.dataDir(), "templates", "user");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userTemplateFiles(): string[] {
  return fs.readdirSync(userTemplatesDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(userTemplatesDir(), name));
}

function readMetadata(filePath: string): StoredTemplateMetadata {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredTemplateMetadata;
}

interface MutationJournal {
  id: string;
  sourceOwnerId: string;
  transferToOwnerId?: string;
  sourceDeletedAt: string;
  deletedAt?: string;
  purgeAfter?: string;
  changes: Array<{ filePath: string; before: StoredTemplateMetadata; after: StoredTemplateMetadata }>;
}

function mutationDir(): string {
  const dir = path.join(config.dataDir(), "templates", ".account-mutations");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mutationJournalPath(id: string): string {
  return path.join(mutationDir(), `${id}.json`);
}

function writeMutationJournal(journal: MutationJournal): string {
  const filePath = mutationJournalPath(journal.id);
  writeJsonAtomicSync(filePath, journal);
  return filePath;
}

function applyMutationChanges(journal: MutationJournal): void {
  for (const change of journal.changes) writeJsonAtomicSync(change.filePath, change.after);
}

function restoreMutationChanges(journal: MutationJournal): void {
  for (const change of journal.changes) writeJsonAtomicSync(change.filePath, change.before);
}

function mutationCommitted(journal: MutationJournal, source: { active: number; deleted_at: string | null } | undefined): boolean | undefined {
  if (!source) return undefined;
  if (source.deleted_at === journal.sourceDeletedAt) return true;
  if (source.active === 1 && source.deleted_at === null) return false;
  return undefined;
}

/**
 * 文件系统没有 PostgreSQL 的事务语义，因此账号变更先写入可恢复 journal。
 * 启动时以 users 行的已提交状态为事实来源：已删除账号完成文件变更，仍活跃账号
 * 恢复快照。journal 在完成后删除，崩溃后重复执行也是幂等的。
 */
export async function reconcileUserTemplateAccountMutations(): Promise<number> {
  const dir = mutationDir();
  let reconciled = 0;
  for (const fileName of fs.readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    const journalPath = path.join(dir, fileName);
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as MutationJournal;
      if (!journal.id || !journal.sourceOwnerId || !Array.isArray(journal.changes)) throw new Error("invalid template mutation journal");
      const source = await queryOne<{ active: number; deleted_at: string | null }>(
        "SELECT active, deleted_at FROM users WHERE id = $1",
        [journal.sourceOwnerId],
      );
      const committed = mutationCommitted(journal, source);
      if (committed === undefined) continue;
      if (committed) applyMutationChanges(journal);
      else restoreMutationChanges(journal);
      fs.unlinkSync(journalPath);
      reconciled += 1;
    } catch (error) {
      console.error(`[garment-canvas] failed to reconcile user template mutation ${fileName}`, error);
    }
  }
  return reconciled;
}

/**
 * 旧版用户模板没有 ownerId。升级时把它们确定性归属给最早创建的有效管理员
 * （历史单账号部署的原始账号），避免升级后模板突然消失。若没有管理员，则回退
 * 到最早创建的有效用户。只有可解析且 id 与文件名一致的记录会被认领。
 */
export async function migrateLegacyUserTemplateOwners(): Promise<number> {
  const fallbackOwner = await queryOne<{ id: string }>(`
    SELECT id FROM users
    WHERE deleted_at IS NULL
    ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC, id ASC
    LIMIT 1
  `);
  if (!fallbackOwner) return 0;

  let migrated = 0;
  for (const filePath of userTemplateFiles()) {
    try {
      const stored = readMetadata(filePath);
      if (typeof stored.ownerId === "string" && stored.ownerId.length > 0) continue;
      if (typeof stored.id !== "string" || path.basename(filePath, ".json") !== stored.id) continue;
      writeJsonAtomicSync(filePath, { ...stored, ownerId: fallbackOwner.id });
      migrated += 1;
    } catch {
      // 损坏文件继续由模板读取层隔离；不能在迁移中覆盖或删除。
    }
  }
  return migrated;
}

export function purgeExpiredUserTemplates(nowIso = new Date().toISOString()): number {
  let purged = 0;
  for (const filePath of userTemplateFiles()) {
    try {
      const stored = readMetadata(filePath);
      if (typeof stored.purgeAfter === "string" && stored.purgeAfter <= nowIso) {
        fs.unlinkSync(filePath);
        purged += 1;
      }
    } catch {
      // 损坏文件不是可证明已到期的数据，保留供管理员离线修复。
    }
  }
  return purged;
}

export interface UserTemplateAccountMutation {
  readonly changedCount: number;
  apply(): void;
}

/**
 * 账号事务持有 source/target 用户锁后调用。文件修改在数据库提交前完成；若后续
 * SQL 或 COMMIT 失败，调用方用 rollback 恢复逐字节等价的 JSON 内容。
 */
export function prepareUserTemplateAccountMutation(input: {
  sourceOwnerId: string;
  transferToOwnerId?: string;
  sourceDeletedAt: string;
  deletedAt?: string;
  purgeAfter?: string;
}): UserTemplateAccountMutation {
  const changes: Array<{ filePath: string; before: StoredTemplateMetadata; after: StoredTemplateMetadata }> = [];
  for (const filePath of userTemplateFiles()) {
    try {
      const before = readMetadata(filePath);
      if (before.ownerId !== input.sourceOwnerId) continue;
      const after = input.transferToOwnerId
        ? { ...before, ownerId: input.transferToOwnerId }
        : { ...before, deletedAt: input.deletedAt, purgeAfter: input.purgeAfter };
      changes.push({ filePath, before, after });
    } catch {
      // 无法解析的文件没有可验证 owner，不能在账号操作中猜测归属。
    }
  }

  const journal: MutationJournal = {
    id: `account-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    sourceOwnerId: input.sourceOwnerId,
    ...(input.transferToOwnerId ? { transferToOwnerId: input.transferToOwnerId } : {}),
    sourceDeletedAt: input.sourceDeletedAt,
    ...(input.deletedAt ? { deletedAt: input.deletedAt } : {}),
    ...(input.purgeAfter ? { purgeAfter: input.purgeAfter } : {}),
    changes,
  };
  return {
    changedCount: changes.length,
    apply() {
      if (changes.length === 0) return;
      writeMutationJournal(journal);
      applyMutationChanges(journal);
    },
  };
}
