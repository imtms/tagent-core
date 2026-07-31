import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { BlobStorePort } from "../ports.js";
export interface S3BlobStoreOptions { bucket: string; prefix?: string; client?: S3Client; clientConfig?: S3ClientConfig }
export class S3BlobStore implements BlobStorePort {
  private readonly client:S3Client; private readonly prefix:string;
  constructor(private readonly options:S3BlobStoreOptions){this.client=options.client??new S3Client(options.clientConfig??{});this.prefix=(options.prefix??"").replace(/^\/+|\/+$/g,"");}
  private key(key:string){if(key.includes(".."))throw new Error("Unsafe object key");return this.prefix?`${this.prefix}/${key.replace(/^\//,"")}`:key.replace(/^\//,"");}
  async putImmutable(key:string,body:string,metadata:Record<string,string>){if(await this.exists(key))throw new Error(`Immutable object already exists: ${key}`);const checksum=createHash("sha256").update(body).digest("hex");await this.client.send(new PutObjectCommand({Bucket:this.options.bucket,Key:this.key(key),IfNoneMatch:"*",Body:body,ContentType:"text/markdown; charset=utf-8",Metadata:{...metadata,sha256:checksum}}));return{checksum,byteLength:Buffer.byteLength(body)};}
  async get(key:string){const result=await this.client.send(new GetObjectCommand({Bucket:this.options.bucket,Key:this.key(key)}));return result.Body?.transformToString("utf8")??"";} async delete(key:string){await this.client.send(new DeleteObjectCommand({Bucket:this.options.bucket,Key:this.key(key)}));} async exists(key:string){try{await this.client.send(new HeadObjectCommand({Bucket:this.options.bucket,Key:this.key(key)}));return true;}catch(error){const status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode;if(status===404)return false;throw error;}}
}
