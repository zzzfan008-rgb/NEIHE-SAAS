import type { Express } from "express";
import type { Server } from "node:http";

export interface WorkbenchReadiness {
  ok: boolean;
  mode: "api-only";
  checks: { database: boolean; usersConfigured: boolean; dataDirWritable: boolean; aiConfigured: boolean };
}
export interface WorkbenchServer {
  app: Express;
  server: Server;
  stopWorker: () => void;
}
export declare function imageWorkbenchReadiness(): Promise<WorkbenchReadiness>;
export declare function createImageWorkbenchApp(): Express;
export declare function startImageWorkbenchServer(port?: number, host?: string): Promise<WorkbenchServer>;
