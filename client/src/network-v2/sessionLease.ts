/** Prevent old asynchronous operations from unlocking or updating a replacement session. */
export interface Lease { readonly generation:number; readonly id:string; readonly signal:AbortSignal }
export class SessionLease {
  private generation=0;
  private active=new Map<string,{lease:Lease;controller:AbortController}>();
  get epoch(){return this.generation;}
  begin(key:string,id:string):Lease {
    if(this.active.has(key))throw new Error('Operation already active');
    const controller=new AbortController();const lease={generation:this.generation,id,signal:controller.signal};this.active.set(key,{lease,controller});return lease;
  }
  owns(key:string,lease:Lease){return lease.generation===this.generation&&this.active.get(key)?.lease===lease&&!lease.signal.aborted;}
  release(key:string,lease:Lease){if(this.active.get(key)?.lease===lease)this.active.delete(key);}
  cancel(key:string,lease:Lease,reason:unknown=new Error('Cancelled')){const entry=this.active.get(key);if(entry?.lease!==lease)return false;entry.controller.abort(reason);return true;}
  reset(reason:unknown=new Error('Session replaced')){const previous=[...this.active.values()];this.generation++;this.active.clear();for(const entry of previous)entry.controller.abort(reason);}
}
export function clearTransfer<T extends {transferId?:string}>(previous:T|null,id:string):T|null {return previous?.transferId===id?null:previous;}
