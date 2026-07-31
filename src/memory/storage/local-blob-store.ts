import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlobStorePort } from "../ports.js";
export class LocalBlobStore implements BlobStorePort {
  constructor(private readonly root: string) {}
  private resolve(key: string) { const value = path.resolve(this.root, key); const root = path.resolve(this.root) + path.sep; if (!value.startsWith(root)) throw new Error("Object key escapes cold storage root"); return value; }
  async putImmutable(key: string, body: string, _metadata: Record<string,string>) { const file=this.resolve(key); await mkdir(path.dirname(file),{recursive:true}); try { await stat(file); throw new Error(`Immutable object already exists: ${key}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await writeFile(file,body,{encoding:"utf8",flag:"wx",mode:0o600}); return { checksum:createHash("sha256").update(body).digest("hex"), byteLength:Buffer.byteLength(body) }; }
  async get(key:string){return readFile(this.resolve(key),"utf8");} async delete(key:string){await rm(this.resolve(key),{force:true});} async exists(key:string){try{await stat(this.resolve(key));return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}
}
