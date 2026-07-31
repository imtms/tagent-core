import type { EmbeddingPort } from "../ports.js";

export interface OpenAIEmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  batchSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  extraHeaders?: Record<string,string>;
  extraBody?: Record<string,unknown>;
}

/** Production embedding adapter for OpenAI-compatible /embeddings APIs. */
export class OpenAIEmbeddingAdapter implements EmbeddingPort {
  readonly generation: string;
  private readonly baseUrl:string;
  constructor(private readonly options:OpenAIEmbeddingOptions){
    this.baseUrl=options.baseUrl.replace(/\/$/,"");
    this.generation=`openai:${options.model}:${options.dimensions??"native"}`;
  }
  async embed(texts:string[]):Promise<number[][]>{
    if(!texts.length)return[];
    const output:number[][]=[];
    const size=Math.max(1,this.options.batchSize??64);
    for(let offset=0;offset<texts.length;offset+=size){
      const chunk=texts.slice(offset,offset+size);
      const body:Record<string,unknown>={model:this.options.model,input:chunk,...this.options.extraBody};
      if(this.options.dimensions)body.dimensions=this.options.dimensions;
      const response=await this.request(body);
      const data=(response as {data?:Array<{index?:number;embedding?:unknown}>}).data;
      if(!Array.isArray(data)||data.length!==chunk.length)throw new Error("Embedding response count mismatch");
      const ordered=[...data].sort((a,b)=>(a.index??0)-(b.index??0));
      for(const item of ordered){if(!Array.isArray(item.embedding)||!item.embedding.every(Number.isFinite))throw new Error("Embedding response contains an invalid vector");output.push(item.embedding as number[]);}
    }
    return output;
  }
  private async request(body:Record<string,unknown>):Promise<unknown>{
    const retries=Math.max(0,this.options.maxRetries??2);
    let last:unknown;
    for(let attempt=0;attempt<=retries;attempt++){
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.options.timeoutMs??30_000);
      try{
        const response=await fetch(`${this.baseUrl}/embeddings`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${this.options.apiKey}`,...this.options.extraHeaders},body:JSON.stringify(body),signal:controller.signal});
        const text=await response.text();
        if(response.ok)return JSON.parse(text);
        const error=new Error(`Embedding API ${response.status}: ${text.slice(0,500)}`);
        if(response.status!==429&&response.status<500)throw error;
        last=error;
      }catch(error){last=error;if(attempt===retries)throw error;}finally{clearTimeout(timer);}
      await new Promise((resolve)=>setTimeout(resolve,Math.min(4_000,500*2**attempt)));
    }
    throw last;
  }
}
