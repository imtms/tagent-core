import { createHash } from "node:crypto";
import type { EmbeddingPort } from "../ports.js";
export class HashEmbeddingAdapter implements EmbeddingPort {
  readonly generation:string;
  constructor(private readonly dimensions=64,generation="hash-v1"){this.generation=`${generation}:${dimensions}`;}
  async embed(texts:string[]){return texts.map((text)=>{const vector=new Array<number>(this.dimensions).fill(0);for(const token of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)){const digest=createHash("sha256").update(token).digest();const index=digest.readUInt32BE(0)%this.dimensions;vector[index]+=digest[4]%2===0?1:-1;}const norm=Math.sqrt(vector.reduce((sum,v)=>sum+v*v,0))||1;return vector.map((v)=>v/norm);});}
}
