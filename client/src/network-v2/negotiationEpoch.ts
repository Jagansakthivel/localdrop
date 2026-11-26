/** Offerer assigns a shared opaque ID; answerer echoes it, never compares local counters. */
export class NegotiationEpoch {
  private active:string|null=null;
  private retired=new Set<string>();
  private readonly limit:number;
  constructor(limit=64){this.limit=limit;}
  begin(id:string){if(!/^[A-Za-z0-9_-]{16,64}$/.test(id)||this.retired.has(id))return false;if(id===this.active)return true;if(this.active){if(this.retired.size>=this.limit)throw new Error('Negotiation epoch budget exceeded; re-pair required');this.retired.add(this.active);}this.active=id;return true;}
  matches(id:unknown){return typeof id==='string'&&id===this.active;}
  get current(){return this.active;}
  isRetired(id:unknown){return typeof id==='string'&&this.retired.has(id);}
}
